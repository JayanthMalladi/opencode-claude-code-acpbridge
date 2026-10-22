// Helpers to control the Claude Code ecosystem the ACP agent loads, and to give
// the agent an isolated config dir that still has auth (linked credentials) but
// none of the user's skills/agents/plugins/hooks. See `_meta.claudeCode.options`.
import { existsSync, mkdirSync, symlinkSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ClaudePermissionMode =
  | "default" | "acceptEdits" | "plan" | "dontAsk" | "auto" | "bypassPermissions";
export type ClaudeThinking =
  | { type: "adaptive"; display?: "summarized" | "omitted" }
  | { type: "enabled"; budgetTokens?: number; display?: "summarized" | "omitted" }
  | { type: "disabled" };

/**
 * Control over the Claude Code session, mapped 1:1 onto the agent's
 * `_meta.claudeCode.options` (the Claude Agent SDK `Options` type). Any field
 * not listed here can still be passed via `options`.
 */
export interface ClaudeCodeControl {
  /**
   * Config dir for the agent:
   *  - `false` (default): inherit the user's `~/.claude`. Sessions started from
   *    OpenCode land in `~/.claude/projects/…`, so they can be picked back up
   *    natively with `claude --resume <id>`. This does NOT pull in the user's
   *    ecosystem on its own — `settingSources`/`tools`/`strictMcpConfig` still
   *    govern what the agent loads; it only decides where its state lives.
   *  - `"isolated"`: a clean dir under `~/.acp-model-provider` with the user's
   *    `.credentials.json` symlinked in (auth without skills/agents/plugins).
   *    Sessions created there are invisible to `claude --resume`.
   *  - a path string: used as `CLAUDE_CONFIG_DIR` verbatim.
   */
  configDir?: string | "isolated" | false;
  /** Settings inheritance. Default `[]` (note: the ACP agent may force user/project/local). */
  settingSources?: Array<"user" | "project" | "local">;
  /** Built-in tools to expose. Default `[]` (none — OpenCode supplies the tools). */
  tools?: string[];
  disallowedTools?: string[];
  /**
   * Use ONLY the MCP servers passed explicitly (OpenCode's tool host), ignoring
   * every other source — the user's `.claude.json` AND the remote **claude.ai
   * connectors** (Gmail, Google Drive, Supabase, Notion, …) bound to the account.
   * Default `true`: part of the "clean brain" — without it the agent inherits the
   * account's connectors as extra tools. Set `false` to let those connectors through.
   */
  strictMcpConfig?: boolean;
  /** Auto-approved tools (no `requestPermission`). With the permission bridge on
   *  (mode ≠ bypassPermissions) set `["mcp__opencode"]` so OpenCode's own tools
   *  don't double-prompt — only NATIVE tools get bridged to OpenCode's `ask`. */
  allowedTools?: string[];

  // ---- native Claude Code ecosystem (composes tools/settingSources/agents) ----
  /** Native tools OpenCode doesn't cover (gap), e.g. `["NotebookEdit"]`. Added to `tools`. */
  nativeTools?: string[];
  /** MCP resource search (`ListMcpResources`, `ReadMcpResource`) — superior to OpenCode. */
  resourceSearch?: boolean;
  /** Native subagents (`Task`): `true` adds a general subagent that delegates to
   *  OpenCode's tools; a `Record` provides custom AgentDefinitions (merged into `agents`). */
  nativeSubagents?: boolean | Record<string, unknown>;
  /** Claude Code skills: `true` loads `~/.claude/skills` (settingSources "user", higher
   *  billing risk); `string[]` preloads only those (settings.skills, safer). Adds `Skill`. */
  nativeSkills?: boolean | string[];
  /** Project memory: load CLAUDE.md/AGENTS.md of the cwd (settingSources "project"). */
  projectMemory?: boolean;
  /** Let skills run shell via the native Bash tool (default off → they orchestrate
   *  through OpenCode's tools instead). */
  skillShell?: boolean;

  // ---- model & reasoning ----
  /** Model alias or id: `"opus"`/`"sonnet"`/`"haiku"`/`"opus[1m]"` or `"claude-opus-4-7"`, … */
  model?: string;
  /** Fallback model if the primary one fails. */
  fallbackModel?: string;
  /** Cognitive effort level. Default `"high"` (Opus 4.6+). */
  effort?: ClaudeEffort;
  /**
   * Thinking/reasoning config. Default `{type:"enabled", display:"summarized"}`
   * so the reasoning block ALWAYS shows in OpenCode (the agent only emits
   * `agent_thought_chunk`s — which the provider maps to `reasoning-*` parts — when
   * `display` is `"summarized"`; the SDK default `"omitted"` thinks silently, and
   * `"adaptive"` lets the model skip thinking on easy turns). Set `{type:"disabled"}`
   * or `display:"omitted"` to hide it, or `"adaptive"` to only think when needed.
   */
  thinking?: ClaudeThinking;
  /** @deprecated Use `thinking`. Max thinking tokens. */
  maxThinkingTokens?: number;

  // ---- execution limits & mode ----
  /** Max conversation turns before stopping. */
  maxTurns?: number;
  /** Hard USD budget for the turn. */
  maxBudgetUsd?: number;
  /** Permission mode (note: the ACP agent may resolve this from settings). */
  permissionMode?: ClaudePermissionMode;
  /**
   * ACP session mode, applied at runtime via `setSessionMode` (e.g. `"plan"`,
   * `"bypassPermissions"`). Unlike `permissionMode` (which the ACP agent ignores
   * for the session mode), this actually switches the mode. Can be set per-call
   * through `providerOptions.acp.mode` (e.g. a `claude-code-plan` agent).
   */
  mode?: ClaudePermissionMode;

  // ---- system prompt ----
  /**
   * How OpenCode's system prompt is forwarded to the agent (via `_meta.systemPrompt`):
   *  - `"preset"` (default): ignore OpenCode's system; the agent uses only the
   *    `claude_code` preset. This keeps usage on your **subscription** — forwarding
   *    OpenCode's system makes Anthropic classify the session as a third-party app
   *    and bill it as *extra usage*. Tools are still orchestrated via MCP; the agent
   *    just behaves as native Claude Code rather than following OpenCode's instructions.
   *  - `"append"`: keep Claude Code's preset and append OpenCode's system (full
   *    OpenCode fidelity, but billed as **extra usage**).
   *  - `"replace"`: use OpenCode's system as the whole system prompt (also *extra usage*).
   */
  systemPromptMode?: "append" | "replace" | "preset";
  /**
   * Forward the FACTUAL part of OpenCode's system prompt (its `<env>` block —
   * working directory, workspace root, git, platform, date — and
   * `<available_references>`) to the agent as user context. Default `true`.
   *
   * Under `systemPromptMode: "preset"` the system prompt itself never reaches the
   * agent, so without this it works without knowing where it is. Only factual
   * blocks travel — never OpenCode's behavioural instructions — so this keeps the
   * session on the subscription. Sent in full once per session, then as deltas.
   */
  forwardEnvContext?: boolean;
  /**
   * Characters kept of each tool result produced by ANOTHER model when its turns are
   * caught up into this session (default 8000). Larger = the agent knows more of what
   * the other model saw after a model switch; smaller = cheaper catch-up.
   */
  catchupResultChars?: number;
  /**
   * How the provider recognises what the agent already knows of the history.
   *  - `"shadow"` (default): legacy per-message keys decide; the anchor fingerprint
   *    (user messages + tool-call ids) runs alongside and every disagreement is logged
   *    to ~/.acp-model-provider/logs — evidence before switching.
   *  - `"v2"`: anchors decide (immune to OpenCode re-rendering old assistant messages
   *    and to plugins tagging message text).
   *  - `"legacy"`: legacy only. Env override: `ACP_HISTORY_MODE`.
   */
  historyMode?: "legacy" | "shadow" | "v2";
  /**
   * OpenCode tools announced to the agent as read-only (MCP `readOnlyHint`), so Claude
   * Code issues several at once and they reach OpenCode in a single step, run in
   * parallel. Default: read, glob, grep, webfetch, websearch, skill, subagent.
   */
  parallelTools?: string[];
  /** How long (ms) a read-only call waits for parallel siblings. Default 40. */
  toolBatchMs?: number;
  /**
   * Context percentage at which Claude Code compacts its own session
   * (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`). Default 75: below OpenCode's threshold, so the
   * agent manages its context natively and OpenCode's compaction rarely runs. `0`
   * leaves Claude Code's default.
   */
  autoCompactPct?: number;
  /**
   * Native tool activity (Task/Agent, WebSearch, Skill, NotebookEdit…) written into the
   * answer as short text blocks, so it stays in OpenCode's history for any model that
   * continues the session. `"off"` hides it. Default `"text"`.
   */
  nativeActivity?: "text" | "off";
  /** Characters kept of a native Task/WebSearch/Skill result in that block. Default 2000. */
  nativeActivityChars?: number;
  /**
   * On a revert, fork the Claude Code session back to the point before the reverted
   * message (`resumeSessionAt`, located in the session transcript) instead of starting
   * a new session with a replay. Falls back to the replay when no checkpoint/fork is
   * possible. Default true; `false` disables it.
   */
  smartRevert?: boolean;
  /** Live conversations kept open (each is a Claude Code process). Default 6. */
  maxLiveSessions?: number;
  /** Idle ms before a resumable session is closed (resumed on the next message). Default 15 min. */
  idleSessionTtlMs?: number;
  /** Same for OpenCode subagent sessions. Default 2 min. */
  childSessionTtlMs?: number;

  // ---- ecosystem ----
  /** Advanced override passed straight to `_meta.claudeCode.options.systemPrompt`. */
  systemPrompt?: unknown;
  agents?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
  plugins?: unknown[];

  /** Extra passthrough merged into `_meta.claudeCode.options` (any other SDK Options field). */
  options?: Record<string, unknown>;
}

const ISOLATED_BASE = join(homedir(), ".acp-model-provider", "claude-config");

/** Create an isolated config dir with linked credentials (auth, no user ecosystem). */
export function prepareIsolatedConfigDir(dir: string = ISOLATED_BASE): string {
  mkdirSync(dir, { recursive: true });
  const cred = join(homedir(), ".claude", ".credentials.json");
  const linked = join(dir, ".credentials.json");
  if (!existsSync(cred)) return dir;
  // `linked` debe ser un symlink a las credenciales VIVAS. El agente puede refrescar
  // el token OAuth reemplazando el symlink por un fichero regular (pronto obsoleto),
  // lo que desincroniza auth de ~/.claude y causa 401s en la siguiente ejecución.
  // Se asegura de forma atómica: intento directo de crear el symlink y solo ante
  // EEXIST se verifica el destino y se recrea si apunta mal. Sin ventana TOCTOU
  // entre comprobar y recrear donde otro proceso cuele un symlink.
  try {
    symlinkSync(cred, linked);
    return dir;
  } catch (e: any) {
    // Carrera u otro error al crear — si no es EEXIST no se rompe el arranque.
    if (e?.code !== "EEXIST") return dir;
  }
  // Ya existe algo en `linked`: solo se recrea si no es el symlink correcto.
  let linked_ok = false;
  try { linked_ok = lstatSync(linked).isSymbolicLink() && realpathSync(linked) === realpathSync(cred); } catch { linked_ok = false; }
  if (!linked_ok) {
    try { rmSync(linked, { force: true }); } catch { /* ignore */ }
    try { symlinkSync(cred, linked); } catch { /* carrera — ignora */ }
  }
  return dir;
}

/** Resolve the `CLAUDE_CONFIG_DIR` value (undefined ⇒ inherit ~/.claude, the default).
 *  Inheriting is what makes an OpenCode-started conversation resumable with
 *  `claude --resume`, and it also sidesteps the credential-symlink desync that
 *  the isolated dir needs to work around. */
export function resolveConfigDir(ctrl: ClaudeCodeControl): string | undefined {
  if (ctrl.configDir === undefined || ctrl.configDir === false) return undefined;
  if (ctrl.configDir === "isolated") return prepareIsolatedConfigDir();
  return ctrl.configDir;
}

/** General subagent that completes a delegated task using the AVAILABLE tools
 *  (OpenCode's, inherited from the parent) — keeps subagent work orchestrated and
 *  permission-bridged instead of assuming native shell/file access. */
const DEFAULT_SUBAGENT = {
  description:
    "General subagent for quick, self-contained tasks using the available tools. For substantial work prefer " +
    "OpenCode's `subagent` tool, whose result stays in the conversation shared with other models.",
  prompt:
    "You are a focused subagent. Use the tools available to you to complete the delegated task. " +
    "Tool execution is orchestrated by OpenCode and may prompt the user for permission — do not assume " +
    "unrestricted native shell or file access.",
};

/** Build `_meta.claudeCode.options`: "clean brain" by default, plus any reactivated
 *  native features (skills/subagents/resource-search/memory/tools) composed in. A
 *  raw override (ctrl.tools / ctrl.settingSources) still wins; with every toggle off
 *  the result is the unchanged clean brain (`{tools:[], settingSources:[]}`). */
export function buildClaudeCodeOptions(ctrl: ClaudeCodeControl): Record<string, unknown> {
  const toolSet = new Set<string>(ctrl.nativeTools ?? []);
  const sourceSet = new Set<"user" | "project" | "local">();
  let settings: Record<string, unknown> | undefined;
  let agents = ctrl.agents ? { ...ctrl.agents } : undefined;

  if (ctrl.resourceSearch) { toolSet.add("ListMcpResources"); toolSet.add("ReadMcpResource"); }
  if (ctrl.nativeSubagents) {
    toolSet.add("Task");
    agents = ctrl.nativeSubagents === true
      ? { ...(agents ?? {}), general: DEFAULT_SUBAGENT }
      : { ...(agents ?? {}), ...(ctrl.nativeSubagents as Record<string, unknown>) };
  }
  if (ctrl.nativeSkills) {
    toolSet.add("Skill");
    if (ctrl.skillShell) toolSet.add("Bash"); // shell skills need the native Bash tool
    if (Array.isArray(ctrl.nativeSkills)) {
      settings = { ...(settings ?? {}), skills: ctrl.nativeSkills }; // preload only these
    } else {
      // Load ~/.claude/skills (and agents) but DISABLE the user's hooks — keeps the
      // skills' power without letting arbitrary lifecycle hooks "break" anything.
      sourceSet.add("user");
      settings = { ...(settings ?? {}), disableAllHooks: true };
    }
  }
  if (ctrl.projectMemory) sourceSet.add("project");

  const o: Record<string, unknown> = {
    tools: ctrl.tools ?? [...toolSet],
    settingSources: ctrl.settingSources ?? [...sourceSet],
    // Clean brain: ignore the account's claude.ai connectors and any .claude.json
    // MCP servers — only OpenCode's tool host (passed via mcpServers) gets through.
    strictMcpConfig: ctrl.strictMcpConfig ?? true,
  };
  const set = (k: string, v: unknown) => { if (v !== undefined) o[k] = v; };
  // OpenCode runs (and permission-checks) its own tools: auto-allow them on the agent
  // side for EVERY agent, not just ours — a subagent inheriting this model used to
  // double-prompt, or have every tool denied when it lacks `question`.
  set("allowedTools", ctrl.allowedTools ?? ["mcp__opencode"]);
  set("disallowedTools", ctrl.disallowedTools);
  set("model", ctrl.model);
  set("fallbackModel", ctrl.fallbackModel);
  set("effort", ctrl.effort);
  // Default to summarized enabled thinking so the reasoning block always shows in
  // OpenCode (adaptive lets the model skip thinking on easy turns; enabled forces it).
  set("thinking", ctrl.thinking ?? { type: "enabled", display: "summarized" });
  set("maxThinkingTokens", ctrl.maxThinkingTokens);
  set("maxTurns", ctrl.maxTurns);
  set("maxBudgetUsd", ctrl.maxBudgetUsd);
  set("permissionMode", ctrl.permissionMode);
  set("systemPrompt", ctrl.systemPrompt);
  set("agents", agents);
  if (settings) set("settings", settings);
  set("hooks", ctrl.hooks);
  set("mcpServers", ctrl.mcpServers);
  set("plugins", ctrl.plugins);
  return { ...o, ...(ctrl.options ?? {}) };
}
