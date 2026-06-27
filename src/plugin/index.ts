import { tool, type Plugin, type PluginModule } from "@opencode-ai/plugin";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { discoverAgent, type DiscoveredAgent } from "./discover.js";
import { loadAnthropicCatalog, buildModels } from "./catalog.js";
import { readCacheKeyed, writeCache } from "./cache.js";
import { getLink } from "./sessions.js";
import { detectClaudeExecutable } from "../provider/factory.js";

const DEBUG = !!process.env.ACP_DEBUG;
const dbg = (m: string) => { if (DEBUG) process.stderr.write(`[acp-plugin] ${m}\n`); };
const DISCOVERY_TTL = 60 * 60 * 1000; // 1h

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function isPlainObject(v: any): v is Record<string, any> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Deep merge where `override` wins (arrays/scalars replace; plain objects recurse). */
function deepMerge(base: any, override: any): any {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out: Record<string, any> = { ...base };
  for (const k of Object.keys(override)) {
    out[k] = k in base ? deepMerge(base[k], override[k]) : override[k];
  }
  return out;
}

/** Resolve the npm spec OpenCode should load the provider factory from. */
function resolveNpmSpec(override?: string): string {
  if (override) return override;
  const here = fileURLToPath(import.meta.url); // <root>/dist/plugin/index.js
  if (here.includes("/node_modules/opencode-claude-code-acpbridge/")) return "opencode-claude-code-acpbridge";
  return `file://${join(dirname(here), "..", "..")}`; // dev / file install → package root
}

/** Strip plugin-only keys; the rest are the provider/agent options passed to the factory. */
function providerOptions(opts: Record<string, any>): Record<string, any> {
  const { name: _n, npm: _npm, providerId: _p, models: _m, ...rest } = opts;
  return rest;
}

/**
 * Permission-bridge meta-tool. The provider emits a `claude_permission` tool-call
 * when the Claude agent asks (via ACP `requestPermission`) to run a NATIVE tool;
 * this surfaces OpenCode's own `ask` prompt with the native tool's details, and
 * the verdict (approved / rejected) is the tool-result the provider maps back to
 * allow/deny. Granularity per native tool comes from the `patterns` below, e.g.
 * `permission: { claude_permission: { "Read*": "allow", "*": "ask" } }`.
 */
const claudePermissionTool = tool({
  description:
    "Permission gate for a native Claude Code tool. Approve to let the agent run that native tool; reject to block it.",
  args: {
    tool: tool.schema.string().optional().describe("native tool requested (e.g. Write, Bash, NotebookEdit, Skill)"),
    kind: tool.schema.string().optional().describe("execute|edit|read|delete|fetch|think|…"),
    title: tool.schema.string().optional().describe("human label of the action"),
    input: tool.schema.any().optional().describe("the native tool input"),
  },
  async execute(args, ctx) {
    // Permission = the NATIVE tool name → the prompt reads "Call tool Skill /
    // NotebookEdit / Bash …" and rules/"Allow always" are PER native tool.
    const native = String(args.tool ?? args.title ?? "native tool").trim() || "native tool";
    // Pattern = the action target (command / skill / path) so GLOB rules match,
    // e.g. `permission: { Bash: { "git *": "allow" }, Skill: { "review*": "allow" }, "*": "ask" }`.
    const inp: any = args.input && typeof args.input === "object" ? args.input : {};
    const rawTarget = String(
      (inp.command ?? inp.skill ?? inp.name ?? inp.notebook_path ?? inp.file_path ?? inp.path) ||
      (typeof args.input === "string" ? args.input : "") || args.title || "",
    ).trim();
    const target = rawTarget || "*";
    // "Allow always" glob: ONLY collapse shell commands (kind=execute) to the first
    // token (`git status` → `git *`); otherwise the exact target. With no real target
    // offer NO always-glob — avoids persisting a broad "*" rule that would auto-approve
    // everything for this native tool.
    const always =
      args.kind === "execute" && rawTarget.includes(" ") ? `${rawTarget.split(/\s+/)[0]} *`
      : rawTarget || undefined;
    // ctx.ask surfaces OpenCode's prompt (default "ask" when no rule matches); throws
    // PermissionRejectedError on reject → the provider denies the native tool.
    await ctx.ask({
      permission: native,
      patterns: [target],
      always: always ? [always] : [],
      metadata: { kind: args.kind, title: args.title, input: args.input },
    });
    return `approved: ${native}`;
  },
});

/**
 * OpenCode plugin half. With the auto-register hook below, a minimal config is enough:
 *
 *   "plugin": [["opencode-claude-code-acpbridge", { "command": "claude-agent-acp" }]]
 *
 * The plugin discovers the agent's models (cached), pulls their metadata from
 * models.dev, and injects `provider.acp` with the populated models — while the
 * user keeps full control of every agent option via these plugin options.
 */
