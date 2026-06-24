import type { ACPProviderSettings } from "@mcpc-tech/acp-ai-provider";

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
export function readACPEnv(overrides?: Partial<ACPEnvConfig>): ACPEnvConfig {
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
// Parsers — env vars are strings; these turn them into the typed shapes the
// upstream `ACPProviderSettings` expects.
// ---------------------------------------------------------------------------

export function parseArgs(raw: string | undefined): string[] {
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

export function parseMcpServers(
  raw: string | undefined,
): ACPProviderSettings["session"]["mcpServers"] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // ignore invalid JSON
  }
  return [];
}

export function parseEnv(raw: string | undefined): Record<string, string> | undefined {
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
