import { execSync } from "node:child_process";
import {
  createACPProvider,
  type ACPProvider,
  type ACPProviderSettings,
} from "@mcpc-tech/acp-ai-provider";
import type { LanguageModelV3 } from "@ai-sdk/provider";

import {
  readACPEnv,
  parseArgs,
  parseMcpServers,
  parseEnv,
  type ACPEnvConfig,
} from "./env.js";
import { ACPModelView, ACPOrchestratorModel, type ACPModelConfig } from "./model.js";
import type { ClaudeCodeControl } from "../acp/claude-config.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error thrown when required ACP configuration is missing. */
export class ACPConfigurationError extends Error {
  constructor(missing: string[]) {
    super(
      `ACP model provider is missing required configuration:\n` +
        missing.map((k) => `  - ${k}`).join("\n") +
        `\n\nSet the corresponding environment variable or pass the value explicitly.`,
    );
    this.name = "ACPConfigurationError";
  }
}

// ---------------------------------------------------------------------------
// Env-based factory (upstream provider — chat without tool orchestration)
// ---------------------------------------------------------------------------

/** Options accepted by {@link createACPProviderFromEnv}. */
export interface CreateACPProviderFromEnvOptions {
  overrides?: Partial<ACPEnvConfig>;
  extraMcpServers?: ACPProviderSettings["session"]["mcpServers"];
}

/**
 * Create the upstream ACP provider configured from environment variables.
 * This is the Phase-1 path (chat/streaming) without OpenCode tool orchestration.
 */
export function createACPProviderFromEnv(
  options: CreateACPProviderFromEnvOptions = {},
): ACPProvider {
  const env = readACPEnv(options.overrides);
  if (!env.command) throw new ACPConfigurationError(["ACP_COMMAND"]);

  const args = parseArgs(env.args);
  const mcpServers = [...parseMcpServers(env.mcpServers), ...(options.extraMcpServers ?? [])];

  const settings: ACPProviderSettings = {
    command: env.command,
    args: args.length > 0 ? args : undefined,
    sessionDelayMs: env.sessionDelayMs ? Number(env.sessionDelayMs) : undefined,
    authMethodId: env.authMethodId || undefined,
    persistSession: env.persistSession !== "false",
    existingSessionId: env.existingSessionId || undefined,
    env: parseEnv(env.env),
    session: { cwd: env.cwd || process.cwd(), mcpServers },
  };
  return createACPProvider(settings);
}

// ---------------------------------------------------------------------------
// OpenCode-compatible provider factory (orchestrator — Phase 2)
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link createACPModelProvider}. OpenCode discovers this
 * function and calls it with `{ name, ...options }` from the provider config.
 * Resolved first from `options`, then from the corresponding environment var.
 */
export interface ACPModelProviderOptions {
  /** Provider name (set by OpenCode from config). */
  name?: string;
  /** ACP agent command — e.g. `"claude-agent-acp"`, `"claude-code-acp"`. */
  command?: string;
  /** Arguments array. */
  args?: string[];
  /** Working directory for the ACP agent. */
  cwd?: string;
  /** Extra environment variables for the agent process. */
  env?: Record<string, string>;

  /** Claude Code ecosystem control (native tools off, isolated config, skills/hooks/agents…). */
  claudeCode?: ClaudeCodeControl;
  /** Path to the native Claude binary (CLAUDE_CODE_EXECUTABLE). Auto-detected if omitted. */
  claudeExecutable?: string;
  /** CLAUDE_CODE_STREAM_CLOSE_TIMEOUT in ms — lets deferred tools/call exceed 60s. Default 600000. */
  streamCloseTimeoutMs?: number;
}

/** Provider shape OpenCode expects (BundledSDK: `languageModel(modelId)` → `LanguageModelV3`). */
export interface ACPModelProvider {
  readonly specificationVersion: "v3";
  readonly provider: string;
  languageModel(modelId?: string): LanguageModelV3;
  chat(modelId?: string): LanguageModelV3;
  embeddingModel(): never;
  imageModel(): never;
}

export function detectClaudeExecutable(): string | undefined {
  try {
    const p = execSync("command -v claude", { encoding: "utf8" }).trim();
    return p || undefined;
  } catch {
    return undefined;
  }
}

function resolveOrchestratorConfig(opts: ACPModelProviderOptions): Omit<ACPModelConfig, "modelId"> {
  const command = opts.command ?? process.env.ACP_COMMAND;
  if (!command) throw new ACPConfigurationError(["ACP_COMMAND (or options.command)"]);

  const args =
    opts.args ??
    (process.env.ACP_ARGS ? parseArgs(process.env.ACP_ARGS) : undefined);

  const streamCloseTimeoutMs =
    opts.streamCloseTimeoutMs ??
    (process.env.ACP_STREAM_CLOSE_TIMEOUT_MS ? Number(process.env.ACP_STREAM_CLOSE_TIMEOUT_MS) : undefined) ??
    600_000;

  const claudeExecutable =
    opts.claudeExecutable ?? process.env.CLAUDE_CODE_EXECUTABLE ?? detectClaudeExecutable();

  return {
    command,
    args: args && args.length > 0 ? args : undefined,
    cwd: opts.cwd ?? process.env.ACP_CWD ?? process.cwd(),
    env: opts.env,
    claudeCode: opts.claudeCode ?? {},
    claudeExecutable,
    streamCloseTimeoutMs,
  };
}

/**
 * Create an ACP model provider for **OpenCode** ("OpenCode orquesta" — the agent
 * reasons, OpenCode executes the tools). OpenCode auto-discovers this function.
 *
 * @example
 * ```jsonc
 * // .opencode/opencode.json
 * {
 *   "provider": { "acp": {
 *     "npm": "opencode-claude-code-acpbridge",
 *     "options": { "command": "claude-agent-acp" },
 *     "models": { "claude-code": { "id": "claude-code", "tool_call": true, "reasoning": true } }
 *   }},
 *   "plugin": ["opencode-claude-code-acpbridge"]
 * }
 * ```
 */
export function createACPModelProvider(
  options: ACPModelProviderOptions = {},
): ACPModelProvider {
  const base = resolveOrchestratorConfig(options);
  const providerName = options.name ?? "acp-model";
  // ONE orchestrator — one agent process, one session map — for every model of the
  // provider; each model is a view that applies its model per session (set_model).
  const core = new ACPOrchestratorModel({ ...base, modelId: "claude-code" });
  const models = new Map<string, LanguageModelV3>();

  const get = (modelId?: string): LanguageModelV3 => {
    const id = modelId ?? "claude-code";
    let m = models.get(id);
    if (!m) {
      m = id === "claude-code" ? core : new ACPModelView(core, id);
      models.set(id, m);
    }
    return m;
  };

  return {
    specificationVersion: "v3" as const,
    provider: providerName,
    languageModel: (modelId?: string) => get(modelId),
    chat: (modelId?: string) => get(modelId),
    embeddingModel(): never {
      throw new Error(`ACP model provider "${providerName}" does not support embedding models.`);
    },
    imageModel(): never {
      throw new Error(`ACP model provider "${providerName}" does not support image models.`);
    },
  };
}