export const ACPPlugin: Plugin = async (_input, options) => {
  const opts = (options ?? {}) as Record<string, any>;
  const providerId = opts.providerId ?? "acp";

  return {
    // Register the permission-bridge meta-tool so OpenCode can execute it and show
    // its `ask` prompt when the Claude agent requests a native tool.
    tool: { claude_permission: claudePermissionTool },

    // Bridge OpenCode's sessionID → providerOptions.acp so the provider can map it
    // to a Claude Code session and resume instead of replaying the whole history.
    "chat.params": async (input: any, output: any) => {
      try {
        if (input?.model?.providerID !== providerId) return;
        const oc = input?.sessionID;
        if (!oc) return;
        output.options = output.options ?? {};
        output.options.ocSession = oc; // registry key — always
        const link = getLink(oc);
        if (link?.acpSessionId) {       // only if registered (resumable)
          output.options.resumeId = link.acpSessionId;
          output.options.resumeLen = link.sentHistoryLen;
          // Seed the model's cumulative usage snapshot so per-turn deltas stay
          // correct after a process restart (ACP usage is cumulative per session).
          if (link.lastUsage) output.options.resumeLastUsage = link.lastUsage;
        }
      } catch { /* ignore */ }
    },

    config: async (cfg: any) => {
      try {
        if (!opts.command && !process.env.ACP_COMMAND) {
          dbg("no `command` in plugin options — skipping auto-register (declare the provider manually)");
          return;
        }
        const command = opts.command ?? process.env.ACP_COMMAND;
        cfg.provider ??= {};
        if (cfg.provider[providerId]) {
          dbg(`provider '${providerId}' already declared in config — leaving it untouched`);
          return;
        }

        // Resolve the native Claude binary the same way the provider factory does,
        // so the ephemeral discovery agent can find it under a minimal config.
        const claudeExecutable = opts.claudeExecutable ?? process.env.CLAUDE_CODE_EXECUTABLE ?? detectClaudeExecutable();
        const discOpts = { ...providerOptions(opts), command, claudeExecutable };
        const key = hash(JSON.stringify({ c: command, a: opts.args, cd: opts.claudeCode?.configDir, ce: claudeExecutable }));
        let discovered = readCacheKeyed<DiscoveredAgent>("discovery.json", DISCOVERY_TTL, key);
        if (discovered) dbg("discovery from cache");
        else {
          discovered = await discoverAgent(discOpts as any);
          writeCache("discovery.json", discovered, key);
        }

        const agentModels = discovered?.models?.length
          ? discovered.models
          : [{ id: "default", name: "Claude Code (ACP)" }];
        const catalog = await loadAnthropicCatalog();
        const models = buildModels(agentModels, discovered?.promptCaps ?? {}, catalog);

        cfg.provider[providerId] = {
          npm: resolveNpmSpec(opts.npm),
          name: opts.name ?? "Claude Code (ACP)",
          options: { ...discOpts },
          models,
        };
        dbg(`auto-registered provider '${providerId}' (npm ${resolveNpmSpec(opts.npm)}) — models: ${Object.keys(models).join(", ")}`);

        // Inject "claude-code" agents (unless disabled or already declared). Default
        // model is the agent's recommended one ("default" = Opus 4.7). Per-agent ACP
        // options (mode/effort) travel to the provider as `providerOptions.acp`.
        if (opts.agents !== false) {
          const defaultModel = opts.agentModel ?? "default";
          const toRef = (m: string) => (m.includes("/") ? m : `${providerId}/${m}`);
          const defs: Record<string, any> = opts.agents ?? {
            "claude-code": {
              description: "Claude Code (subscription) — native capabilities with permissions bridged to OpenCode",
              model: defaultModel,
              // The bridge meta-tool itself is auto-allowed; the REAL prompt is raised
              // inside it via ctx.ask under the NATIVE tool's name (Skill/NotebookEdit/…),
              // so users see and rule on the actual action. Override per tool, e.g.
              // `permission: { Skill: "allow", NotebookEdit: "ask" }`.
              permission: { claude_permission: "allow" },
              options: {
                mode: "default",                 // not bypass → the agent asks → permission bridge
                allowedTools: ["mcp__opencode"], // OpenCode's tools don't double-prompt (it owns them)
                // Common native tools are covered by OpenCode → disable them so the agent
                // doesn't try (and "approve") a native Bash/Write/… it can't actually run;
                // it uses mcp__opencode__* instead. Native gap tools stay (see `nativeTools`).
                disallowedTools: ["Bash", "Write", "Edit", "MultiEdit", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"],
                resourceSearch: true,            // ListMcpResources / ReadMcpResource (superior to OpenCode)
                nativeSubagents: true,           // Task: native subagents that delegate to OpenCode's tools
                nativeTools: ["NotebookEdit", "Read"], // gap OpenCode doesn't cover + native Read (multimodal)
                projectMemory: true,             // CLAUDE.md/AGENTS.md (verified: keeps subscription)
                nativeSkills: true,              // ~/.claude/skills, hooks disabled (verified: keeps subscription)
              },
            },
            "claude-code-plan": {
              description: "Claude Code — plan mode (research & plan, no destructive edits)",
              model: defaultModel, variant: "high",
              options: { mode: "plan", resourceSearch: true },
            },
          };
          cfg.agent ??= {};
          const injected: string[] = [];
          for (const [name, raw] of Object.entries(defs)) {
            const def = raw as any;
            const pluginBase: Record<string, any> = {
              description: def.description,
              model: toRef(def.model ?? defaultModel),
              mode: def.mode ?? "primary",
              ...(def.variant ? { variant: def.variant } : {}),
              ...(def.permission ? { permission: def.permission } : {}),
              options: def.options ?? {},
            };
            // The user's `agent.<name>` in opencode.json wins over the plugin defaults
            // (merge): declare only what you want to change (e.g. `permission`) and
            // inherit the rest; `disable:true` turns the agent off.
            cfg.agent[name] = cfg.agent[name] ? deepMerge(pluginBase, cfg.agent[name]) : pluginBase;
            injected.push(name);
          }
          if (injected.length) dbg(`agents (plugin defaults ⊕ user config): ${injected.join(", ")}`);
        }
      } catch (e: any) {
        // Never break OpenCode boot: log and continue (user can declare provider manually).
        const detail = e instanceof Error ? (e.stack || e.message) : typeof e === "object" ? JSON.stringify(e) : String(e);
        dbg(`auto-register failed: ${detail}`);
      }
    },

    dispose: async () => {},
  };
};

const acpPluginModule: PluginModule = {
  id: "opencode-claude-code-acpbridge",
  server: ACPPlugin,
};

export default acpPluginModule;
