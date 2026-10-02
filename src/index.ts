// ---------------------------------------------------------------------------
// opencode-claude-code-acpbridge
//
// A single npm package that is BOTH:
//   - an AI SDK provider for OpenCode (registered via `provider.<id>.npm`)
//   - an OpenCode plugin           (registered via `plugin: [...]`)
//
// Its backend is an ACP (Agent Client Protocol) client that spawns an agent
// such as `claude-code-acp` and bridges it to OpenCode through the AI SDK's
// `LanguageModelV3` interface.
// ---------------------------------------------------------------------------

// --- Upstream re-exports (full access to the underlying ACP provider) -------
export {
  createACPProvider,
  ACPProvider,
  acpTools,
  ACP_PROVIDER_AGENT_DYNAMIC_TOOL_NAME,
  ACPLanguageModel,
  providerAgentDynamicToolSchema,
  getExecuteByName,
  hasRegisteredExecute,
} from "@mcpc-tech/acp-ai-provider";

export type {
  ACPProviderSettings,
  ProviderAgentDynamicToolInput,
  NewSessionResponse,
  ModelInfo,
  SessionMode,
  SessionModelState,
  SessionModeState,
} from "@mcpc-tech/acp-ai-provider";

// --- Provider factory -------------------------------------------------------
// OpenCode auto-discovers the provider by picking the export that starts with
// "create" — specifically the **alphabetically first** one (ECMAScript module
// namespace keys are sorted lexicographically). "createACPModelProvider" sorts
// before "createACPProvider" and "createACPProviderFromEnv" ("Model" < "Provider"),
// so it is the one OpenCode loads. Do NOT rename it to something that would sort
// after those, or OpenCode would load the wrong factory.
export {
  createACPModelProvider,
  createACPProviderFromEnv,
  ACPConfigurationError,
} from "./provider/factory.js";

export type {
  ACPModelProviderOptions,
  ACPModelProvider,
  CreateACPProviderFromEnvOptions,
} from "./provider/factory.js";

export { readACPEnv, ACP_ENV_KEYS } from "./provider/env.js";
export type { ACPEnvConfig } from "./provider/env.js";

// --- OpenCode plugin --------------------------------------------------------
// Default export is the V2 plugin definition (`Plugin.define({ id, setup })`);
// OpenCode's loader validates `default` against `{ id, setup | effect }` and
// never looks at the `create*` exports, so both halves coexist in one package.
export { default } from "./plugin/index.js";
export { ACPPlugin } from "./plugin/index.js";
