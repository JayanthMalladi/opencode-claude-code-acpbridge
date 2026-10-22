import { Agent, Model, Plugin, Provider } from "@opencode/plugin";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { discoverAgent, type DiscoveredAgent } from "./discover.js";
import { loadAnthropicCatalog, buildModelsInfo } from "./catalog.js";
import { readCacheKeyed, writeCache } from "./cache.js";
import { getLink, clearLink } from "./sessions.js";
import { publishAgentRules } from "./bridge-rules.js";
import { detectClaudeExecutable } from "../provider/factory.js";

import { logger } from "../log.js";

const dbg = logger("acp-plugin").dbg;
const DISCOVERY_TTL = 60 * 60 * 1000; // 1h

/** Registro del provider en vuelo por providerId: si la config recarga dos veces
 *  en paralelo, la segunda reutiliza la promesa en vez de correr check+add en carrera. */
const providerRegisterInflight = new Map<string, Promise<unknown>>();

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function isPlainObject(v: any): v is Record<string, any> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Clon profundo de valores (arrays / plain objects recursivos; escalares tal cual). */
function cloneValue<T>(v: T): T {
  if (Array.isArray(v)) return v.map(cloneValue) as T;
  if (isPlainObject(v)) {
    const o: Record<string, any> = {};
    for (const k of Object.keys(v)) o[k] = cloneValue((v as any)[k]);
    return o as T;
  }
  return v;
}

/** Deep merge where `override` wins (arrays/scalars replace; plain objects recurse).
 *  Clona la estructura fusionada para no compartir referencias anidadas con `base`. */
function deepMerge(base: any, override: any): any {
  if (!isPlainObject(base) || !isPlainObject(override)) return cloneValue(override);
  const out: Record<string, any> = cloneValue(base);
  for (const k of Object.keys(override)) {
    out[k] = k in base ? deepMerge(base[k], override[k]) : cloneValue(override[k]);
  }
  return out;
}

/** Resolve the module spec OpenCode should load the provider factory from. */
function resolveNpmSpec(override?: string): string {
  if (override) return override;
  const here = fileURLToPath(import.meta.url); // <root>/dist/plugin/index.js
  if (here.includes("/node_modules/opencode-claude-code-acpbridge/")) return "opencode-claude-code-acpbridge";
  // dev / local install → the built entrypoint (importable from both Bun and Node,
  // unlike the package directory which only Bun resolves)
  return `file://${join(dirname(here), "..", "index.js")}`;
}

/** Strip plugin-only keys; the rest are the provider/agent options passed to the factory. */
function providerOptions(opts: Record<string, any>): Record<string, any> {
  const { name: _n, npm: _npm, providerId: _p, models: _m, agents: _a, agentModel: _am, ...rest } = opts;
  return rest;
}

/** Native feature set shared by the Claude Code agents ("clean brain" + the reactivated
 *  native capabilities, all permission-bridged to OpenCode). Two ways to delegate:
 *  Claude Code's own `Task` (`nativeSubagents`; also exposes the user's ~/.claude/agents,
 *  loaded through `settingSources: user`) and OpenCode's `subagent` tool, whose child
 *  sessions stay visible and continuable by ANY model — the preferred one for real work,
 *  since the user switches between this provider and others mid-session (descriptions
 *  steer the agent). IDENTICAL for both agents on purpose: they differ ONLY in the initial
 *  session mode, so a plan session can never end up half-restricted. */
const NATIVE_BASE: Record<string, any> = {
  allowedTools: ["mcp__opencode"], // OpenCode's tools don't double-prompt (it owns them)
  // Common native tools are covered by OpenCode → disable them so the agent doesn't try
  // (and "approve") a native Bash/Write/… it can't actually run; it uses mcp__opencode__* instead.
  // Native Read too: what it reads never reaches OpenCode's history, so after a switch to
  // another model that content is gone. OpenCode V2's `read` handles images/PDF itself.
  disallowedTools: ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "WebFetch", "TodoWrite"],
  resourceSearch: true,    // ListMcpResources / ReadMcpResource (superior to OpenCode)
  nativeSubagents: true,   // Task: native subagents that delegate to OpenCode's tools
  // Gap tools OpenCode doesn't cover, plus the two that make plan mode work at all:
  // ExitPlanMode (without it a plan-mode session has NO way out) and WebSearch.
  nativeTools: ["NotebookEdit", "ExitPlanMode", "WebSearch"],
  projectMemory: true,     // CLAUDE.md/AGENTS.md (verified: keeps subscription)
  nativeSkills: true,      // ~/.claude/skills, hooks disabled (verified: keeps subscription)
};

