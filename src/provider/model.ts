// LanguageModelV3 orchestrator: backs an OpenCode model with the Claude Code ACP
// agent while keeping OpenCode as the tool executor ("OpenCode orquesta").
//
// Session strategy (efficiency + prompt caching):
//  - The AI SDK is stateless: OpenCode resends the FULL prompt every doStream.
//  - We keep a PERSISTENT ACP session PER CONVERSATION and send only what the
//    agent hasn't seen yet. The agent holds its own side (its answers + the
//    tool-results it received over MCP) and reuses Claude's prompt cache, which
//    lives and dies with the session — so NOT recreating the session is exactly
//    the same thing as preserving the cache.
//  - A session is recreated only when the history genuinely diverges (revert,
//    compaction) or when a creation-time parameter changes. A different agent,
//    a changed tool set or a new system prompt do NOT reset it.
//
// Tool flow: when the agent calls an MCP tool, the host fires onToolCall → we
// emit a `tool-call` with the REAL OpenCode tool name, finish `tool-calls`, and
// leave the MCP tools/call DEFERRED; the next doStream brings OpenCode's
// tool-result → we resolve it and the same agent turn continues. Text/thinking
// arriving while that stream is closed is BUFFERED, never dropped.
import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { randomBytes } from "node:crypto";
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
import { addAlwaysRule, evaluate as evaluateBridge } from "../plugin/bridge-rules.js";

const DEBUG = !!process.env.ACP_DEBUG;
const dbg = (m: string) => { if (DEBUG) process.stderr.write(`[acp-orchestrator] ${m}\n`); };
/** Always-on notices (session lifecycle) — the user needs these without ACP_DEBUG. */
const note = (m: string) => process.stderr.write(`[acp] ${m}\n`);

/** Max live conversations kept per model instance (LRU); older idle ones are torn down. */
const MAX_LIVE_SESSIONS = 8;
/** Cap on a foreign tool-result replayed as text during catch-up. */
const CATCHUP_RESULT_CHARS = 2000;
/** System-prompt blocks worth forwarding to the agent as FACTUAL context (never as
 *  a system prompt — that would make Anthropic bill the session as extra usage). */
const CONTEXT_TAGS = ["env", "available_references"];

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
  /** Key this state is filed under in `sessions` (ocSession ?? convKey). */
  key: string;
  host: McpHost;
  /** Prefix of every toolCallId minted by `host` — identifies OUR OWN calls. */
  idPrefix: string;
  sessionId: string;
  convKey: string;
  toolsKey: string;
  systemKey: string;
  /** Hash of creation params that force a fresh session if changed (thinking/systemPromptMode). */
  cfgKey: string;
  /** Runtime config already applied via setSessionMode/setSessionConfigOption (no reset needed). */
  appliedMode?: string;
  appliedEffort?: string;
  /** Mode REQUESTED on the previous turn. When the request itself changes (the user
   *  reselects the plan agent), `modeChangedByAgent` is cleared so the new request wins. */
  requestedMode?: string;
  /** Set once the AGENT switches its own mode mid-session (ExitPlanMode approved:
   *  plan → default/acceptEdits). Tells the bridge to stop re-forcing the agent's
   *  configured mode on later turns, so the plan-exit sticks and implementation proceeds. */
  modeChangedByAgent?: boolean;
  /** Last cumulative ACP usage for this session, to report per-turn deltas. */
  lastUsage?: any;
  /** OpenCode session id — kept so end-of-turn can persist `lastUsage` to the registry. */
  ocSession?: string;
  /** OpenCode agent driving this turn (`claude-code`, `claude-code-plan`, …), for logs
   *  and for the notice shown when the agent leaves plan mode on its own. */
  ocAgent?: string;
  /** One key per NON-SYSTEM message the ACP agent has already been told about.
   *  Comparing this against the incoming prompt distinguishes a normal append from
   *  a REVERT (prompt is a strict prefix) or a compaction (histories diverge). */
  sentKeys: string[];
  /** Factual context (OpenCode's `<env>` …) already sent, to send only deltas after. */
  lastContextBlock?: string;
  controller: StreamController | null;
  /** Stream parts produced while no controller was attached (the stream is closed
   *  between a tool-call and its continuation). Flushed into the next controller —
   *  dropping them is what truncated text and hid the reasoning block. */
  pending: LanguageModelV3StreamPart[];
  pendingTools: Set<string>;
  /** Permission bridge: question toolCallId → resolver of the deferred ACP
   *  requestPermission. The agent waits on the Promise while the user answers
   *  the `question` dialog; the tool-result (allow/deny) resolves it. */
  pendingPermissions: Map<string, (verdict: PermissionVerdict) => void>;
  textId: string | null;
  reasoningId: string | null;
  cancelWatchdog: ReturnType<typeof setTimeout> | null;
  lastActive: number;
}

/** Mutable handle so the stream's `cancel` callback can reach the state that
 *  `onStart` resolves asynchronously. */
interface TurnRef { t: TurnState | null }

interface Continuation {
  t: TurnState;
  results: Array<{ toolCallId: string; result: unknown; output: any }>;
}

/** What the user answered in the bridged permission dialog. `always` persists an
 *  allow-rule (see bridge-rules.ts); anything ambiguous resolves as a denial. */
interface PermissionVerdict {
  approved: boolean;
  always: boolean;
}

