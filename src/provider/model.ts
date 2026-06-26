// LanguageModelV3 orchestrator: backs an OpenCode model with the Claude Code ACP
// agent while keeping OpenCode as the tool executor ("OpenCode orquesta").
//
// Session strategy (efficiency + prompt caching):
//  - The AI SDK is stateless: OpenCode resends the FULL prompt every doStream.
//  - We keep a PERSISTENT ACP session per conversation. On the first turn of a
//    conversation we send the whole history; on later turns we send only the
//    DELTA (the last user message) — the agent already holds its side (its
//    answers + tool-results) in the session and reuses Claude's prompt cache.
//  - We reset to a fresh session only when the conversation changes (different
//    first user message) or the tool set changes — this isolates OpenCode's
//    title/small-model call (tools=0) from the real call (tools=N).
//
// Tool flow: when the agent calls an MCP tool, the host fires onToolCall → we
// emit a `tool-call` with the REAL OpenCode tool name, finish `tool-calls`, and
// leave the MCP tools/call DEFERRED; the next doStream brings OpenCode's
// tool-result → we resolve it and the same agent turn continues.
import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3GenerateResult,
  LanguageModelV3Usage,
  LanguageModelV3Content,
} from "@ai-sdk/provider";
import { McpHost, type McpToolDef } from "../acp/mcp-host.js";
import {
  buildClaudeCodeOptions,
  resolveConfigDir,
  type ClaudeCodeControl,
} from "../acp/claude-config.js";
import { setLink, updateUsage } from "../plugin/sessions.js";

const DEBUG = !!process.env.ACP_DEBUG;
const dbg = (m: string) => { if (DEBUG) process.stderr.write(`[acp-orchestrator] ${m}\n`); };

export interface ACPModelConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  modelId?: string;
  claudeCode?: ClaudeCodeControl;
  streamCloseTimeoutMs?: number;
  claudeExecutable?: string;
}

type StreamController = ReadableStreamDefaultController<LanguageModelV3StreamPart>;

interface TurnState {
  host: McpHost;
  sessionId: string;
  convKey: string;
  toolsKey: string;
  systemKey: string;
  /** Hash of creation params that force a fresh session if changed (thinking/systemPromptMode). */
  cfgKey: string;
  /** Runtime config already applied via setSessionMode/setSessionConfigOption (no reset needed). */
  appliedMode?: string;
  appliedEffort?: string;
  /** Last cumulative ACP usage for this session, to report per-turn deltas. */
  lastUsage?: any;
  /** OpenCode session id — kept so end-of-turn can persist `lastUsage` to the registry. */
  ocSession?: string;
  controller: StreamController | null;
  pendingTools: Set<string>;
  /** Permission bridge: claude_permission toolCallId → resolver of the deferred
   *  ACP requestPermission. The agent waits on the Promise while OpenCode shows
   *  its `ask` prompt; the tool-result (approved / error) resolves it. */
  pendingPermissions: Map<string, (approved: boolean) => void>;
  textId: string | null;
  reasoningId: string | null;
}

function emptyUsage(): LanguageModelV3Usage {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined },
  } as LanguageModelV3Usage;
}

