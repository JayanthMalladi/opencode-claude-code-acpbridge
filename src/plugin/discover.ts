// Ephemeral ACP agent connection used at plugin init to discover what models,
// modes and prompt capabilities the agent exposes (initialize + session/new),
// so the plugin can auto-populate the OpenCode provider. Spawns the agent,
// reads the data, and tears it down. Reuses the same isolation as the runtime
// model (clean config dir, native tools off).
import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { buildClaudeCodeOptions, resolveConfigDir, type ClaudeCodeControl } from "../acp/claude-config.js";

export interface DiscoverOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  claudeCode?: ClaudeCodeControl;
  claudeExecutable?: string;
  streamCloseTimeoutMs?: number;
  /** Hard timeout for the whole discovery (ms). Default 30000. */
  timeoutMs?: number;
}

export interface DiscoveredModel {
  id: string;
  name?: string;
  description?: string;
}

export interface DiscoveredAgent {
  models: DiscoveredModel[];
  modes: Array<{ id: string; name?: string }>;
  promptCaps: Record<string, boolean>;
  currentModelId?: string;
  agentVersion?: string;
}

const DEBUG = !!process.env.ACP_DEBUG;
const dbg = (m: string) => { if (DEBUG) process.stderr.write(`[acp-discover] ${m}\n`); };

export async function discoverAgent(opts: DiscoverOptions): Promise<DiscoveredAgent> {
  const ctrl = opts.claudeCode ?? {};
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...(opts.env ?? {}) };
  if (opts.claudeExecutable) env.CLAUDE_CODE_EXECUTABLE = opts.claudeExecutable;
  const configDir = resolveConfigDir(ctrl);
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  if (opts.streamCloseTimeoutMs) env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = String(opts.streamCloseTimeoutMs);

  let agent: ChildProcess | null = null;
  const cleanup = () => { try { agent?.kill(); } catch { /* ignore */ } };

  const timeoutMs = opts.timeoutMs ?? 30_000;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`discovery timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  const run = (async (): Promise<DiscoveredAgent> => {
    agent = spawn(opts.command, opts.args ?? [], {
      stdio: ["pipe", "pipe", "ignore"],
      cwd: opts.cwd ?? process.cwd(),
      env,
    });
    // We tear the agent down in cleanup(); swallow EPIPE/spawn errors on its pipes.
    agent.on("error", () => {});
    agent.stdin?.on("error", () => {});
    agent.stdout?.on("error", () => {});
    const stream = ndJsonStream(
      Writable.toWeb(agent.stdin!) as any,
      Readable.toWeb(agent.stdout!) as any,
    );
    const connection: any = new ClientSideConnection(
      () => ({
        async sessionUpdate() {},
        async requestPermission(p: any) {
          const o = p.options?.[0];
          return { outcome: { outcome: "selected", optionId: o?.optionId ?? "allow" } };
        },
        async writeTextFile() { return {}; },
        async readTextFile() { return { content: "" }; },
      }),
      stream,
    );

    const init = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const promptCaps = (init?.agentCapabilities?.promptCapabilities ?? {}) as Record<string, boolean>;
    const agentVersion = init?.agentInfo?.version as string | undefined;

    const session = await connection.newSession({
      cwd: opts.cwd ?? process.cwd(),
      mcpServers: [],
      _meta: { claudeCode: { options: buildClaudeCodeOptions(ctrl) } },
    });

    const models: DiscoveredModel[] = (session?.models?.availableModels ?? []).map((m: any) => ({
      id: m.modelId,
      name: m.name,
      description: m.description ?? undefined,
    }));
    const modes = (session?.modes?.availableModes ?? []).map((m: any) => ({ id: m.id, name: m.name }));

    dbg(`agent ${agentVersion} → models: ${models.map((m) => m.id).join(", ") || "(none)"} | caps: ${JSON.stringify(promptCaps)}`);
    return { models, modes, promptCaps, currentModelId: session?.models?.currentModelId, agentVersion };
  })();

  try {
    return await Promise.race([run, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    cleanup();
  }
}