/** Agent profiles: Claude session mode (the only difference between the two) + Claude
 *  native options. V2's `Agent.Info` has no `options` field, so these travel to the
 *  provider per call through the `context` hook (merged with `options.agents.<name>.options`). */
function agentDefs(opts: Record<string, any>): Record<string, any> {
  if (opts.agents && opts.agents !== true && isPlainObject(opts.agents)) return opts.agents;
  if (opts.agents && opts.agents !== true && !isPlainObject(opts.agents)) {
    dbg("agents config inválida — usando defaults");
  }
  return {
    "claude-code": {
      name: "Claude Code",
      description: "Claude Code (subscription) — native capabilities with permissions bridged to OpenCode",
      model: opts.agentModel ?? "default",
      options: { mode: "default", ...NATIVE_BASE },
    },
    "claude-code-plan": {
      name: "Claude Code (plan)",
      description: "Claude Code — plan mode (research & plan, no destructive edits)",
      model: opts.agentModel ?? "default",
      variant: "high",
      options: { mode: "plan", ...NATIVE_BASE },
    },
  };
}

/** `Model.Ref` for an agent: `"default"` → `<provider>/default`, a full ref passes through. */
function modelRef(value: any, providerID: string, variant?: string) {
  const ref =
    typeof value === "string"
      ? Model.Ref.parse(value.includes("/") || value.includes("#") ? value : `${providerID}/${value}`)
      : value;
  return { ...ref, ...(variant && !ref.variant ? { variant: Model.VariantID.make(variant) } : {}) };
}

/**
 * OpenCode plugin half. Minimal config is enough:
 *
 *   "plugins": [{ "package": "opencode-claude-code-acpbridge",
 *                 "options": { "command": "claude-agent-acp" } }]
 *
 * It discovers the agent's models (cached), pulls their metadata from models.dev,
 * registers the `acp` provider with the populated `Model.Info[]`, injects the
 * `claude-code` / `claude-code-plan` agents, and bridges every per-request value
 * (session link, agent options) through the `context` hook.
 */
/** ¿Está la tool `question` en el set de tools del agente? Soporta array / Set /
 *  Record (según cómo OpenCode lo haya convertido); sin info se asume que sí
 *  para conservar el comportamiento actual. */
function hasQuestionTool(item: any): boolean {
  const t = (item as any)?.tools;
  if (t == null) return true;
  if (Array.isArray(t)) return (t as any[]).includes("question");
  if (t instanceof Set) return (t as Set<unknown>).has("question");
  if (typeof t === "object") {
    if ("question" in t) return !!(t as any).question;
    return true;
  }
  return true;
}

/** A session title from the first user message: first meaningful line, quotes and
 *  markup stripped, cut on a word boundary. */