/** ACP turn `Usage` → `LanguageModelV3Usage` (so OpenCode shows the token consumption). */
function mapUsage(u: any): LanguageModelV3Usage {
  if (!u || typeof u !== "object") return emptyUsage();
  const noCache = u.inputTokens ?? undefined;
  const cacheRead = u.cachedReadTokens ?? undefined;
  const cacheWrite = u.cachedWriteTokens ?? undefined;
  const inTotal = (noCache ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  return {
    inputTokens: { total: inTotal || undefined, noCache, cacheRead, cacheWrite },
    outputTokens: { total: u.outputTokens ?? undefined, text: u.outputTokens ?? undefined },
  } as LanguageModelV3Usage;
}

/** ACP usage is cumulative per session → subtract the previous snapshot to get this turn's. */
function subtractUsage(acc: any, prev: any): any {
  if (!acc || typeof acc !== "object") return acc;
  if (!prev) return acc;
  const d = (a: any, b: any) => Math.max(0, (a ?? 0) - (b ?? 0));
  return {
    inputTokens: d(acc.inputTokens, prev.inputTokens),
    outputTokens: d(acc.outputTokens, prev.outputTokens),
    cachedReadTokens: d(acc.cachedReadTokens, prev.cachedReadTokens),
    cachedWriteTokens: d(acc.cachedWriteTokens, prev.cachedWriteTokens),
    totalTokens: d(acc.totalTokens, prev.totalTokens),
  };
}

function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

export class ACPOrchestratorModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "acp";
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private agent: ChildProcess | null = null;
  private connection: any = null;
  private connecting: Promise<void> | null = null;
  private current: TurnState | null = null;
  private idSeq = 0;
  private promptCaps: Record<string, boolean> = {};

  constructor(private readonly config: ACPModelConfig) {
    this.modelId = config.modelId ?? "claude-code";
  }

  // ---- LanguageModelV3 ------------------------------------------------------

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<{ stream: ReadableStream<LanguageModelV3StreamPart>; warnings: never[] }> {
    const continuation = this.detectContinuation(options.prompt);
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (controller) => void this.onStart(controller, options, continuation),
      cancel: () => this.onCancel(),
    });
    return { stream, warnings: [] };
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { stream } = await this.doStream(options);
    const content: LanguageModelV3Content[] = [];
    let text = "";
    let finishReason: LanguageModelV3GenerateResult["finishReason"] = { unified: "stop", raw: undefined };
    let usage: LanguageModelV3Usage = emptyUsage();
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === "text-delta") text += value.delta;
      else if (value.type === "tool-call") content.push(value as any);
      else if (value.type === "finish") { finishReason = value.finishReason; usage = value.usage; }
    }
    if (text) content.unshift({ type: "text", text } as any);
    return { content, finishReason, usage, warnings: [] };
  }

  // ---- turn lifecycle -------------------------------------------------------

  private async onStart(
    controller: StreamController,
    options: LanguageModelV3CallOptions,
    continuation: Array<{ toolCallId: string; result: unknown; output: any }> | null,
  ) {
    try {
      controller.enqueue({ type: "stream-start", warnings: [] });

      // (1) Continuation of a deferred tool-call OR a bridged permission — resume
      // the same agent turn.
      if (continuation && this.current) {
        const t = this.current;
        t.controller = controller;
        t.textId = null;
        t.reasoningId = null;
        for (const { toolCallId, result, output } of continuation) {
          const permResolve = t.pendingPermissions.get(toolCallId);
          if (permResolve) {
            // Permission bridge: OpenCode's `ask` verdict came back as the
            // claude_permission tool-result → resolve the deferred requestPermission.
            t.pendingPermissions.delete(toolCallId);
            permResolve(!this.isErrorOutput(output));
          } else {
            t.pendingTools.delete(toolCallId);
            t.host.resolveToolCall(toolCallId, result);
          }
        }
        return;
      }

      await this.ensureConnected();
      const tools = this.convertTools(options.tools);
      const ctrl = this.effectiveCtrl(options);
      const convKey = hashText(this.firstUserText(options.prompt));
      const toolsKey = tools.map((t) => t.name).sort().join(",");
      // System prompt is part of the identity: OpenCode can switch agents within a
      // session (same history, different system prompt). The agent can't change its
      // system prompt mid-session, so a system change forces a fresh session that
      // replays the full history under the new system prompt.
      const systemKey = hashText(this.systemText(options.prompt));
      // Params baked into newSession's _meta (thinking/systemPromptMode) can't change
      // mid-session → a change forces a fresh session. mode/effort are applied at
      // runtime via set_mode/set_config_option instead (no reset needed).
      const cfgKey = hashText(JSON.stringify({ t: ctrl.thinking, s: ctrl.systemPromptMode ?? "preset" }));
      // Session registry plumbing (chat.params → providerOptions.acp): `ocSession`
      // is the OpenCode key; `resumeId`/`resumeLen` come from the persistent registry.
      const po = (options.providerOptions as any)?.[this.provider] ?? {};
      const ocSession: string | undefined = po.ocSession;
      const histLen = options.prompt.length;

      // (2) Same conversation + tools + system + creation-cfg → reuse session, send only the delta.
      if (
        this.current &&
        this.current.convKey === convKey &&
        this.current.toolsKey === toolsKey &&
        this.current.systemKey === systemKey &&
        this.current.cfgKey === cfgKey
      ) {
        dbg(`reuse session ${this.current.sessionId} — delta only (cache-friendly)`);
        this.current.controller = controller;
        this.current.textId = null;
        this.current.reasoningId = null;
        if (ocSession) this.current.ocSession = ocSession;
        await this.applySessionConfig(this.current, ctrl); // runtime mode/effort change
        if (ocSession) setLink(ocSession, this.current.sessionId, histLen);
        const blocks = this.lastUserBlocks(options.prompt);
        this.connection
          .prompt({ sessionId: this.current.sessionId, prompt: blocks })
          .then((resp: any) => this.onPromptDone(resp))
          .catch((err: any) => this.onPromptError(err));
        return;
      }

      // (3) Need a session: new conversation / tools / system / cfg changed, OR a
      // resumable session from a new process. Set up the MCP host once.
      const reason = !this.current ? "new conversation"
        : this.current.convKey !== convKey ? "new conversation"
        : this.current.toolsKey !== toolsKey ? "tools changed"
        : this.current.systemKey !== systemKey ? "system prompt changed"
        : "config changed";
      this.endTurn();
      const host = new McpHost("opencode");
      host.onToolCall((c) => this.onToolCall(c));
      await host.start();
      host.setTools(tools);
      const serverConfig = host.getServerConfig();

      // Try to RESUME a registered Claude Code session (new process, no live state,
      // history grew rather than diverged) → no history replay (saves tokens). Else
      // create a fresh session and replay the full history.
      const resumeId: string | undefined = po.resumeId;
      let sessionId: string | undefined;
      let replayFull = true;
      if (!this.current && resumeId && histLen > (po.resumeLen ?? 0)) {
        try {
          await this.connection.unstable_resumeSession({
            sessionId: resumeId,
            cwd: this.config.cwd ?? process.cwd(),
            mcpServers: [serverConfig],
            // Re-apply the clean-brain options on resume too. Without this the agent
            // falls back to its defaults (--tools default, --setting-sources=user,
            // project,local, no --strict-mcp-config) and the resumed session regains
            // native tools + the claude.ai connectors. getOrCreateSession forwards
            // this _meta to createSession when the session isn't live in-process.
            _meta: { claudeCode: { options: buildClaudeCodeOptions(ctrl) } },
          } as any);
          sessionId = resumeId;
          replayFull = false;
          dbg(`resume ${resumeId} (oc=${ocSession ?? "?"}) — no history replay`);
        } catch (e) {
          dbg(`resume ${resumeId} failed (${e instanceof Error ? e.message : String(e)}) — fresh session`);
        }
      }
      if (!sessionId) {
        // OpenCode's system prompt → _meta.systemPrompt (preset/append/replace).
        const meta: any = { claudeCode: { options: buildClaudeCodeOptions(ctrl) } };
        const sysMeta = this.buildSystemPromptMeta(options.prompt, ctrl.systemPromptMode ?? "preset");
        if (sysMeta !== undefined) meta.systemPrompt = sysMeta;
        const session = await this.connection.newSession({
          cwd: this.config.cwd ?? process.cwd(),
          mcpServers: [serverConfig],
          _meta: meta,
        });
        sessionId = session.sessionId;
        dbg(`new session ${sessionId} (${reason}) model=${session.models?.currentModelId ?? "?"} (requested: ${ctrl.model ?? "default"}, mode: ${ctrl.mode ?? "default"}, effort: ${ctrl.effort ?? "default"}) — tools(${tools.length})`);
      }

      if (!sessionId) throw new Error("failed to create or resume an ACP session");

      const t: TurnState = {
        host,
        sessionId,
        convKey,
        toolsKey,
        systemKey,
        cfgKey,
        ocSession,
        // Resume path: seed the cumulative usage snapshot from the persisted
        // registry so the first post-resume `subtractUsage` produces a real
        // turn delta instead of the full cumulative.
        lastUsage: replayFull ? undefined : po.resumeLastUsage,
        controller,
        pendingTools: new Set(),
        pendingPermissions: new Map(),
        textId: null,
        reasoningId: null,
      };
      this.current = t;
      await this.applySessionConfig(t, ctrl); // mode/effort at runtime
      if (ocSession) setLink(ocSession, sessionId, histLen);

      this.connection
        .prompt({ sessionId, prompt: replayFull ? this.convertMessages(options.prompt) : this.lastUserBlocks(options.prompt) })
        .then((resp: any) => this.onPromptDone(resp))
        .catch((err: any) => this.onPromptError(err));
    } catch (err) {
      dbg(`onStart error: ${err instanceof Error ? err.message : String(err)}`);
      controller.enqueue({ type: "error", error: err });
      try { controller.close(); } catch { /* ignore */ }
    }
  }

  private onPromptDone(resp: { stopReason?: string; usage?: any }) {
    const t = this.current;
    if (!t || !t.controller) return; // cut for a pending tool-call
    this.closeBlocks(t);
    const turn = subtractUsage(resp?.usage, t.lastUsage); // ACP usage is cumulative per session
    if (resp?.usage) {
      t.lastUsage = resp.usage;
      if (t.ocSession) updateUsage(t.ocSession, resp.usage); // survive process restarts
    }
    if (DEBUG && turn) dbg(`usage(turn): in=${turn.inputTokens} out=${turn.outputTokens} cacheR=${turn.cachedReadTokens} cacheW=${turn.cachedWriteTokens}`);
    t.controller.enqueue({
      type: "finish",
      usage: mapUsage(turn),
      finishReason: { unified: resp?.stopReason === "max_tokens" ? "length" : "stop", raw: resp?.stopReason },
    });
    try { t.controller.close(); } catch { /* ignore */ }
    t.controller = null; // keep the session for the next turn (delta)
  }

  private onPromptError(err: unknown) {
    const t = this.current;
    if (!t || !t.controller) return;
    dbg(`prompt error: ${err instanceof Error ? err.message : String(err)}`);
    t.controller.enqueue({ type: "error", error: err });
    try { t.controller.close(); } catch { /* ignore */ }
    t.controller = null;
  }

  /** Fired by the MCP host when the agent calls an OpenCode tool. */
  private onToolCall(call: { toolCallId: string; name: string; args: Record<string, unknown> }) {
    const t = this.current;
    if (!t || !t.controller) return;
    dbg(`agent → tool-call ${call.name} (${call.toolCallId}) → emit to OpenCode`);
    this.closeBlocks(t);
    t.pendingTools.add(call.toolCallId);
    const inputJson = JSON.stringify(call.args ?? {});
    t.controller.enqueue({ type: "tool-input-start", id: call.toolCallId, toolName: call.name });
    t.controller.enqueue({ type: "tool-input-delta", id: call.toolCallId, delta: inputJson });
    t.controller.enqueue({ type: "tool-input-end", id: call.toolCallId });
    t.controller.enqueue({ type: "tool-call", toolCallId: call.toolCallId, toolName: call.name, input: inputJson });
    t.controller.enqueue({ type: "finish", usage: emptyUsage(), finishReason: { unified: "tool-calls", raw: "tool_use" } });
    try { t.controller.close(); } catch { /* ignore */ }
    t.controller = null; // DO NOT resolve yet — wait for the continuation doStream
  }

  // ---- permission bridge -----------------------------------------------------

  /** Map approve/reject to one of the options the agent offered (by kind/optionId). */
  private permOutcome(params: any, approved: boolean): { outcome: any } {
    const opts: any[] = params?.options ?? [];
    const want = approved
      ? (o: any) => o.kind === "allow_once" || o.kind === "allow_always" || o.optionId === "allow"
      : (o: any) => o.kind === "reject_once" || o.kind === "reject_always" || o.optionId === "reject";
    const opt = opts.find(want) ?? (approved ? opts[0] : undefined);
    if (!opt) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: opt.optionId } };
  }

  /** Human label of the tool the agent wants permission for (title/kind). */
  private permToolName(toolCall: any): string {
    return toolCall?.title ?? toolCall?.kind ?? "tool";
  }

  /** ACP requestPermission → OpenCode `ask`, via the claude_permission meta-tool.
   *  Deferred: returns a Promise the agent awaits until OpenCode's verdict comes
   *  back as the meta-tool's result (resolved in onStart's continuation branch). */
  private onRequestPermission(params: any): Promise<{ outcome: any }> {
    const t = this.current;
    // No live turn/controller → approve so the agent never hangs.
    if (!t || !t.controller) return Promise.resolve(this.permOutcome(params, true));
    const callId = `perm_${++this.idSeq}`;
    dbg(`requestPermission(${this.permToolName(params?.toolCall)}) → bridge as claude_permission (${callId})`);
    return new Promise<{ outcome: any }>((resolve) => {
      t.pendingPermissions.set(callId, (approved: boolean) => resolve(this.permOutcome(params, approved)));
      this.emitPermissionCall(t, callId, params?.toolCall);
    });
  }

  /** Emit a claude_permission tool-call to OpenCode (same deferred pattern as a
   *  real tool-call): OpenCode applies its `ask` permission and returns the
   *  verdict as the tool-result on the next doStream. */
  private emitPermissionCall(t: TurnState, callId: string, toolCall: any) {
    if (!t.controller) return;
    this.closeBlocks(t);
    const input = JSON.stringify({
      tool: this.permToolName(toolCall),
      kind: toolCall?.kind,
      title: toolCall?.title,
      input: toolCall?.rawInput,
    });
    t.controller.enqueue({ type: "tool-input-start", id: callId, toolName: "claude_permission" });
    t.controller.enqueue({ type: "tool-input-delta", id: callId, delta: input });
    t.controller.enqueue({ type: "tool-input-end", id: callId });
    t.controller.enqueue({ type: "tool-call", toolCallId: callId, toolName: "claude_permission", input });
    t.controller.enqueue({ type: "finish", usage: emptyUsage(), finishReason: { unified: "tool-calls", raw: "tool_use" } });
    try { t.controller.close(); } catch { /* ignore */ }
    t.controller = null;
  }

  /** Fired by the ACP client on session/update. */
  private onSessionUpdate(update: any) {
    const t = this.current;
    if (!t || !t.controller) return;
    switch (update?.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content?.type === "text") {
          if (!t.textId) { t.textId = `t${++this.idSeq}`; t.controller.enqueue({ type: "text-start", id: t.textId }); }
          t.controller.enqueue({ type: "text-delta", id: t.textId, delta: update.content.text });
        }
        break;
      case "agent_thought_chunk":
        if (update.content?.type === "text") {
          if (!t.reasoningId) { t.reasoningId = `r${++this.idSeq}`; t.controller.enqueue({ type: "reasoning-start", id: t.reasoningId }); }
          t.controller.enqueue({ type: "reasoning-delta", id: t.reasoningId, delta: update.content.text });
        }
        break;
      default:
        break; // tool_call/tool_call_update are informational; MCP host drives emission
    }
  }

  private closeBlocks(t: TurnState) {
    if (t.textId && t.controller) { t.controller.enqueue({ type: "text-end", id: t.textId }); t.textId = null; }
    if (t.reasoningId && t.controller) { t.controller.enqueue({ type: "reasoning-end", id: t.reasoningId }); t.reasoningId = null; }
  }

  private endTurn() {
    const t = this.current;
    if (!t) return;
    try { if (this.connection && t.sessionId) this.connection.cancel?.({ sessionId: t.sessionId }); } catch { /* ignore */ }
    t.host.stop();
    this.current = null;
  }

  /** Provider config overlaid with per-call `providerOptions.acp` (per-agent mode/effort/…). */
  private effectiveCtrl(options: LanguageModelV3CallOptions): ClaudeCodeControl {
    const ctrl: ClaudeCodeControl = { ...(this.config.claudeCode ?? {}) };
    const po = (options.providerOptions as any)?.[this.provider];
    if (po && typeof po === "object") {
      // Per-agent overrides from `agent.<name>.options` (→ providerOptions.acp):
      // mode/effort/reasoning plus the native-feature toggles.
      const KEYS = [
        "mode", "effort", "thinking", "systemPromptMode",
        "tools", "allowedTools", "disallowedTools", "settingSources", "strictMcpConfig",
        "nativeTools", "resourceSearch", "nativeSubagents", "nativeSkills", "projectMemory", "skillShell",
      ] as const;
      for (const k of KEYS) if (po[k] !== undefined) (ctrl as any)[k] = po[k];
    }
    // OpenCode's modelId maps to Claude's model unless claudeCode.model overrides it.
    if (!ctrl.model && this.modelId && this.modelId !== "claude-code") ctrl.model = this.modelId;
    return ctrl;
  }

  /** Apply runtime config (mode/effort) to a live ACP session via set_mode/set_config_option. */
  private async applySessionConfig(t: TurnState, ctrl: ClaudeCodeControl): Promise<void> {
    if (ctrl.mode && ctrl.mode !== t.appliedMode) {
      try {
        await this.connection.setSessionMode({ sessionId: t.sessionId, modeId: ctrl.mode });
        t.appliedMode = ctrl.mode;
        dbg(`mode → ${ctrl.mode}`);
      } catch (e) { dbg(`setSessionMode(${ctrl.mode}) failed: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (ctrl.effort && ctrl.effort !== t.appliedEffort) {
      try {
        await this.connection.setSessionConfigOption({ sessionId: t.sessionId, configId: "effort", value: ctrl.effort });
        t.appliedEffort = ctrl.effort;
        dbg(`effort → ${ctrl.effort}`);
      } catch (e) { dbg(`setSessionConfigOption(effort=${ctrl.effort}) failed: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  // ---- connection -----------------------------------------------------------

  private ensureConnected(): Promise<void> {
    if (this.connection) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.connect();
    return this.connecting;
  }

  private async connect() {
    const ctrl = this.config.claudeCode ?? {};
    const env: Record<string, string> = { ...(process.env as Record<string, string>), ...(this.config.env ?? {}) };
    if (this.config.claudeExecutable) env.CLAUDE_CODE_EXECUTABLE = this.config.claudeExecutable;
    const configDir = resolveConfigDir(ctrl);
    if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
    if (this.config.streamCloseTimeoutMs) env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = String(this.config.streamCloseTimeoutMs);
    // Model selection: the agent resolves the effective model from ANTHROPIC_MODEL
    // (getAvailableModels overrides options.model otherwise). claudeCode.model wins,
    // else the OpenCode modelId (unless the neutral "claude-code").
    const model = ctrl.model ?? (this.modelId !== "claude-code" ? this.modelId : undefined);
    if (model) env.ANTHROPIC_MODEL = model;

    this.agent = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.config.cwd ?? process.cwd(),
      env,
    });
    // If the agent dies (e.g. after an API error) a pending write to its stdin
    // raises EPIPE; swallow pipe errors so they don't crash the OpenCode process.
    this.agent.on("error", () => {});
    this.agent.stdin?.on("error", () => {});
    this.agent.stdout?.on("error", () => {});
    // The agent's stderr carries its own diagnostics — e.g. claude-agent-acp's
    // benign `No onPostToolUseHook found` (expected here: OpenCode, not the agent,
    // executes the tools, so the agent never sees the tool_response that would fire
    // its PostToolUse hook). With stdio "inherit" these print RAW over OpenCode's
    // TUI; pipe them and forward to our stderr ONLY under ACP_DEBUG so the TUI stays
    // clean in normal use.
    this.agent.stderr?.on("error", () => {});
    this.agent.stderr?.on("data", (chunk: Buffer) => { if (DEBUG) process.stderr.write(chunk); });
    const stream = ndJsonStream(
      Writable.toWeb(this.agent.stdin!) as any,
      Readable.toWeb(this.agent.stdout!) as any,
    );
    const self = this;
    this.connection = new ClientSideConnection(
      () => ({
        async sessionUpdate(params: any) { self.onSessionUpdate(params.update); },
        async requestPermission(params: any) {
          return self.onRequestPermission(params);
        },
        async writeTextFile() { return {}; },
        async readTextFile() { return { content: "" }; },
      }),
      stream,
    );
    const initResult = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    this.promptCaps = (initResult?.agentCapabilities?.promptCapabilities ?? {}) as Record<string, boolean>;
    dbg(`connected to agent — promptCapabilities: ${JSON.stringify(this.promptCaps)}`);
  }

  private onCancel() {
    this.endTurn();
  }

  cleanup() {
    this.endTurn();
    try { this.agent?.kill(); } catch { /* ignore */ }
    this.agent = null;
    this.connection = null;
    this.connecting = null;
  }

  // ---- conversions ----------------------------------------------------------

  private convertTools(tools: LanguageModelV3CallOptions["tools"]): McpToolDef[] {
    if (!tools) return [];
    const out: McpToolDef[] = [];
    for (const t of tools) {
      if ((t as any).type === "function") {
        out.push({
          name: (t as any).name,
          description: (t as any).description,
          inputSchema: (t as any).inputSchema ?? { type: "object", properties: {} },
        });
      }
    }
    return out;
  }

  /** Text of the first user message — stable identifier for the conversation. */
  private firstUserText(prompt: LanguageModelV3CallOptions["prompt"]): string {
    for (const m of prompt) {
      if (m.role !== "user") continue;
      if (typeof (m as any).content === "string") return (m as any).content;
      return ((m as any).content as any[]).filter((p) => p.type === "text").map((p) => p.text).join("");
    }
    return "";
  }

  private messageToBlocks(msg: any, withPrefix: boolean): any[] {
    const prefixes: Record<string, string> = { system: "System: ", assistant: "Assistant: ", tool: "", user: "" };
    const prefix = withPrefix ? (prefixes[msg.role] ?? "") : "";
    if (typeof msg.content === "string") return [{ type: "text", text: `${prefix}${msg.content}` }];
    const blocks: any[] = [];
    let first = true;
    for (const part of msg.content as any[]) {
      const px = first ? prefix : "";
      if (part.type === "text") { blocks.push({ type: "text", text: px + part.text }); first = false; }
      else if (part.type === "tool-call") { blocks.push({ type: "text", text: `${px}[Called tool ${part.toolName}(${JSON.stringify(part.input)})]` }); first = false; }
      else if (part.type === "tool-result") { blocks.push({ type: "text", text: `${px}[Tool ${part.toolName} result: ${this.outputToText(part.output)}]` }); first = false; }
      else if (part.type === "file") {
        const fb = this.fileToBlock(part);
        blocks.push(fb ?? { type: "text", text: `${px}[Attachment ${part.mediaType ?? "file"} not supported by the agent]` });
        first = false;
      }
    }
    return blocks;
  }

  /** Map an AI SDK file part to an ACP ContentBlock, honoring the agent's promptCapabilities. */
  private fileToBlock(part: any): any | null {
    const mt: string = part.mediaType || "application/octet-stream";
    const data = this.toBase64(part.data);
    if (!data) return null; // URL or non-embeddable data
    if (mt.startsWith("image/")) return this.promptCaps.image ? { type: "image", data, mimeType: mt } : null;
    if (mt.startsWith("audio/")) return this.promptCaps.audio ? { type: "audio", data, mimeType: mt } : null;
    if (mt.startsWith("video/")) return null; // not representable in ACP / not understood by Claude
    // PDFs and other documents → embedded resource (blob) when the agent accepts embedded context.
    if (this.promptCaps.embeddedContext) {
      const ext = mt.split("/")[1] || "bin";
      return { type: "resource", resource: { uri: part.filename || `attachment.${ext}`, mimeType: mt, blob: data } };
    }
    return null;
  }

  private toBase64(data: unknown): string | null {
    if (data instanceof Uint8Array) return Buffer.from(data).toString("base64");
    if (typeof data === "string") return data.includes(",") ? data.split(",")[1] : data; // data URL or raw base64
    return null; // URL or other — not embeddable
  }

  /** Full prompt flattened to ACP ContentBlocks (first turn of a conversation). */
  private convertMessages(prompt: LanguageModelV3CallOptions["prompt"]): any[] {
    const blocks: any[] = [];
    for (const msg of prompt) {
      if (msg.role === "system") continue; // forwarded via _meta.systemPrompt
      blocks.push(...this.messageToBlocks(msg, true));
    }
    return blocks.length ? blocks : [{ type: "text", text: "" }];
  }

  /** OpenCode's system text → `_meta.systemPrompt` per mode. */
  private buildSystemPromptMeta(prompt: LanguageModelV3CallOptions["prompt"], mode: string): unknown {
    if (mode === "preset") return undefined;
    const text = this.systemText(prompt);
    if (!text) return undefined;
    return mode === "replace" ? text : { append: text };
  }

  private systemText(prompt: LanguageModelV3CallOptions["prompt"]): string {
    const parts: string[] = [];
    for (const m of prompt) {
      if (m.role !== "system") continue;
      parts.push(
        typeof (m as any).content === "string"
          ? (m as any).content
          : ((m as any).content as any[]).filter((p) => p.type === "text").map((p) => p.text).join(""),
      );
    }
    return parts.join("\n").trim();
  }

  /** Only the last user message (delta for a persistent session). */
  private lastUserBlocks(prompt: LanguageModelV3CallOptions["prompt"]): any[] {
    for (let i = prompt.length - 1; i >= 0; i--) {
      if (prompt[i].role === "user") {
        const b = this.messageToBlocks(prompt[i], false);
        if (b.length) return b;
      }
    }
    return [{ type: "text", text: "" }];
  }

  private detectContinuation(
    prompt: LanguageModelV3CallOptions["prompt"],
  ): Array<{ toolCallId: string; result: unknown; output: any }> | null {
    const t = this.current;
    if (!t || (t.pendingTools.size === 0 && t.pendingPermissions.size === 0)) return null;
    const results: Array<{ toolCallId: string; result: unknown; output: any }> = [];
    for (const msg of prompt) {
      if (msg.role !== "tool" && msg.role !== "assistant") continue;
      for (const part of (msg as any).content as any[]) {
        if (part?.type === "tool-result" && (t.pendingTools.has(part.toolCallId) || t.pendingPermissions.has(part.toolCallId))) {
          results.push({ toolCallId: part.toolCallId, result: this.toMcpResult(part.output), output: part.output });
        }
      }
    }
    return results.length ? results : null;
  }

  /** A tool-result is an error/denial when its output type is error-* (OpenCode
   *  RejectedError) — used by the permission bridge to map approve vs reject. */
  private isErrorOutput(output: any): boolean {
    const ty = output?.type;
    return ty === "error-text" || ty === "error-json" || ty === "error";
  }

  private outputToText(output: any): string {
    if (!output) return "";
    if (output.type === "text" || output.type === "error-text") return String(output.value ?? "");
    if (output.type === "json" || output.type === "error-json") return JSON.stringify(output.value);
    if (output.type === "content") return (output.value as any[]).map((c) => (c.type === "text" ? c.text : "")).join("");
    return typeof output === "string" ? output : JSON.stringify(output);
  }

  private toMcpResult(output: any): unknown {
    const isErr = output?.type === "error-text" || output?.type === "error-json";
    return { content: [{ type: "text", text: this.outputToText(output) }], ...(isErr ? { isError: true } : {}) };
  }
}
