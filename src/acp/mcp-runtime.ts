// Standalone MCP (stdio) server spawned BY the ACP agent. It exposes OpenCode's
// tools to the agent and forwards every `tools/call` to the host process (the
// provider) over TCP, awaiting the host's reply — which the host DEFERS until
// OpenCode has executed the tool. No external deps (the agent spawns this from
// an arbitrary cwd, so it must resolve nothing but Node built-ins).
//
// MCP stdio framing = newline-delimited JSON-RPC. Host channel = newline-delimited
// JSON over a localhost TCP socket (port in env ACP_TOOL_HOST_PORT).
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";

const PORT = parseInt(process.env.ACP_TOOL_HOST_PORT || "0", 10);
const PROTOCOL_VERSION = "2025-06-18";

// Robustness: when the agent shuts down (e.g. after an API error) it closes our
// stdio/TCP peers; a pending write then raises EPIPE/ECONNRESET. Swallow those —
// we're being torn down anyway — instead of dying with an unhandled 'error' event.
process.stdout.on("error", () => {});
process.stdin.on("error", () => {});
process.on("uncaughtException", (e: any) => {
  if (e && (e.code === "EPIPE" || e.code === "ECONNRESET")) return;
  process.stderr.write(`[mcp-runtime] uncaught: ${e?.message ?? e}\n`);
  process.exit(1);
});

type Json = Record<string, unknown>;
const write = (msg: Json) => {
  try { process.stdout.write(JSON.stringify(msg) + "\n"); } catch { /* agent peer gone */ }
};
const reply = (id: unknown, result: Json) => write({ jsonrpc: "2.0", id, result });
const replyErr = (id: unknown, code: number, message: string) =>
  write({ jsonrpc: "2.0", id, error: { code, message } });

// ---- Host channel (TCP) ----------------------------------------------------
let host: Socket | null = null;
let hostBuf = "";
let nextHostId = 1;
const hostPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
// `shuttingDown` distingue el cierre propio del agente (stdin cerrada / SIGTERM)
// de una caída del host (reinicio del provider): solo en el segundo caso se
// reconecta. `reconnecting` evita reconexiones concurrentes.
let shuttingDown = false;
let reconnecting = false;
// Backoff de reconexión: 3 intentos (500ms/1s/2s). Solo se sale con exit(1) si
// se agotan o si ya hay un apagado propio en curso.
const RECONNECT_BACKOFF = [500, 1000, 2000];
const RUNTIME_DEBUG = !!process.env.ACP_DEBUG;
const rdbg = (m: string) => { if (RUNTIME_DEBUG) process.stderr.write(`[mcp-runtime] ${m}\n`); };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Rechaza los pendientes con error claro (nunca se dejan colgados).
function failPending(reason: string) {
  if (hostPending.size === 0) return;
  const err = new Error(reason);
  for (const p of hostPending.values()) p.reject(err);
  hostPending.clear();
}

function hostRequest(method: string, params?: Json): Promise<any> {
  return new Promise((resolve, reject) => {
    // Durante la reconexión no se encola: se rechaza con error claro y el
    // agente reintenta (tools/list y tools/call ya traducen el error a MCP).
    if (!host || host.destroyed) {
      return reject(new Error(reconnecting ? "host reconnecting, retry" : "host not connected"));
    }
    const id = nextHostId++;
    hostPending.set(id, { resolve, reject });
    host.write(JSON.stringify({ id, method, params: params ?? {} }) + "\n");
    // No client-side timeout: the host defers until OpenCode resolves the tool.
    // The agent's own MCP timeout (CLAUDE_CODE_STREAM_CLOSE_TIMEOUT) is the bound.
  });
}

function onHostLine(line: string) {
  if (!line.trim()) return;
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  // Host-initiated notification (no id): the OpenCode tool set changed.
  if (msg.method === "toolsChanged") {
    write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    return;
  }
  const p = hostPending.get(msg.id);
  if (!p) return;
  hostPending.delete(msg.id);
  if (msg.error) p.reject(new Error(String(msg.error)));
  else p.resolve(msg.result);
}

