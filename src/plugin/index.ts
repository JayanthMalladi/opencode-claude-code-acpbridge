import type { Plugin, PluginModule } from "@opencode-ai/plugin";
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
              description: "Claude Code (subscription) — orchestrates OpenCode's tools",
              model: defaultModel, options: { mode: "bypassPermissions" },
            },
            "claude-code-plan": {
              description: "Claude Code — plan mode (research & plan, no destructive edits)",
              model: defaultModel, variant: "high", options: { mode: "plan" },
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
