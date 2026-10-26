// Model ↔ agent pairing: the provider's models belong to the Claude Code agents
// (one per session mode) and only to them, in both directions. OpenCode V2 has no
// per-agent model list — its model picker offers every model to every agent — so
// the pairing is enforced after the fact: the plugin re-points a session's model
// when its agent/model selection breaks the pair, the provider refuses a request
// from any other agent, and OpenCode subagents get a non-acp model instead of
// inheriting their parent's.

export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export interface PairingState {
  /** The provider's id (`acp`). */
  providerID: string;
  /** Agent id → its configured model (every agent, ours included). */
  agentModels: ReadonlyMap<string, ModelRef | undefined>;
  /** Ids of the Claude Code agents (the only ones allowed on the provider): the
   *  injected ones plus any agent configured with one of the provider's models. */
  acpAgents: ReadonlySet<string>;
}

/** Claude Code session modes as claude-agent-acp ≥ 0.31 reports them; used when
 *  discovery returned none. */
export const FALLBACK_MODES: ReadonlyArray<{ id: string; name: string }> = [
  { id: "default", name: "Default" },
  { id: "plan", name: "Plan Mode" },
  { id: "acceptEdits", name: "Accept Edits" },
  { id: "auto", name: "Auto" },
  { id: "dontAsk", name: "Don't Ask" },
  { id: "bypassPermissions", name: "Bypass Permissions" },
];

/** What each mode changes. It governs Claude's NATIVE tools only (Task, Skill,
 *  WebSearch, NotebookEdit…): OpenCode's own tools keep the agent's OpenCode rules. */
const MODE_HINTS: Record<string, string> = {
  default: "asks before native actions",
  plan: "research & plan, no edits until the plan is approved",
  acceptEdits: "accepts native edits without asking",
  auto: "a classifier approves or denies native actions",
  dontAsk: "denies native actions that are not pre-approved",
  bypassPermissions: "never asks for native actions",
};

/** `claude-<mode>` in lower case: `bypassPermissions` → `claude-bypasspermissions`. */
export function modeAgentId(mode: string): string {
  return `claude-${mode.toLowerCase()}`;
}

/** One agent definition per session mode, `default` first (OpenCode cycles agents in
 *  this order). The plan agent keeps the `high` effort it always had. */
export function modeAgentDefs(
  modes: ReadonlyArray<{ id: string; name?: string }>,
  model: string,
  base: Record<string, any>,
): Record<string, any> {
  const list = modes.length ? [...modes] : [...FALLBACK_MODES];
  list.sort((a, b) => (a.id === "default" ? -1 : b.id === "default" ? 1 : 0));
  const defs: Record<string, any> = {};
  for (const mode of list) {
    const hint = MODE_HINTS[mode.id];
    defs[modeAgentId(mode.id)] = {
      name: `Claude Code (${mode.name ?? mode.id})`,
      description: `Claude Code (subscription) — ${mode.name ?? mode.id} mode${hint ? `: ${hint}` : ""}`,
      model,
      ...(mode.id === "plan" ? { variant: "high" } : {}),
      options: { mode: mode.id, ...base },
    };
  }
  return defs;
}

export function isProviderModel(model: ModelRef | undefined, providerID: string): boolean {
  return model?.providerID === providerID;
}

/** `provider/model[#variant]`, the form the subagent tool's `model` input takes. */
export function refString(model: ModelRef): string {
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}

/**
 * The model a session must switch to so its agent and model pair up, or `undefined`
 * when they already do (or nothing better is known).
 * - A Claude Code agent on another provider's model → the agent's own model.
 * - Any other agent on the provider's model → its configured model when that one is
 *   not ours, else `fallback` (the last non-acp model of the session, or the default).
 */
export function pairTarget(
  state: PairingState,
  session: { agent?: string; model?: ModelRef },
  fallback: ModelRef | undefined,
): ModelRef | undefined {
  const { agent, model } = session;
  if (!agent || !model) return undefined;
  const ours = isProviderModel(model, state.providerID);
  if (state.acpAgents.has(agent)) {
    if (ours) return undefined;
    const own = state.agentModels.get(agent);
    return isProviderModel(own, state.providerID) ? own : { providerID: state.providerID, id: "default" };
  }
  if (!ours) return undefined;
  const own = state.agentModels.get(agent);
  if (own && !isProviderModel(own, state.providerID)) return own;
  return fallback && !isProviderModel(fallback, state.providerID) ? fallback : undefined;
}

/**
 * Decision for an OpenCode `subagent` call before it runs. OpenCode resolves the
 * child's model as `input.model ?? agent.model ?? parent.model`, so a subagent
 * launched from a Claude Code session inherits the provider's model unless told
 * otherwise.
 * - `reject`: an explicit model of the provider for a non-Claude-Code agent.
 * - `inject`: a model to pass as `input.model` (the child would end on ours).
 * - `missing`: the child would end on ours and there is no other model to give it.
 * - `undefined`: nothing to do.
 */
export function subagentDecision(
  state: PairingState,
  input: { agent?: unknown; model?: unknown; sessionID?: unknown },
  parentModel: ModelRef | undefined,
  fallback: ModelRef | undefined,
): { kind: "reject"; model: string } | { kind: "inject"; model: string } | { kind: "missing" } | undefined {
  const target = typeof input.agent === "string" ? input.agent : "";
  if (!target || state.acpAgents.has(target)) return undefined;
  const explicit = typeof input.model === "string" && input.model !== "" ? input.model : undefined;
  if (explicit) return explicit.startsWith(`${state.providerID}/`) ? { kind: "reject", model: explicit } : undefined;
  // A continued child already went through the session watcher when it was created.
  if (typeof input.sessionID === "string" && input.sessionID !== "") return undefined;
  const own = state.agentModels.get(target);
  const inherited = own ?? parentModel;
  if (!isProviderModel(inherited, state.providerID)) return undefined;
  if (!fallback || isProviderModel(fallback, state.providerID)) return { kind: "missing" };
  return { kind: "inject", model: refString(fallback) };
}