/** Dialog labels — also the strings the verdict parser looks for (see `questionVerdict`). */
const ALLOW_ONCE = "Allow once";
const ALWAYS_ALLOW = "Always allow";
const DENY = "Deny";

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
  /** Live conversations, keyed by OpenCode sessionID (or the conversation hash).
   *  ONE state per conversation: a single shared state made two open chats — or a
   *  subagent — tear each other's session down and replay the history every turn. */
  private readonly sessions = new Map<string, TurnState>();
  /** Same states indexed by ACP sessionId, to route agent-initiated callbacks. */
  private readonly byAcpSession = new Map<string, TurnState>();
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
    const ref: TurnRef = { t: continuation?.t ?? null };
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (controller) => void this.onStart(controller, options, continuation, ref),
      cancel: () => this.onCancel(ref),
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
    continuation: Continuation | null,
    ref: TurnRef,
  ) {
    try {
      controller.enqueue({ type: "stream-start", warnings: [] });

      // (1) Continuation of a deferred tool-call OR a bridged permission — resume
      // the same agent turn.
      if (continuation) {
        const t = continuation.t;
        ref.t = t;
        this.clearCancelWatchdog(t); // the turn DID continue — disarm the abort timer
        t.controller = controller;
        t.lastActive = Date.now();
        // Everything in this prompt is already known to the agent: its own tool-calls
        // and the results it will receive right now. Recording them here is what stops
        // the next turn from replaying whole file/shell outputs it already has.
        t.sentKeys = this.history(options.prompt).map((m) => this.msgKey(m));
        // Text/thinking that arrived while the stream was closed goes out FIRST, in
        // order, so nothing the agent said before calling the tool is lost.
        this.flushPending(t);
        for (const { toolCallId, result, output } of continuation.results) {
          const permResolve = t.pendingPermissions.get(toolCallId);
          if (permResolve) {
            // Permission bridge: the user's `question` answer came back as the
            // tool-result → resolve the deferred requestPermission.
            t.pendingPermissions.delete(toolCallId);
            permResolve(this.questionVerdict(output));
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
      const po = this.providerOptions(options);
      const ocSession: string | undefined = po.ocSession;
      const convKey = hashText(this.firstUserText(options.prompt));
      const toolsKey = tools.map((x) => x.name).sort().join(",");
      // The system prompt is part of the session identity ONLY when it actually
      // travels. Under the default `preset` mode OpenCode's system is never sent
      // (see buildSystemPromptMeta), so hashing it would tear the session down —
      // and replay the whole history — every time OpenCode swaps agents or its
      // dynamic blocks (date, AGENTS.md, skills) shift. The factual part of that
      // system is forwarded separately as user context (see contextBlocks).
      const systemMode = ctrl.systemPromptMode ?? "preset";
      const systemKey = systemMode === "preset" ? "preset" : hashText(this.systemText(options.prompt));
      // Params baked into newSession's _meta (thinking/systemPromptMode) can't change
      // mid-session → a change forces a fresh session. mode/effort are applied at
      // runtime via set_mode/set_config_option instead (no reset needed).
      const cfgKey = hashText(JSON.stringify({ t: ctrl.thinking, s: systemMode }));
      const hist = this.history(options.prompt);
      const keys = hist.map((m) => this.msgKey(m));

      // OpenCode's title/summary call arrives on the same model and session but with
      // NO tools. Give it a throwaway session instead of letting it evict the real
      // conversation. Only when the live conversation DOES have tools — a genuinely
      // tool-less conversation (programmatic use) must keep reusing its own session.
      const baseKey = ocSession ?? convKey;
      const live = this.sessions.get(baseKey);
      const key = tools.length === 0 && live && live.toolsKey !== "" ? `${baseKey}:notools` : baseKey;

      let t = this.sessions.get(key);
      if (t && t.convKey !== convKey) { this.endTurn(t); t = undefined; } // key reused for another conversation

      // (2) Reuse the live session whenever we can — this is what keeps the cache warm.
      if (t) {
        let drop: string | null = null;
        if (t.systemKey !== systemKey) drop = "system prompt changed";
        else if (t.cfgKey !== cfgKey) drop = "creation config changed";
        if (!drop) {
          // A changed tool set is applied to the LIVE session (MCP list_changed)
          // rather than forcing a new one.
          if (t.toolsKey !== toolsKey) {
            t.host.setTools(tools);
            t.host.notifyToolsChanged();
            t.toolsKey = toolsKey;
            dbg(`tools changed (${tools.length}) — refreshed in place, session kept`);
          }
          const cls = this.classifyHistory(t, keys);
          if (cls.kind !== "append") {
            drop = cls.kind === "revert" ? "history reverted" : "history diverged (compaction/rollback)";
          } else {
            const live = t;
            ref.t = live;
            dbg(`reuse session ${live.sessionId} — ${keys.length - cls.fromIndex} new msg(s) (cache-friendly)`);
            // A fresh user turn: drop any deferred state left by a prior turn that was
            // abandoned (continuation never arrived) so it can't hang or leak.
            this.clearCancelWatchdog(live);
            this.drainPermissions(live);
            live.pendingTools.clear();
            live.controller = controller;
            live.lastActive = Date.now();
            if (ocSession) live.ocSession = ocSession;
            if (po.ocAgent) live.ocAgent = String(po.ocAgent);
            this.flushPending(live);
            await this.applySessionConfig(live, ctrl);
            const tail = hist.slice(cls.fromIndex);
            const blocks = [
              ...this.contextBlocks(live, options.prompt, ctrl),
              ...(tail.length ? this.blocksFor(tail, live) : this.lastUserBlocks(options.prompt)),
            ];
            live.sentKeys = keys;
            if (ocSession) setLink(ocSession, live.sessionId, hist.length, convKey);
            this.connection
              .prompt({ sessionId: live.sessionId, prompt: blocks })
              .then((resp: any) => this.onPromptDone(live, resp))
              .catch((err: any) => this.onPromptError(live, err));
            return;
          }
        }
        dbg(`dropping session ${t.sessionId} — ${drop}`);
        this.endTurn(t);
        t = undefined;
      }

      // (3) Need a session: new conversation, or the history diverged, or a
      // resumable session from a new process. Set up the MCP host once.
      // Unique per-host prefix so minted toolCallIds NEVER collide with ids from a
      // previous session still present in OpenCode's replayed history (a fresh host is
      // created on every session reset). A random nonce is robust across resets, process
      // restarts and resume — unlike a per-host counter, which restarts at 0.
      const idPrefix = `acp_${randomBytes(5).toString("hex")}_`;
      const host = new McpHost("opencode", idPrefix);
      await host.start();
      host.setTools(tools);
      const serverConfig = host.getServerConfig();

      // Try to RESUME a registered Claude Code session (new process, no live state,
      // history grew rather than diverged) → no history replay (saves tokens). Else
      // create a fresh session and replay the full history.
      const resumeId: string | undefined = po.resumeId;
      const resumeLen: number = typeof po.resumeLen === "number" ? po.resumeLen : 0;
      let sessionId: string | undefined;
      let replayFull = true;
      if (DEBUG && po.resumeConvKey && po.resumeConvKey !== convKey) {
        dbg(`resumeConvKey mismatch (registry=${po.resumeConvKey} current=${convKey}) — resuming anyway`);
      }
      if (resumeId && resumeLen > 0 && hist.length > resumeLen) {
        try {
          await this.connection.unstable_resumeSession({
            sessionId: resumeId,
            cwd: this.config.cwd ?? process.cwd(),
            mcpServers: [serverConfig],
            // Re-apply the clean-brain options on resume too. Without this the agent
            // falls back to its defaults (--tools default, --setting-sources=user,
            // project,local, no --strict-mcp-config) and the resumed session regains
            // native tools + the claude.ai connectors.
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
        const sysMeta = this.buildSystemPromptMeta(options.prompt, systemMode);
        if (sysMeta !== undefined) meta.systemPrompt = sysMeta;
        const session = await this.connection.newSession({
          cwd: this.config.cwd ?? process.cwd(),
          mcpServers: [serverConfig],
          _meta: meta,
        });
        sessionId = session.sessionId;
        dbg(`model=${session.models?.currentModelId ?? "?"} (requested: ${ctrl.model ?? "default"}, mode: ${ctrl.mode ?? "default"}, effort: ${ctrl.effort ?? "default"}) — tools(${tools.length})`);
      }

      if (!sessionId) throw new Error("failed to create or resume an ACP session");
      // The ACP sessionId IS the Claude Code session id: surfacing it lets the user
      // pick the conversation back up natively.
      note(`session ${sessionId}${replayFull ? "" : " (resumed)"} — retomable con: claude --resume ${sessionId}`);

      t = {
        key,
        host,
        idPrefix,
        sessionId,
        convKey,
        toolsKey,
        systemKey,
        cfgKey,
        ocSession,
        ocAgent: po.ocAgent ? String(po.ocAgent) : undefined,
        // Resume path: seed the cumulative usage snapshot from the persisted
        // registry so the first post-resume `subtractUsage` produces a real
        // turn delta instead of the full cumulative.
        lastUsage: replayFull ? undefined : po.resumeLastUsage,
        // Full replay covers the whole history; a bare resume only covers up to what
        // the registry last recorded — the rest still needs sending below.
        sentKeys: replayFull ? [] : keys.slice(0, resumeLen),
        controller,
        pending: [],
        pendingTools: new Set(),
        pendingPermissions: new Map(),
        textId: null,
        reasoningId: null,
        cancelWatchdog: null,
        lastActive: Date.now(),
      };
      ref.t = t;
      host.onToolCall((c) => this.onToolCall(t!, c));
      this.sessions.set(key, t);
      this.byAcpSession.set(sessionId, t);
      this.evictIdleSessions();
      await this.applySessionConfig(t, ctrl);
      if (ocSession) setLink(ocSession, sessionId, hist.length, convKey);
      const tail = replayFull ? hist : hist.slice(resumeLen);
      if (DEBUG && !replayFull) dbg(`resume — catch-up ${tail.length} msg(s)`);
      const promptBlocks = [
        ...this.contextBlocks(t, options.prompt, ctrl),
        ...(tail.length ? this.blocksFor(tail, t) : [{ type: "text", text: "" }]),
      ];
      t.sentKeys = keys;

      const started = t;
      this.connection
        .prompt({ sessionId, prompt: promptBlocks })
        .then((resp: any) => this.onPromptDone(started, resp))
        .catch((err: any) => this.onPromptError(started, err));
    } catch (err) {
      dbg(`onStart error: ${err instanceof Error ? err.message : String(err)}`);
      try { controller.enqueue({ type: "error", error: err }); } catch { /* ignore */ }
      try { controller.close(); } catch { /* ignore */ }
    }
  }

  /** Enqueue if a stream is attached; otherwise BUFFER. The stream is closed between
   *  a tool-call and its continuation, and text/thought chunks keep arriving on the
   *  (independent) ACP stdio channel meanwhile — dropping them truncated answers and
   *  hid the reasoning block entirely. */
  private emit(t: TurnState, part: LanguageModelV3StreamPart) {
    if (t.controller) {
      try { t.controller.enqueue(part); return; } catch { /* closed underneath us */ }
    }
    t.pending.push(part);
  }

  private flushPending(t: TurnState) {
    if (!t.controller || t.pending.length === 0) return;
    const parts = t.pending;
    t.pending = [];
    dbg(`flushing ${parts.length} buffered chunk(s) into the continuation stream`);
    for (const p of parts) {
      try { t.controller.enqueue(p); } catch { /* ignore */ }
    }
  }

  private onPromptDone(t: TurnState, resp: { stopReason?: string; usage?: any }) {
    if (!t.controller) return; // cut for a pending tool-call
    this.closeBlocks(t);
    this.flushPending(t);
    const turn = subtractUsage(resp?.usage, t.lastUsage); // ACP usage is cumulative per session
    if (resp?.usage) {
      t.lastUsage = resp.usage;
      if (t.ocSession) updateUsage(t.ocSession, resp.usage); // survive process restarts
    }
    if (DEBUG && turn) dbg(`usage(turn): in=${turn.inputTokens} out=${turn.outputTokens} cacheR=${turn.cachedReadTokens} cacheW=${turn.cachedWriteTokens}`);
    try {
      t.controller.enqueue({
        type: "finish",
        usage: mapUsage(turn),
        finishReason: { unified: resp?.stopReason === "max_tokens" ? "length" : "stop", raw: resp?.stopReason },
      });
      t.controller.close();
    } catch { /* ignore */ }
    t.controller = null; // keep the session for the next turn (delta)
  }

  private onPromptError(t: TurnState, err: unknown) {
    if (!t.controller) return;
    dbg(`prompt error: ${err instanceof Error ? err.message : String(err)}`);
    try {
      t.controller.enqueue({ type: "error", error: err });
      t.controller.close();
    } catch { /* ignore */ }
    t.controller = null;
  }

  /** Fired by the MCP host when the agent calls an OpenCode tool. */
  private onToolCall(t: TurnState, call: { toolCallId: string; name: string; args: Record<string, unknown> }) {
    if (!t.controller) return;
    dbg(`agent → tool-call ${call.name} (${call.toolCallId}) → emit to OpenCode`);
    this.closeBlocks(t);
    t.pendingTools.add(call.toolCallId);
    const inputJson = JSON.stringify(call.args ?? {});
    this.emit(t, { type: "tool-input-start", id: call.toolCallId, toolName: call.name });
    this.emit(t, { type: "tool-input-delta", id: call.toolCallId, delta: inputJson });
    this.emit(t, { type: "tool-input-end", id: call.toolCallId });
    this.emit(t, { type: "tool-call", toolCallId: call.toolCallId, toolName: call.name, input: inputJson });
    this.emit(t, { type: "finish", usage: emptyUsage(), finishReason: { unified: "tool-calls", raw: "tool_use" } });
    try { t.controller?.close(); } catch { /* ignore */ }
    t.controller = null; // DO NOT resolve yet — wait for the continuation doStream
  }

  // ---- permission bridge -----------------------------------------------------

  /** Map approve/reject to one of the options the agent offered (by kind/optionId). */
  private permOutcome(params: any, approved: boolean): { outcome: any } {
    const opts: any[] = params?.options ?? [];
    if (!opts.length) return { outcome: { outcome: "cancelled" } };
    if (!approved) {
      const rej = opts.find((o) => o.kind === "reject_once" || o.kind === "reject_always" || o.optionId === "reject");
      return rej ? { outcome: { outcome: "selected", optionId: rej.optionId } } : { outcome: { outcome: "cancelled" } };
    }
    // Approving an ExitPlanMode must NOT silently hand out bypass/auto. The agent
    // offers, in order, `bypassPermissions`, `auto`, `acceptEdits`, `default` — and
    // picking the first `allow_*` would grant the broadest one. Approving a plan means
    // "go ahead, still asking me about edits" → prefer `default`.
    if (params?.toolCall?.kind === "switch_mode") {
      const safe = opts.find((o) => o.optionId === "default") ?? opts.find((o) => o.optionId === "acceptEdits");
      if (safe) return { outcome: { outcome: "selected", optionId: safe.optionId } };
    }
    const opt = opts.find((o) => o.kind === "allow_once" || o.kind === "allow_always" || o.optionId === "allow") ?? opts[0];
    return opt ? { outcome: { outcome: "selected", optionId: opt.optionId } } : { outcome: { outcome: "cancelled" } };
  }

  /** Tool name the agent wants permission for. The ACP toolCall carries NO bare
   *  name — `title` is a human label like "Read /path", "Write /path", "Skill" — so
   *  we take the first token. This becomes the permission key, so per-tool rules
   *  (`permission: { Read: … }`) match. The full title travels separately as metadata. */
  private permToolName(toolCall: any): string {
    // ExitPlanMode surfaces as a `switch_mode` permission — give it a stable, rule-able
    // name so the prompt reads clearly and `permission: { ExitPlanMode: … }` matches.
    if (toolCall?.kind === "switch_mode") return "ExitPlanMode";
    const title = String(toolCall?.title ?? "").trim();
    return title.split(/\s+/)[0] || String(toolCall?.kind ?? "") || "tool";
  }

  /** Extract the markdown plan from an ExitPlanMode (`switch_mode`) tool call: it rides
   *  in `rawInput.plan`, with the tool-call text content as a fallback. */
  private planText(toolCall: any): string {
    const raw = toolCall?.rawInput;
    if (raw && typeof raw === "object" && typeof (raw as any).plan === "string") return (raw as any).plan;
    const content: any[] = Array.isArray(toolCall?.content) ? toolCall.content : [];
    return content
      .map((c) => (c?.type === "content" && c.content?.type === "text" ? c.content.text : typeof c?.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
  }

  /** ACP requestPermission → the agent's own rules first, then the `question` dialog.
   *  Deferred: returns a Promise the agent awaits until the verdict comes back as
   *  the `question` tool-result (resolved in onStart's continuation branch). */
  private onRequestPermission(params: any): Promise<{ outcome: any }> {
    const t = this.byAcpSession.get(String(params?.sessionId ?? ""));
    // No live turn/controller → approve so the agent never hangs.
    if (!t || !t.controller) return Promise.resolve(this.permOutcome(params, true));
    const toolCall = params?.toolCall;
    const native = this.permToolName(toolCall);
    const target = this.bridgeTarget(toolCall);
    const agent = t.ocAgent ?? "default";
    // (1) allow/deny rules answer outright — no dialog, same as a native tool
    // OpenCode would resolve itself.
    const rules = evaluateBridge(agent, native, target.pattern);
    dbg(`requestPermission(${native} → ${target.pattern}) agent=${agent} rules=${rules}`);
    if (rules === "allow") return Promise.resolve(this.permOutcome(params, true));
    if (rules === "deny") return Promise.resolve(this.permOutcome(params, false));
    // (2) "ask": raise a `question` dialog and wait for its tool-result.
    const callId = `perm_${++this.idSeq}`;
    dbg(`requestPermission(${native}) → bridge as question (${callId})`);
    return new Promise<{ outcome: any }>((resolve) => {
      t.pendingPermissions.set(callId, (verdict: PermissionVerdict) => {
        if (verdict.approved && verdict.always && target.always) addAlwaysRule(agent, native, target.always);
        resolve(this.permOutcome(params, verdict.approved));
      });
      this.emitPermissionCall(t, callId, toolCall, native, target);
    });
  }

  /** Action target of a native request (command / skill / path), plus the glob an
   *  "Always allow" would persist. Shell commands collapse to their first token
   *  (`git status` → `git *`); a request with no real target persists nothing, so
   *  the dialog never offers a broad rule that would auto-approve everything. */
  private bridgeTarget(toolCall: any): { pattern: string; always?: string } {
    const raw: any = toolCall?.rawInput;
    const inp = raw && typeof raw === "object" ? raw : {};
    const text = String(
      (inp.command ?? inp.skill ?? inp.name ?? inp.notebook_path ?? inp.file_path ?? inp.path) ||
      (typeof raw === "string" ? raw : "") ||
      toolCall?.title ||
      "",
    ).trim();
    const always =
      toolCall?.kind === "execute" && text.includes(" ") ? `${text.split(/\s+/)[0]} *` : text || undefined;
    return { pattern: text || "*", always };
  }

  /** Emit a `question` tool-call to OpenCode (same deferred pattern as a real
   *  tool-call): the native tool's request becomes a dialog — Allow once /
   *  Always allow / Deny — and the answer arrives as the tool-result on the next
   *  doStream. The agent itself only ever sees the ACP permission outcome. */
  private emitPermissionCall(
    t: TurnState,
    callId: string,
    toolCall: any,
    native: string,
    target: { pattern: string; always?: string },
  ) {
    if (!t.controller) return;
    this.closeBlocks(t);
    // ExitPlanMode (switch_mode): render the PLAN as visible assistant text before the
    // approval prompt — otherwise it's only buried in the permission metadata and the
    // user would approve blind. Presenting the plan for approval IS the point of the tool.
    if (toolCall?.kind === "switch_mode") {
      const plan = this.planText(toolCall);
      if (plan) {
        const id = `plan${++this.idSeq}`;
        this.emit(t, { type: "text-start", id });
        this.emit(t, { type: "text-delta", id, delta: plan });
        this.emit(t, { type: "text-end", id });
      }
    }
    const input = JSON.stringify({
      questions: [
        {
          question: `${native}: ${toolCall?.title ?? target.pattern}`,
          header: "Permission",
          options: [
            { label: ALLOW_ONCE, description: "Approve this action for this call only" },
            ...(target.always
              ? [{ label: ALWAYS_ALLOW, description: `Approve and stop asking for ${target.always}` }]
              : []),
            { label: DENY, description: "Block this action" },
          ],
        },
      ],
    });
    this.emit(t, { type: "tool-input-start", id: callId, toolName: "question" });
    this.emit(t, { type: "tool-input-delta", id: callId, delta: input });
    this.emit(t, { type: "tool-input-end", id: callId });
    this.emit(t, { type: "tool-call", toolCallId: callId, toolName: "question", input });
    this.emit(t, { type: "finish", usage: emptyUsage(), finishReason: { unified: "tool-calls", raw: "tool_use" } });
    try { t.controller?.close(); } catch { /* ignore */ }
    t.controller = null;
  }

  /** Fired by the ACP client on session/update. */
  private onSessionUpdate(params: any) {
    const t = this.byAcpSession.get(String(params?.sessionId ?? ""));
    if (!t) return;
    const update = params?.update;
    // Mode switch (e.g. ExitPlanMode approved: plan → default). Track it even without a
    // live controller so the bridge stays in sync and won't re-force the agent's
    // configured mode on the next turn (which would undo the plan-exit).
    if (update?.sessionUpdate === "current_mode_update") {
      if (update.currentModeId) {
        const from = t.appliedMode ?? "?";
        t.appliedMode = String(update.currentModeId);
        t.modeChangedByAgent = true;
        dbg(`current_mode_update → ${t.appliedMode}`);
        // Make it visible: the session's mode just changed under the user's feet, and
        // OpenCode still shows whatever agent they picked. The two agents share the
        // same tool profile, so this is informational, not a call to action.
        const id = `mode${++this.idSeq}`;
        this.emit(t, { type: "text-start", id });
        this.emit(t, { type: "text-delta", id, delta: `\n_Modo de sesión: ${from} → ${t.appliedMode}_\n` });
        this.emit(t, { type: "text-end", id });
      }
      return;
    }
    switch (update?.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content?.type === "text") {
          if (!t.textId) { t.textId = `t${++this.idSeq}`; this.emit(t, { type: "text-start", id: t.textId }); }
          this.emit(t, { type: "text-delta", id: t.textId, delta: update.content.text });
        }
        break;
      case "agent_thought_chunk":
        if (update.content?.type === "text") {
          if (!t.reasoningId) { t.reasoningId = `r${++this.idSeq}`; this.emit(t, { type: "reasoning-start", id: t.reasoningId }); }
          this.emit(t, { type: "reasoning-delta", id: t.reasoningId, delta: update.content.text });
        }
        break;
      default:
        break; // tool_call/tool_call_update are informational; MCP host drives emission
    }
  }

  private closeBlocks(t: TurnState) {
    if (t.textId) { this.emit(t, { type: "text-end", id: t.textId }); t.textId = null; }
    if (t.reasoningId) { this.emit(t, { type: "reasoning-end", id: t.reasoningId }); t.reasoningId = null; }
  }

  private endTurn(t: TurnState) {
    this.clearCancelWatchdog(t);
    // Settle any deferred permission requests (deny/cancel) so the agent never
    // stays blocked awaiting a verdict that will no longer arrive.
    this.drainPermissions(t);
    try { if (this.connection && t.sessionId) this.connection.cancel?.({ sessionId: t.sessionId }); } catch { /* ignore */ }
    t.host.stop();
    if (this.sessions.get(t.key) === t) this.sessions.delete(t.key);
    this.byAcpSession.delete(t.sessionId);
  }

  /** Keep at most MAX_LIVE_SESSIONS conversations alive; tear down the oldest idle ones
   *  (never one with work in flight) so hosts and agent sessions don't pile up. */
  private evictIdleSessions() {
    if (this.sessions.size <= MAX_LIVE_SESSIONS) return;
    const idle = [...this.sessions.values()]
      .filter((s) => !s.controller && s.pendingTools.size === 0 && s.pendingPermissions.size === 0)
      .sort((a, b) => a.lastActive - b.lastActive);
    while (this.sessions.size > MAX_LIVE_SESSIONS && idle.length) {
      const victim = idle.shift()!;
      dbg(`evicting idle session ${victim.sessionId} (LRU)`);
      this.endTurn(victim);
    }
  }

  /** Resolve every outstanding bridged permission as denied so the agent unblocks. */
  private drainPermissions(t: TurnState) {
    if (t.pendingPermissions.size === 0) return;
    const denied: PermissionVerdict = { approved: false, always: false };
    for (const resolve of [...t.pendingPermissions.values()]) { try { resolve(denied); } catch { /* ignore */ } }
    t.pendingPermissions.clear();
  }

  /** Per-call provider options: V2 nests them under `providerOptionKey(package,
   *  providerID)` = the providerID, but a canonical/custom id would key them
   *  differently → fall back to the first object entry so any registration works. */
  private providerOptions(options: LanguageModelV3CallOptions): Record<string, any> {
    const all = (options.providerOptions ?? {}) as Record<string, unknown>;
    const own = all[this.provider];
    if (own && typeof own === "object") return own as Record<string, any>;
    for (const value of Object.values(all)) {
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
    }
    return {};
  }

  /** Provider config overlaid with per-call `providerOptions.acp` (per-agent mode/effort/…). */
  private effectiveCtrl(options: LanguageModelV3CallOptions): ClaudeCodeControl {
    const ctrl: ClaudeCodeControl = { ...(this.config.claudeCode ?? {}) };
    const po = this.providerOptions(options);
    if (po && typeof po === "object") {
      // Per-agent overrides from `agent.<name>.options` (→ providerOptions.acp):
      // mode/effort/reasoning plus the native-feature toggles.
      const KEYS = [
        "mode", "effort", "thinking", "systemPromptMode", "forwardEnvContext",
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
    // A CHANGED request (the user reselected the plan agent) overrides a mode the agent
    // set for itself. Without this reset an ExitPlanMode would permanently pin the
    // session out of plan mode, and going back to the plan agent would do nothing.
    if (ctrl.mode !== t.requestedMode) {
      t.requestedMode = ctrl.mode;
      t.modeChangedByAgent = false;
    }
    // Don't re-force the configured mode once the agent switched it itself (ExitPlanMode):
    // the user approved leaving plan mode, so the next turn must not snap back to plan.
    if (ctrl.mode && ctrl.mode !== t.appliedMode && !t.modeChangedByAgent) {
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
      } catch (e) {
        // Not a debug detail: a rejected effort means the user picked `:max` and is
        // silently getting something else — including no visible reasoning.
        note(`aviso: no se pudo aplicar effort=${ctrl.effort} (${e instanceof Error ? e.message : String(e)})`);
      }
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
        // Keep the whole params object: `sessionId` is what routes the update to the
        // right conversation now that several can be live at once.
        async sessionUpdate(params: any) { self.onSessionUpdate(params); },
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

  private onCancel(ref: TurnRef) {
    const t = ref.t;
    if (!t) return;
    // A stream cancel WHILE a tool-call or permission is deferred is OpenCode
    // PAUSING (e.g. to show a permission prompt), not a real abort — tearing the
    // host down here kills the pending tools/call with "host closed". Keep the
    // session/host alive; the continuation doStream resolves them. A WATCHDOG
    // guarantees teardown if the continuation never arrives (session truly aborted,
    // prompt dropped) so the agent can't hang forever.
    if (t.pendingTools.size > 0 || t.pendingPermissions.size > 0) {
      dbg("onCancel ignored — deferred tool-call/permission in flight (likely a permission pause)");
      this.armCancelWatchdog(t);
      return;
    }
    // A plain cancel ends the TURN, not the conversation: keep the session (and its
    // prompt cache) so the next message continues where this one stopped.
    try { this.connection?.cancel?.({ sessionId: t.sessionId }); } catch { /* ignore */ }
    t.controller = null;
    this.closeBlocks(t);
  }

  /** If a cancel was ignored (deferred work in flight) but no continuation comes,
   *  force teardown so the agent doesn't stay blocked. Cleared by a continuation. */
  private armCancelWatchdog(t: TurnState) {
    this.clearCancelWatchdog(t);
    t.cancelWatchdog = setTimeout(() => {
      t.cancelWatchdog = null;
      dbg("cancel watchdog fired — no continuation arrived; tearing down");
      this.endTurn(t);
    }, this.config.streamCloseTimeoutMs ?? 600_000);
    t.cancelWatchdog.unref?.();
  }

  private clearCancelWatchdog(t: TurnState) {
    if (t.cancelWatchdog) { clearTimeout(t.cancelWatchdog); t.cancelWatchdog = null; }
  }

  cleanup() {
    for (const t of [...this.sessions.values()]) this.endTurn(t);
    this.sessions.clear();
    this.byAcpSession.clear();
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
          description: this.toolDescription((t as any).name, (t as any).description),
          inputSchema: (t as any).inputSchema ?? { type: "object", properties: {} },
        });
      }
    }
    return out;
  }

  /** Nudges the agent can only get from the tool description. Under the default
   *  `systemPromptMode: "preset"` OpenCode's system prompt never reaches the agent,
   *  so the instruction that would normally push it toward `question` is missing —
   *  and its own `AskUserQuestion` is disabled by the ACP agent. Without this the
   *  agent silently assumes instead of asking. A tool description is NOT a system
   *  prompt, so this doesn't affect how Anthropic bills the session. */
  private toolDescription(name: string, description?: string): string | undefined {
    if (name === "question") {
      return `${description ?? ""}\n\nIMPORTANT: this is the ONLY way to ask the user something — the native AskUserQuestion tool is unavailable here. Use it whenever the request is ambiguous or a decision is the user's to make, instead of assuming.`.trim();
    }
    return description;
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

  /** The conversation proper: system messages are excluded because they're forwarded
   *  separately (or not at all) and OpenCode rewrites them every turn — including them
   *  would make every history comparison look like a divergence. */
  private history(prompt: LanguageModelV3CallOptions["prompt"]): any[] {
    return (prompt as any[]).filter((m) => m.role !== "system");
  }

  /** Cheap, stable per-message identity. Deliberately keyed on tool-call IDs rather
   *  than payloads: it must survive re-serialization but change if the turn changes. */
  private msgKey(msg: any): string {
    let body = "";
    if (typeof msg.content === "string") body = msg.content;
    else if (Array.isArray(msg.content)) {
      for (const p of msg.content) {
        if (p?.type === "text") body += `t:${p.text}`;
        else if (p?.type === "tool-call") body += `c:${p.toolCallId}`;
        else if (p?.type === "tool-result") body += `r:${p.toolCallId}`;
        else if (p?.type === "file") body += `f:${p.filename ?? p.mediaType ?? ""}`;
        else body += `?${p?.type}`;
      }
    }
    return `${msg.role}:${hashText(body)}`;
  }

  /** How the incoming history relates to what the agent already knows.
   *   - append   → normal turn (or another agent ran turns meanwhile): send the tail.
   *   - revert   → the user rewound: the agent can't unremember, so it needs a new session.
   *   - diverged → compaction/rollback replaced the middle: same, a new session. */
  private classifyHistory(t: TurnState, keys: string[]): { kind: "append" | "revert" | "diverged"; fromIndex: number } {
    const sent = t.sentKeys;
    let i = 0;
    while (i < sent.length && i < keys.length && sent[i] === keys[i]) i++;
    if (i === sent.length) return { kind: "append", fromIndex: i };
    if (i === keys.length) return { kind: "revert", fromIndex: i };
    return { kind: "diverged", fromIndex: i };
  }

  private blocksFor(msgs: any[], t: TurnState | null): any[] {
    const blocks: any[] = [];
    for (const msg of msgs) blocks.push(...this.messageToBlocks(msg, true, t));
    return blocks;
  }

  private messageToBlocks(msg: any, withPrefix: boolean, t: TurnState | null): any[] {
    const prefixes: Record<string, string> = { system: "System: ", assistant: "Assistant: ", tool: "", user: "" };
    const prefix = withPrefix ? (prefixes[msg.role] ?? "") : "";
    if (typeof msg.content === "string") return [{ type: "text", text: `${prefix}${msg.content}` }];
    const blocks: any[] = [];
    let first = true;
    for (const part of msg.content as any[]) {
      const px = first ? prefix : "";
      // OUR OWN tool traffic: the agent already holds these in its session (they came
      // back over MCP). Replaying them as text duplicated whole file/shell outputs on
      // every turn and blew the prompt cache — by far the biggest token sink.
      if ((part.type === "tool-call" || part.type === "tool-result") && t && String(part.toolCallId ?? "").startsWith(t.idPrefix)) continue;
      if (part.type === "text") { blocks.push({ type: "text", text: px + part.text }); first = false; }
      else if (part.type === "tool-call") { blocks.push({ type: "text", text: `${px}[Called tool ${part.toolName}(${JSON.stringify(part.input)})]` }); first = false; }
      else if (part.type === "tool-result") { blocks.push({ type: "text", text: `${px}[Tool ${part.toolName} result: ${this.truncate(this.outputToText(part.output))}]` }); first = false; }
      else if (part.type === "file") {
        const fb = this.fileToBlock(part);
        blocks.push(fb ?? { type: "text", text: `${px}[Attachment ${part.mediaType ?? "file"} not supported by the agent]` });
        first = false;
      }
    }
    return blocks;
  }

  /** A foreign tool-result is replayed only so the agent can follow the thread —
   *  the full payload isn't worth the tokens. */
  private truncate(s: string): string {
    return s.length <= CATCHUP_RESULT_CHARS ? s : `${s.slice(0, CATCHUP_RESULT_CHARS)}…[truncado, ${s.length} chars]`;
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

  /** The FACTUAL part of OpenCode's system prompt: where we are, what the workspace is,
   *  what references exist. Under `preset` the system prompt itself never reaches the
   *  agent (forwarding it would get the session billed as extra usage), but this
   *  context is genuinely useful and carries no instructions, so it rides along as
   *  user content instead. Everything else — OpenCode's behavioural instructions,
   *  AGENTS.md (the agent loads it itself via projectMemory), MCP/skill catalogues —
   *  is deliberately left out. */
  private extractContextBlock(prompt: LanguageModelV3CallOptions["prompt"]): string {
    const sys = this.systemText(prompt);
    if (!sys) return "";
    const out: string[] = [];
    for (const tag of CONTEXT_TAGS) {
      const m = sys.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`));
      if (m) out.push(m[0]);
    }
    return out.join("\n");
  }

  /** Send the context block once per session, then only what changed. Appending a
   *  small delta at the END of the conversation is cache-safe (the cached prefix is
   *  untouched); resending the whole block every turn would not be. */
  private contextBlocks(t: TurnState, prompt: LanguageModelV3CallOptions["prompt"], ctrl: ClaudeCodeControl): any[] {
    if (ctrl.forwardEnvContext === false) return [];
    const block = this.extractContextBlock(prompt);
    if (!block) return [];
    if (!t.lastContextBlock) {
      t.lastContextBlock = block;
      // The time is included only here: OpenCode's <env> is day-granular, and a
      // per-turn clock update would be pure noise.
      const now = new Date();
      return [{
        type: "text",
        text: `<opencode_context>\n${block}\n  Session started: ${now.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})\n</opencode_context>`,
      }];
    }
    const prev = new Set(t.lastContextBlock.split("\n").map((l) => l.trim()).filter(Boolean));
    const changed = block.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("<") && !prev.has(l));
    t.lastContextBlock = block;
    if (!changed.length) return [];
    dbg(`context delta (${changed.length} line(s))`);
    return [{ type: "text", text: `<opencode_context_update>\n${changed.join("\n")}\n</opencode_context_update>` }];
  }

  /** Only the last user message (delta for a persistent session). */
  private lastUserBlocks(prompt: LanguageModelV3CallOptions["prompt"]): any[] {
    for (let i = prompt.length - 1; i >= 0; i--) {
      if (prompt[i].role === "user") {
        const b = this.messageToBlocks(prompt[i], false, null);
        if (b.length) return b;
      }
    }
    return [{ type: "text", text: "" }];
  }

  /** Find the live conversation whose deferred tool-calls/permissions this prompt
   *  answers. Scoped per session, so two concurrent chats can't cross-resolve. */
  private detectContinuation(prompt: LanguageModelV3CallOptions["prompt"]): Continuation | null {
    for (const t of this.sessions.values()) {
      if (t.pendingTools.size === 0 && t.pendingPermissions.size === 0) continue;
      const results: Array<{ toolCallId: string; result: unknown; output: any }> = [];
      for (const msg of prompt) {
        if (msg.role !== "tool" && msg.role !== "assistant") continue;
        for (const part of (msg as any).content as any[]) {
          if (part?.type === "tool-result" && (t.pendingTools.has(part.toolCallId) || t.pendingPermissions.has(part.toolCallId))) {
            results.push({ toolCallId: part.toolCallId, result: this.toMcpResult(part.output), output: part.output });
          }
        }
      }
      if (results.length) return { t, results };
    }
    return null;
  }

  /** A tool-result is an error/denial when its output type is error-* (OpenCode
   *  RejectedError) — used by the permission bridge to map approve vs reject. */
  private isErrorOutput(output: any): boolean {
    const ty = output?.type;
    return ty === "error-text" || ty === "error-json" || ty === "error";
  }

  /** Approve a bridged permission ONLY on an explicit positive answer to the
   *  `question` dialog. Errors, dismissals, and any ambiguous output (including
   *  a typed-in answer) fail CLOSED so an unclear verdict never runs the tool. */
  private questionVerdict(output: any): PermissionVerdict {
    if (this.isErrorOutput(output)) return { approved: false, always: false };
    const answer = this.answerLabel(output).toLowerCase();
    if (answer.includes("always allow")) return { approved: true, always: true };
    if (answer.includes("allow once")) return { approved: true, always: false };
    return { approved: false, always: false };
  }

  /** The chosen label: typed output (`{ answers: [["Always allow"]] }`) first,
   *  then the rendered text fallback (`"question"="Always allow"`). */
  private answerLabel(output: any): string {
    const answers = output?.value?.answers;
    if (Array.isArray(answers)) {
      const first = answers[0];
      if (Array.isArray(first)) return String(first[0] ?? "");
      if (typeof first === "string") return first;
    }
    return this.outputToText(output);
  }

  private outputToText(output: any): string {
    if (!output) return "";
    if (output.type === "text" || output.type === "error-text") return String(output.value ?? "");
    if (output.type === "json" || output.type === "error-json") return JSON.stringify(output.value);
    if (output.type === "content") return (output.value as any[]).map((c) => (c.type === "text" ? c.text : "")).join("");
    return typeof output === "string" ? output : JSON.stringify(output);
  }

  /** OpenCode tool output → MCP CallToolResult. Structured content (images from a
   *  `read`, mixed blocks) is mapped through rather than flattened to a string, so
   *  the agent sees what OpenCode actually returned. */
  private toMcpResult(output: any): unknown {
    const isErr = output?.type === "error-text" || output?.type === "error-json";
    if (output?.type === "content" && Array.isArray(output.value)) {
      const content = output.value
        .map((c: any) => {
          if (c?.type === "text") return { type: "text", text: String(c.text ?? "") };
          if (c?.type === "media" || c?.type === "image") {
            const data = c.data ?? c.value;
            if (typeof data === "string") return { type: "image", data, mimeType: c.mediaType ?? c.mimeType ?? "image/png" };
          }
          return null;
        })
        .filter(Boolean);
      if (content.length) return { content, ...(isErr ? { isError: true } : {}) };
    }
    return { content: [{ type: "text", text: this.outputToText(output) }], ...(isErr ? { isError: true } : {}) };
  }
}
