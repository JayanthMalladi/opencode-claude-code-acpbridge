import {
  createACPProvider,
  ACPProvider,
  type ACPProviderSettings,
} from "@mcpc-tech/acp-ai-provider";

// ---------------------------------------------------------------------------
// Re-export everything from the upstream package so consumers get full access
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Environment variable helpers
// ---------------------------------------------------------------------------

/** Known env vars consumed by this provider. */
export interface ACPEnvConfig {
  /** Command to execute the ACP agent (e.g. "gemini", "claude-code-acp", "codex-acp"). */
  command?: string;
  /** Arguments passed to the command (JSON array or space-separated string). */
  args?: string;
  /** Working directory for the agent (default: `process.cwd()`). */
  cwd?: string;
  /** MCP server configurations (JSON array). */
  mcpServers?: string;
  /** Delay in ms before initialising the connection. Useful for agents that load MCP servers async. */
  sessionDelayMs?: string;
  /** Authentication method ID used by lazy auth. */
  authMethodId?: string;
  /** Keep the ACP session alive across calls (`true` / `false`). */
  persistSession?: string;
  /** Resume an existing session by ID. */
  existingSessionId?: string;
  /** Extra environment variables for the agent process (JSON record). */
  env?: string;
}

/** Default env-var keys used by `readACPEnv()`. */
export const ACP_ENV_KEYS = {
  command: "ACP_COMMAND",
  args: "ACP_ARGS",
  cwd: "ACP_CWD",
  mcpServers: "ACP_MCP_SERVERS",
  sessionDelayMs: "ACP_SESSION_DELAY_MS",
  authMethodId: "AUTH_METHOD_ID",
  persistSession: "ACP_PERSIST_SESSION",
  existingSessionId: "ACP_EXISTING_SESSION_ID",
  env: "ACP_ENV",
} as const satisfies Record<keyof ACPEnvConfig, string>;

/**
 * Read ACP configuration from environment variables.
 *
 * Overrides can be passed explicitly — they take precedence over env vars.
 */
export function readACPEnv(
  overrides?: Partial<ACPEnvConfig>,
): ACPEnvConfig {
  const read = (key: string): string | undefined =>
    overrides?.[key as keyof ACPEnvConfig] ?? process.env[key];

  return {
    command: read(ACP_ENV_KEYS.command),
    args: read(ACP_ENV_KEYS.args),
    cwd: read(ACP_ENV_KEYS.cwd),
    mcpServers: read(ACP_ENV_KEYS.mcpServers),
    sessionDelayMs: read(ACP_ENV_KEYS.sessionDelayMs),
    authMethodId: read(ACP_ENV_KEYS.authMethodId),
    persistSession: read(ACP_ENV_KEYS.persistSession),
    existingSessionId: read(ACP_ENV_KEYS.existingSessionId),
    env: read(ACP_ENV_KEYS.env),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Error thrown when required ACP configuration is missing.
 */
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

function parseArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through — treat as space-separated
  }
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseMcpServers(raw: string | undefined): ACPProviderSettings["session"]["mcpServers"] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // ignore invalid JSON
  }
  return [];
}

function parseEnv(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // ignore invalid JSON
  }
  return undefined;
}

/** Options accepted by {@link createACPProviderFromEnv}. */
export interface CreateACPProviderFromEnvOptions {
  /**
   * Override individual env vars.  Any value provided here wins over the
   * corresponding environment variable.
   */
  overrides?: Partial<ACPEnvConfig>;

  /**
   * Extra MCP servers to **append** to those read from the environment.
   */
  extraMcpServers?: ACPProviderSettings["session"]["mcpServers"];
}

/**
 * Create an ACP provider configured from environment variables.
 *
 * Required env var:
 *   `ACP_COMMAND` — the agent command to spawn (e.g. `gemini`, `claude-code-acp`)
 *
 * **Optional env vars:**
 *   | Variable                  | Description                                        | Default            |
 *   |---------------------------|----------------------------------------------------|--------------------|
 *   | `ACP_ARGS`                | JSON array or space-separated string of arguments  | —                  |
 *   | `ACP_CWD`                 | Working directory for the agent                    | `process.cwd()`    |
 *   | `ACP_MCP_SERVERS`         | JSON array of MCP server configurations            | `[]`               |
 *   | `ACP_SESSION_DELAY_MS`    | Delay before initialising the connection (ms)      | —                  |
 *   | `AUTH_METHOD_ID`          | Authentication method identifier                   | —                  |
 *   | `ACP_PERSIST_SESSION`     | Keep session alive (`"true"` / `"false"`)          | `"false"`          |
 *   | `ACP_EXISTING_SESSION_ID` | Resume an existing session by ID                   | —                  |
 *   | `ACP_ENV`                 | Extra env vars for the agent process (JSON record) | —                  |
 *
 * @example
 * ```ts
 * // Terminal:
 * //   export ACP_COMMAND=gemini
 * //   export ACP_ARGS='["--experimental-acp"]'
 * //   export ACP_PERSIST_SESSION=true
 *
 * import { createACPProviderFromEnv } from "acp-model-provider";
 * import { generateText } from "ai";
 *
 * const provider = createACPProviderFromEnv();
 *
 * const result = await generateText({
 *   model: provider.languageModel(),
 *   prompt: "Hello!",
 * });
 *
 * provider.cleanup();  // clean up if persistSession was used
 * ```
 */
export function createACPProviderFromEnv(
  options: CreateACPProviderFromEnvOptions = {},
): ACPProvider {
  const env = readACPEnv(options.overrides);

  // ---- validate required ---------------------------------------------------
  const missing: string[] = [];
  if (!env.command) missing.push(`ACP_COMMAND`);

  if (missing.length > 0) {
    throw new ACPConfigurationError(missing);
  }

  // ---- build settings ------------------------------------------------------
  const args = parseArgs(env.args);

  const mcpServers = [
    ...parseMcpServers(env.mcpServers),
    ...(options.extraMcpServers ?? []),
  ];

  const settings: ACPProviderSettings = {
    command: env.command!,
    args: args.length > 0 ? args : undefined,
    sessionDelayMs: env.sessionDelayMs
      ? Number(env.sessionDelayMs)
      : undefined,
    authMethodId: env.authMethodId || undefined,
    persistSession: env.persistSession === "true",
    existingSessionId: env.existingSessionId || undefined,
    env: parseEnv(env.env),
    session: {
      cwd: env.cwd || process.cwd(),
      mcpServers,
    },
  };

  return createACPProvider(settings);
}