export function titleFrom(messages: readonly any[]): string | undefined {
  const first = messages.find((m) => m?.role === "user");
  if (!first) return undefined;
  const parts = typeof first.content === "string" ? [first.content] : (first.content ?? []).filter((p: any) => p?.type === "text").map((p: any) => p.text);
  const line = String(parts.join("\n"))
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ")
    .split("\n")
    .map((l) => l.replace(/^["'`\s#>*-]+|["'`\s]+$/g, "").trim())
    .find((l) => l.length > 2);
  if (!line) return undefined;
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60)}…`;
}

export const ACPPlugin = Plugin.define({
  id: "opencode-claude-code-acpbridge",
  async setup(ctx) {
    const opts = (ctx.options ?? {}) as Record<string, any>;
    const providerId: string = opts.providerId ?? "acp";
    const agentOptions = new Map<string, Record<string, any>>();

    if (!opts.command && !process.env.ACP_COMMAND) {
      dbg("no `command` in plugin options — skipping auto-register (declare the provider manually)");
    } else {
      try {
        const command = opts.command ?? process.env.ACP_COMMAND;
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

        const agentModels = discovered?.models?.length ? discovered.models : [{ id: "default", name: "Claude Code (ACP)" }];
        const catalog = await loadAnthropicCatalog();
        const models = buildModelsInfo(agentModels, discovered?.promptCaps ?? {}, catalog, providerId);
        const npmSpec = resolveNpmSpec(opts.npm);

        // The provider no longer comes from `provider.<id>` in config (V2 resolves
        // packages through `aisdk:<spec>`): the plugin registers it directly.
        // Guard contra reloads paralelos: el check `get` + `add` no es atómico,
        // así que se memoiza la promesa en vuelo por providerId y se reutiliza.
        let registering = providerRegisterInflight.get(providerId);
        if (!registering) {
          const fresh = ctx.provider.transform((editor) => {
            if (editor.get(providerId)) {
              dbg(`provider '${providerId}' already declared — keeping the existing definition`);
              return;
            }
            editor.add({
              info: {
                ...Provider.Info.empty(Provider.ID.make(providerId)),
                name: opts.name ?? "Claude Code (ACP)",
                activation: "enabled",
                package: `aisdk:${npmSpec}`,
                settings: { ...discOpts },
              },
              models,
            });
          });
          providerRegisterInflight.set(providerId, fresh);
          // Solo se memoiza mientras está en vuelo: al asentarse se libera para
          // que la próxima recarga (secuencial) use su propio `ctx`.
          const done = () => {
            if (providerRegisterInflight.get(providerId) === fresh) providerRegisterInflight.delete(providerId);
          };
          fresh.then(done, done);
          registering = fresh;
        }
        await registering;
        dbg(`auto-registered provider '${providerId}' (aisdk:${npmSpec}) — models: ${models.map((m) => m.id).join(", ")}`);

        if (opts.agents !== false) {
          const defs = agentDefs(opts);
          await ctx.agent.transform((editor) => {
            for (const [name, raw] of Object.entries(defs)) {
              const def = raw as any;
              const user = isPlainObject(opts.agents) ? opts.agents[name] : undefined;
              // V1-style per-agent Claude options, overridden by the user's copy.
              agentOptions.set(name, deepMerge(def.options ?? {}, isPlainObject(user) ? user.options ?? {} : {}));
              // A `model` the user already declared (config/other plugin) wins: only
              // fill the field when it is missing, so the transform stays idempotent.
              const model = modelRef(
                (isPlainObject(user) && user.model) || def.model || "default",
                providerId,
                def.variant,
              );
              const description = (isPlainObject(user) && user.description) || def.description;
              const questionRule = { action: "question", resource: "*", effect: "allow" } as const;
              editor.update(name, (item) => {
                if (def.name) item.name = Agent.Name.make(def.name);
                if (description && !item.description) item.description = description;
                if (!item.model) item.model = model;
                // Solo tiene sentido permitir `question` si la tool existe en el agente.
                if (
                  hasQuestionTool(item) &&
                  !item.permissions.some((r) => r.action === "question" && r.resource === "*")
                ) {
                  item.permissions.push(questionRule);
                }
                // Context-pruning plugins (opencode-dcp) rewrite OpenCode's copy of the
                // history: `compress` swaps ranges for summaries and the plugin tags every
                // message. The Claude Code session keeps its own context, so that saves
                // nothing — it only makes the history diverge and forces a cold replay.
                // Denying the action removes the tool and, in DCP, the tagging with it.
                if (!item.permissions.some((r) => r.action === "compress")) {
                  item.permissions.push({ action: "compress", resource: "*", effect: "deny" });
                }
                // Publish the rules the permission bridge evaluates against (the
                // user's `permissions` included). `action:"*"` defaults are ignored
                // at evaluation time — see bridge-rules.ts.
                publishAgentRules(name, item.permissions);
              });
            }
            // Any agent can run on this provider (a subagent inherits its parent's
            // model), so the bridge needs every agent's rules — not just ours.
            for (const item of editor.list()) {
              if (!(String(item.id) in defs)) publishAgentRules(String(item.id), item.permissions);
            }
          });
          dbg(`agents registered: ${Object.keys(defs).join(", ")}`);
        }
      } catch (e) {
        // Never break OpenCode boot: log and continue (the user can still declare
        // the provider manually, and the hooks below stay registered).
        dbg(`auto-register failed: ${e instanceof Error ? e.stack || e.message : String(e)}`);
      }
    }

    // Session link + agent options → the provider. V2 passes NO provider options
    // from config, so everything the model needs per call is injected here
    // (`SessionRequestOptions`: generation keys stay typed, the rest becomes
    // `providerOptions.<providerID>`).
    // The same per-call options go with the auxiliary calls too: without them a
    // compaction request reached the provider anonymous and was served by a cold,
    // throwaway session replaying the whole history.
    const inject = (kind: "primary" | "compaction" | "generate") => (event: any) => {
        if (event.model.providerID !== providerId) return;
        event.options.ocSession = event.sessionID;
        event.options.ocAgent = String(event.agent);
        event.options.requestKind = kind;
        // Whether the agent can ask the user: the permission bridge needs `question`.
        event.options.hasQuestion = !!event.tools && "question" in event.tools;
        const link = getLink(event.sessionID);
        if (link?.acpSessionId) {
          event.options.resumeId = link.acpSessionId;
          event.options.resumeLen = link.sentHistoryLen;
          // Seed the cumulative usage snapshot so per-turn deltas stay correct
          // after a restart (ACP usage is cumulative per session).
          if (link.lastUsage) event.options.resumeLastUsage = link.lastUsage;
          if (link.convKey) event.options.resumeConvKey = link.convKey;
          if (link.idPrefixes?.length) event.options.resumeIdPrefixes = link.idPrefixes;
        }
        const extra = agentOptions.get(String(event.agent));
        if (extra) for (const [k, v] of Object.entries(extra)) event.options[k] = v;
      };
    const context = await ctx.session.hook("context", inject("primary"), { providerID: providerId });
    const compaction = await ctx.session.hook("compaction", inject("compaction"), { providerID: providerId });
    const generate = await ctx.session.hook("generate", inject("generate"), { providerID: providerId });
    // Titles: OpenCode's title instructions live in the system prompt, which `preset`
    // never forwards — Claude received the bare first message, answered it, and the
    // session got titled with a fragment of that answer (`<invoke name="Read">`). A
    // title derived from the first message costs nothing and is never wrong that way.
    const title = await ctx.session.hook(
      "title",
      (event) => {
        if (event.model.providerID !== providerId || opts.titleFromModel) return;
        const t = titleFrom(event.messages);
        if (t) event.result = t;
      },
      { providerID: providerId },
    );

    // Rewinding a conversation truncates OpenCode's history, but the Claude Code
    // session on the other side still remembers every undone turn. Drop the
    // registry link so the next turn starts a clean agent session instead of
    // resuming one that would resurrect it. The provider ALSO detects this from
    // the prompt itself (history fingerprint), so programmatic use without the
    // plugin stays correct.
    const closed = new AbortController();
    const events = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: closed.signal })) {
          if (event.type !== "session.revert.committed" && event.type !== "session.revert.cleared") continue;
          const sessionID = (event as { data?: { sessionID?: string } }).data?.sessionID;
          if (sessionID && clearLink(sessionID)) {
            dbg(`session ${sessionID} rewound — link dropped, next turn starts fresh`);
          }
        }
      } catch {
        /* aborted on cleanup */
      }
    })();

    return async () => {
      closed.abort();
      await context.dispose();
      await compaction.dispose();
      await generate.dispose();
      await title.dispose();
      await events;
    };
  },
});

export default ACPPlugin;
