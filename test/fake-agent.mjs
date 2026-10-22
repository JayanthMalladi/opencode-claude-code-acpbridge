// In-process fake ACP agent for the provider tests. It speaks real ACP (via the SDK's
// AgentSideConnection) and real MCP: it spawns the `mcpServers` entry the provider
// passes in `session/new` (our mcp-runtime.js) and drives it over stdio, so the whole
// deferred tools/call path is exercised. Tests script it turn by turn.
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

class Queue {
  constructor() { this.items = []; this.waiters = []; }
  push(ev) {
    const i = this.waiters.findIndex((w) => w.match(ev));
    if (i >= 0) { const [w] = this.waiters.splice(i, 1); w.resolve(ev); return; }
    this.items.push(ev);
  }
  next(match, timeoutMs = 3000) {
    const i = this.items.findIndex(match);
    if (i >= 0) return Promise.resolve(this.items.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { match, resolve: (ev) => { clearTimeout(timer); resolve(ev); } };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`fake-agent: timed out waiting for event`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }
}

/** Minimal MCP stdio client over the provider's mcp-runtime. */
class McpClient {
  constructor(server, onNotification) {
    const env = { ...process.env };
    for (const e of server.env ?? []) env[e.name] = e.value;
    this.proc = spawn(server.command, server.args ?? [], { env, stdio: ["pipe", "pipe", "inherit"] });
    this.proc.stdin.on("error", () => {});
    this.seq = 0;
    this.pending = new Map();
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else if (msg.method) onNotification(msg);
    });
  }
  request(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  async init() {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } });
    this.notify("notifications/initialized", {});
  }
  close() {
    try { this.proc.stdin.end(); } catch { /* ignore */ }
    try { this.proc.kill(); } catch { /* ignore */ }
  }
}

/**
 * @param {{ promptQueueing?: boolean, resumeFails?: boolean, cancelDelayMs?: number }} [opts]
 *  promptQueueing (default true) mirrors claude-agent-acp 0.31: a prompt sent while
 *  another is running resolves the running one with `end_turn` and takes over.
 */