function connectHost(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!PORT) return reject(new Error("ACP_TOOL_HOST_PORT not set"));
    let settled = false;
    const sock = createConnection({ host: "127.0.0.1", port: PORT }, () => {
      settled = true;
      host = sock;
      hostBuf = "";
      resolve();
    });
    sock.setNoDelay(true);
    sock.on("data", (d) => {
      hostBuf += d.toString("utf8");
      const lines = hostBuf.split("\n");
      hostBuf = lines.pop() ?? "";
      for (const l of lines) onHostLine(l);
    });
    // Solo se rechaza la conexión inicial; los errores post-conexión se
    // canalizan por 'close' → reconexión (no como fallo fatal directo).
    sock.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
    sock.on("close", () => {
      if (host === sock) onHostClose();
      else if (!settled) { settled = true; reject(new Error("host closed")); }
    });
  });
}

// Cierre del socket del host: se drenan los pendientes y, salvo apagado propio,
// se intenta reconectar con backoff. Nunca se mata al agente por un reinicio
// del host; el exit(1) queda reservado a reintentos agotados o shutdown propio.
function onHostClose() {
  failPending("host closed (reconnecting…)");
  host = null;
  hostBuf = "";
  if (shuttingDown || reconnecting) return;
  void reconnectHost();
}

async function reconnectHost(): Promise<void> {
  if (reconnecting) return;
  reconnecting = true;
  for (let i = 0; i < RECONNECT_BACKOFF.length; i++) {
    if (shuttingDown) break;
    await sleep(RECONNECT_BACKOFF[i]);
    if (shuttingDown) break;
    rdbg(`reconnect attempt ${i + 1}/${RECONNECT_BACKOFF.length}`);
    try {
      await connectHost();
      rdbg("reconnected to host");
      // Re-registro: se avisa al agente para que re-liste herramientas
      // (sirve el getTools del host ya reconectado, sin handshake nuevo).
      write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      reconnecting = false;
      return;
    } catch { /* siguiente backoff */ }
  }
  reconnecting = false;
  if (!shuttingDown) {
    process.stderr.write(`[mcp-runtime] reconnect attempts exhausted, exiting\n`);
    process.exit(1);
  }
}

// ---- MCP stdio handlers ----------------------------------------------------
async function handle(msg: any) {
  const { id, method } = msg;
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "opencode", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
      return; // notification, no reply
    case "ping":
      reply(id, {});
      return;
    case "tools/list": {
      try {
        const tools = await hostRequest("getTools");
        reply(id, { tools: Array.isArray(tools) ? tools : [] });
      } catch (e) {
        replyErr(id, -32603, e instanceof Error ? e.message : String(e));
      }
      return;
    }
    case "tools/call": {
      try {
        const result = await hostRequest("callTool", {
          name: msg.params?.name,
          args: msg.params?.arguments ?? {},
        });
        // Host returns an MCP CallToolResult (or a plain value to wrap).
        if (result && typeof result === "object" && Array.isArray((result as any).content)) {
          reply(id, result);
        } else {
          reply(id, { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] });
        }
      } catch (e) {
        reply(id, { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
      }
      return;
    }
    default:
      if (id !== undefined) replyErr(id, -32601, `Unknown method: ${method}`);
  }
}

async function main() {
  // Apagado propio (el agente cierra stdin o llegan SIGTERM/SIGINT): marca el
  // flag para que onHostClose no intente reconectar ni fuerce exit(1).
  process.on("SIGTERM", () => { shuttingDown = true; });
  process.on("SIGINT", () => { shuttingDown = true; });
  await connectHost();
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    void handle(msg);
  });
  rl.on("close", () => { shuttingDown = true; process.exit(0); });
}

main().catch((e) => {
  process.stderr.write(`[mcp-runtime] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
