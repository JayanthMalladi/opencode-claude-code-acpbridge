// Host side of the synthetic MCP server. Runs inside the provider process.
// Listens on a localhost TCP port; the agent-spawned `mcp-runtime` connects to
// it. Serves the OpenCode tool list (`getTools`) and DEFERS each `callTool`
// until the provider resolves it with OpenCode's real result. The MCP
// `tools/call` is our orchestration channel: we mint the toolCallId here.
import { createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: object;
}

export interface DeferredToolCall {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

type ToolCallHandler = (call: DeferredToolCall) => void;

const RUNTIME_PATH = join(dirname(fileURLToPath(import.meta.url)), "mcp-runtime.js");
// Use a real JS interpreter. process.execPath can be the host app binary (e.g.
// the compiled `opencode`/bun executable) which won't run an arbitrary script.
const NODE_BIN = process.env.ACP_RUNTIME_NODE || "node";
const HOST_DEBUG = !!process.env.ACP_DEBUG;
const hdbg = (m: string) => { if (HOST_DEBUG) process.stderr.write(`[acp-mcp-host] ${m}\n`); };

export class McpHost {
  private server: Server | null = null;
  private port = 0;
  private tools: McpToolDef[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly pending = new Map<string, { socket: Socket; runtimeId: unknown }>();
  private handler: ToolCallHandler | null = null;
  private counter = 0;

  /** `idPrefix` scopes minted toolCallIds to THIS host instance. It MUST be unique per
   *  host (a fresh host is created on every ACP session reset), otherwise the per-host
   *  counter restarts at 0 and re-mints `acp_1`, `acp_2`, … — which then collide with
   *  old tool-results still in OpenCode's replayed history and `detectContinuation`
   *  resolves a fresh call with a STALE result. The caller passes a random-nonce prefix. */
  constructor(private readonly name = "opencode", private readonly idPrefix = "acp_") {}

  setTools(tools: McpToolDef[]) {
    this.tools = tools;
  }

  /** Push an MCP `tools/list_changed` notification to the connected runtime so the
   *  agent re-fetches the tool list. Lets a tool-set change be applied to a LIVE
   *  session instead of forcing a fresh one (which would replay the whole history
   *  and throw away Claude's prompt cache). */
  notifyToolsChanged() {
    hdbg(`tools changed (${this.tools.length}) → notifying ${this.sockets.size} runtime(s)`);
    for (const s of this.sockets) this.send(s, { method: "toolsChanged" });
  }

  onToolCall(handler: ToolCallHandler) {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server = createServer((socket) => this.handleSocket(socket));
      this.server.on("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          resolve();
        } else reject(new Error("McpHost: failed to bind"));
      });
    });
  }

  /** mcpServer (stdio) entry for ACP `session/new`. */
  getServerConfig() {
    hdbg(`serverConfig: ${NODE_BIN} ${RUNTIME_PATH} (port ${this.port})`);
    return {
      name: this.name,
      command: NODE_BIN,
      args: [RUNTIME_PATH],
      env: [{ name: "ACP_TOOL_HOST_PORT", value: String(this.port) }],
    };
  }

  /** Resolve a deferred tools/call with OpenCode's result (MCP CallToolResult or plain value). */
  resolveToolCall(toolCallId: string, result: unknown): boolean {
    const p = this.pending.get(toolCallId);
    if (!p) return false;
    this.pending.delete(toolCallId);
    this.send(p.socket, { id: p.runtimeId, result });
    return true;
  }

  rejectToolCall(toolCallId: string, message: string): boolean {
    const p = this.pending.get(toolCallId);
    if (!p) return false;
    this.pending.delete(toolCallId);
    this.send(p.socket, { id: p.runtimeId, error: message });
    return true;
  }

  hasPending(toolCallId: string): boolean {
    return this.pending.has(toolCallId);
  }

  stop() {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.pending.clear();
    this.server?.close();
    this.server = null;
  }

  private handleSocket(socket: Socket) {
    socket.setNoDelay(true);
    this.sockets.add(socket);
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) this.handleLine(socket, line);
    });
    const drop = () => this.sockets.delete(socket);
    socket.on("close", drop);
    socket.on("error", drop);
  }

  private handleLine(socket: Socket, line: string) {
    if (!line.trim()) return;
    let msg: { id?: unknown; method?: string; params?: { name?: string; args?: Record<string, unknown> } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === "getTools") {
      hdbg(`runtime → getTools (serving ${this.tools.length} tools)`);
      this.send(socket, { id: msg.id, result: this.tools });
    } else if (msg.method === "callTool") {
      const toolCallId = `${this.idPrefix}${++this.counter}`;
      this.pending.set(toolCallId, { socket, runtimeId: msg.id });
      this.handler?.({ toolCallId, name: msg.params?.name ?? "", args: msg.params?.args ?? {} });
    }
  }

  private send(socket: Socket, msg: object) {
    try { socket.write(JSON.stringify(msg) + "\n"); } catch { /* runtime peer gone */ }
  }
}