export function createFakeAgent(opts = {}) {
  const queueing = opts.promptQueueing ?? true;
  const events = new Queue();
  const log = [];
  const sessions = new Map();
  let seq = 0;
  let conn = null;

  const emit = (ev) => { log.push(ev); events.push(ev); };

  async function openSession(sessionId, params, type) {
    const s = { id: sessionId, cwd: params.cwd, meta: params._meta, turn: null, prompts: [], mcp: null, calls: new Map() };
    sessions.set(sessionId, s);
    const server = (params.mcpServers ?? [])[0];
    if (server) {
      s.mcp = new McpClient(server, (n) => emit({ type: "mcp-notification", sessionId, method: n.method }));
      await s.mcp.init();
    }
    emit({ type, sessionId, meta: params._meta, params });
    return s;
  }

  const impl = {
    async initialize() {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          _meta: { claudeCode: { promptQueueing: queueing } },
        },
      };
    },
    async newSession(params) {
      const s = await openSession(`s${++seq}`, params, "newSession");
      return { sessionId: s.id, models: { currentModelId: "fake", availableModels: [] } };
    },
    async unstable_resumeSession(params) {
      if (opts.resumeFails) throw new Error("resume not possible");
      await openSession(params.sessionId, params, "resumeSession");
      return {};
    },
    async unstable_forkSession(params) {
      const s = await openSession(`s${++seq}`, params, "forkSession");
      emit({ type: "forked", from: params.sessionId, sessionId: s.id });
      return { sessionId: s.id };
    },
    async setSessionMode(params) { emit({ type: "setMode", ...params }); return {}; },
    async setSessionConfigOption(params) { emit({ type: "setConfig", ...params }); return { configOptions: [] }; },
    async unstable_setSessionModel(params) { emit({ type: "setModel", ...params }); return {}; },
    async authenticate() { return {}; },
    async prompt(params) {
      const s = sessions.get(params.sessionId);
      const text = params.prompt.map((b) => (b.type === "text" ? b.text : `<${b.type}>`)).join("\n");
      return new Promise((resolve) => {
        const turn = { resolve, blocks: params.prompt, text };
        if (s.turn) {
          if (queueing) s.turn.resolve({ stopReason: "end_turn" });
          else turn.queuedBehind = s.turn;
        }
        s.turn = turn;
        s.prompts.push(turn);
        emit({ type: "prompt", sessionId: params.sessionId, blocks: params.prompt, text });
      });
    },
    async cancel(params) {
      const s = sessions.get(params.sessionId);
      emit({ type: "cancel", sessionId: params.sessionId });
      const t = s?.turn;
      if (!t) return;
      s.turn = null;
      // cancelDelayMs: the cancelled prompt resolves late, as a real agent does while
      // it unwinds the CLI turn — the window where a stale completion can hit a new turn.
      if (opts.cancelDelayMs) setTimeout(() => t.resolve({ stopReason: "cancelled" }), opts.cancelDelayMs);
      else t.resolve({ stopReason: "cancelled" });
    },
    async extMethod(method, params) {
      emit({ type: "ext", method, params });
      if (method === "session/close") {
        const s = sessions.get(params.sessionId);
        s?.mcp?.close();
        sessions.delete(params.sessionId);
      }
      return {};
    },
  };

  const c2a = new TransformStream();
  const a2c = new TransformStream();
  conn = new AgentSideConnection(() => impl, ndJsonStream(a2c.writable, c2a.readable));

  const update = (sessionId, u) => conn.sessionUpdate({ sessionId, update: u });

  return {
    log,
    sessions,
    /** Transport for ACPModelConfig.transport. */
    transport: () => ({
      input: c2a.writable,
      output: a2c.readable,
      close: () => { for (const s of sessions.values()) s.mcp?.close(); },
    }),
    /** Wait for the next event of `type` (optionally matching `pred`). */
    next(type, pred = () => true, timeoutMs) {
      return events.next((e) => e.type === type && pred(e), timeoutMs);
    },
    /** Assert no event of `type` arrives within `ms`. */
    async none(type, ms = 150) {
      try { const e = await events.next((x) => x.type === type, ms); return e; } catch { return null; }
    },
    chunk: (sid, text) => update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }),
    thought: (sid, text) => update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } }),
    modeUpdate: (sid, modeId) => update(sid, { sessionUpdate: "current_mode_update", currentModeId: modeId }),
    usage: (sid, used, size = 200000) => update(sid, { sessionUpdate: "usage_update", used, size }),
    toolUpdate: (sid, u) => update(sid, u),
    /** MCP tools/call through the provider's runtime → resolves with the CallToolResult. */
    callTool(sid, name, args = {}, meta) {
      const s = sessions.get(sid);
      return s.mcp.request("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    },
    listTools(sid) { return sessions.get(sid).mcp.request("tools/list", {}); },
    /** Id of the last MCP request sent for `sid` (to cancel it). */
    lastRequestId(sid) { return sessions.get(sid).mcp.seq; },
    /** MCP `notifications/cancelled` for a tools/call, as Claude Code sends on interrupt. */
    cancelCall(sid, requestId) { sessions.get(sid).mcp.notify("notifications/cancelled", { requestId, reason: "interrupted" }); },
    requestPermission: (sid, toolCall, options) => conn.requestPermission({ sessionId: sid, toolCall, options }),
    /** Finish the running prompt of `sid`. */
    endTurn(sid, resp = { stopReason: "end_turn" }) {
      const s = sessions.get(sid);
      const t = s.turn; s.turn = null;
      t?.resolve(resp);
    },
    close() { for (const s of sessions.values()) s.mcp?.close(); },
  };
}
