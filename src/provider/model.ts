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
//  - What it has seen: a fingerprint of the history already sent (history.ts,
//    `historyMode`), plus its own output — answers it emitted and ids it minted —
//    which OpenCode stores and sends back next turn and is never forwarded again.
//  - Turns of ANOTHER model in between are caught up, labelled as such. A different
//    agent or tool set keeps the session; another creation profile forks it; another
//    acp model is a set_model. Only a genuine divergence (revert, compaction) starts
//    over — and even those can fork back (`smartRevert`) or be adopted (`v2`).
//
// Tool flow: when the agent calls an MCP tool, the host fires onToolCall → we
// emit a `tool-call` with the REAL OpenCode tool name, finish `tool-calls`, and
// leave the MCP tools/call DEFERRED; the next doStream brings OpenCode's
// tool-result → we resolve it and the same agent turn continues. Calls issued
// together share a step; calls arriving while the stream is closed are queued.
// Text/thinking arriving meanwhile is BUFFERED, never dropped. Whatever the user
// wrote in between (steer) is delivered into the running turn; an interrupt stops it.
import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { DEBUG, logger } from "../log.js";
import { record, recording, sanitizePrompt } from "./recorder.js";
import {
  anchorsOf, classifyAnchors, classifyHistory, firstUserText, hashText, historyOf, isTransient, msgKey, stripInjected, systemText,
} from "./history.js";

const log = logger("acp-orchestrator");
const dbg = log.dbg;
/** Always-on notices (session lifecycle) — the user needs these without ACP_DEBUG. */
const note = log.note;

/** Max live conversations (LRU, `maxLiveSessions`); older idle ones are closed. Each one
 *  is a Claude Code process (~250-400 MB) plus its MCP runtime. */
const MAX_LIVE_SESSIONS = 6;
/** Idle time before a resumable session is closed (`idleSessionTtlMs`). Coming back
 *  costs a process start: Anthropic keeps the prompt cache ~1 h on subscriptions. */
const IDLE_TTL_MS = 15 * 60_000;
/** Same for subagent sessions (`childSessionTtlMs`): rarely continued. */
const CHILD_TTL_MS = 2 * 60_000;
/** A turn still waiting on OpenCode after this long was abandoned. */
const ABANDONED_TTL_MS = 2 * 60 * 60_000;
/** Cap on a foreign tool-result replayed as text during catch-up (`catchupResultChars`).
 *  Big enough that switching back from another model doesn't lose what it read. */
const CATCHUP_RESULT_CHARS = 8000;
/** Ceiling for a full-history replay into a new session (~100k tokens): beyond it the
 *  oldest turns are dropped — a 656k-char replay was seen in the wild. */
const REPLAY_BUDGET_CHARS = 400_000;
/** Tope del buffer `pending` (chunks emitidos sin controller vivo): sin cap un turno
 *  largo con el stream cerrado lo haría crecer sin límite (OOM). */
const MAX_PENDING_PARTS = 1000;
/** System-prompt blocks worth forwarding to the agent as FACTUAL context (never as
 *  a system prompt — that would make Anthropic bill the session as extra usage). */
const CONTEXT_TAGS = ["env", "available_references"];
/** Bound on the hashes of emitted text kept per session (`ownTexts`). */
const MAX_OWN_TEXTS = 500;
/** How long a read-only tool-call waits for parallel siblings before its step closes. */
const TOOL_BATCH_MS = 40;
/** OpenCode V2 tools that are safe to run in parallel: announced to the agent with MCP
 *  `readOnlyHint`, so Claude Code issues them concurrently and they share one step. */
const PARALLEL_TOOLS = ["read", "glob", "grep", "webfetch", "websearch", "skill", "subagent"];
/** Native tools whose completion is not worth a line (the bridge shows them already). */
const NATIVE_SILENT = new Set(["ExitPlanMode", "EnterPlanMode", "TodoWrite"]);
/** Native tools whose RESULT matters to whoever continues the conversation. */
const NATIVE_WITH_RESULT = new Set(["Task", "Agent", "WebSearch", "WebFetch", "Skill"]);
/** Cap on a native tool result written into the answer (`nativeActivityChars`). */
const NATIVE_RESULT_CHARS = 2000;
/** How long the next turn waits for a native /compact still running. */
const COMPACT_WAIT_MS = 180_000;
/** Lead-in when another model's compaction summary is caught up into this session. */
const CHECKPOINT_NOTE =
  "<context_update>\n(The conversation continued in OpenCode with another model and was then compacted. " +
  "OpenCode's checkpoint follows: it summarizes everything, including what happened after your last turn. " +
  "Keep what you remember; use it to catch up on what you did not see.)\n</context_update>";
/** How long a turn being replaced may take to wind down after a cancel. */
const SETTLE_MS = 5000;
/** The `# Code Mode` section of OpenCode's system prompt (up to the next top-level
 *  heading or tag block), or "" when Code Mode is off. */
function codeModeSection(system: string): string {
  const start = system.search(/^# Code Mode\s*$/m);
  if (start < 0) return "";
  const rest = system.slice(start);
  const end = rest.slice(1).search(/^(# (?!#)|<[a-z_-]+>)/m);
  return (end < 0 ? rest : rest.slice(0, end + 1)).trim();
}

/** OpenCode's record of a tool the user interrupted (or that never got a result):
 *  V2 sends it as a TEXT output holding `{"error":{"type":"aborted",…}}`. */
function isInterrupted(output: any): boolean {
  const v = output?.value;
  const text = typeof v === "string" ? v : v != null ? JSON.stringify(v) : "";
  if (/"type"\s*:\s*"aborted"/.test(text)) return true;
  return /^(Tool execution interrupted|Tool result missing)/.test(text.trim());
}

function ownTextKey(text: string): string {
  return hashText(stripInjected(text).trim());
}

export interface ACPModelConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  modelId?: string;
  claudeCode?: ClaudeCodeControl;
  streamCloseTimeoutMs?: number;
  claudeExecutable?: string;
  /** Test seam: an in-process agent instead of spawning `command`. */
  transport?: () => { input: WritableStream<Uint8Array>; output: ReadableStream<Uint8Array>; close?: () => void };
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
  /** Model last applied with session/set_model: switching opus ↔ sonnet keeps the
   *  session (and its transcript) instead of spawning another agent. */
  appliedModel?: string;
  /** Mode REQUESTED on the previous turn. When the request itself changes (the user
   *  reselects the plan agent), `modeChangedByAgent` is cleared so the new request wins. */
  requestedMode?: string;
  /** Set once the AGENT switches its own mode mid-session (ExitPlanMode approved:
   *  plan → default/acceptEdits). Tells the bridge to stop re-forcing the agent's
   *  configured mode on later turns, so the plan-exit sticks and implementation proceeds. */
  modeChangedByAgent?: boolean;
  /** `PromptResponse.usage` of the last turn: the SUM over every request of the turn
   *  (claude-agent-acp), so only its cache/output RATIOS are meaningful per request. */
  lastUsage?: any;
  /** Context occupancy of the latest request (`usage_update.used`): what OpenCode
   *  must see to decide on compaction. 0 right after a compaction. */
  contextUsed?: number;
  /** OpenCode session id — kept so end-of-turn can persist `lastUsage` to the registry. */
  ocSession?: string;
  /** Session of an OpenCode subagent (`x-parent-session-id`): short idle TTL. */
  isChild?: boolean;
  /** The OpenCode agent of this turn has the `question` tool (unknown → assume yes). */
  hasQuestion?: boolean;
  /** OpenCode agent driving this turn (`claude-code`, `claude-code-plan`, …), for logs
   *  and for the notice shown when the agent leaves plan mode on its own. */
  ocAgent?: string;
  /** One key per NON-SYSTEM message the ACP agent has already been told about.
   *  Comparing this against the incoming prompt distinguishes a normal append from
   *  a REVERT (prompt is a strict prefix) or a compaction (histories diverge). */
  sentKeys: string[];
  /** Same knowledge as anchors (historyMode shadow/v2): user messages + tool-call ids. */
  sentAnchors: string[];
  /** `<system-reminder>`s already forwarded (they move around; send each once). */
  sentTransient: Set<string>;
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
  pendingPermissions: Map<string, (output: any) => void>;
  textId: string | null;
  reasoningId: string | null;
  /** Id prefixes this session minted (its own host's, plus those of the process it was
   *  resumed from). A tool-call/result carrying one of them is the agent's OWN traffic. */
  ownPrefixes: string[];
  /** Hashes of every text/reasoning block emitted to OpenCode: lets the next turn tell
   *  the agent's own answer (already in its session) from another model's. */
  ownTexts: Set<string>;
  /** Text accumulated per open text/reasoning block id (for `ownTexts`). */
  textAcc: Map<string, string>;
  /** All answer text of the current step, in order — matched as a whole too, should
   *  OpenCode ever store a step's text blocks as one part. */
  stepText: string;
  /** Generation of the latest `session/prompt` sent. A completion from an older one
   *  (cancelled, or merged by the agent's prompt queue) must not touch the stream. */
  gen: number;
  /** Settles when the latest prompt resolves — awaited before replacing a turn. */
  inflight: Promise<void> | null;
  /** The prompt finished while no stream was attached: finish the next one with it. */
  doneResp: any | null;
  /** The turn was aborted (stream cancelled / tool interrupted): its tail is discarded. */
  aborted: boolean;
  /** Tool-calls / permission questions collected for the step being closed. */
  stepItems: StepItem[];
  stepTimer: ReturnType<typeof setTimeout> | null;
  /** smartRevert: for each user message that opened a turn (its history index), the
   *  uuid of Claude's last transcript entry BEFORE it — where a revert can fork back to. */
  checkpoints: Array<{ at: number; uuid: string }>;
  /** Native tool calls in flight (Task/Agent, WebSearch, Skill…), by ACP toolCallId. */
  nativeCalls: Map<string, { toolName?: string; title?: string; parent?: string }>;
  /** A native `/compact` is running after an OpenCode compaction (v2): its output is
   *  hidden and the next turn waits for it. */
  compacting: Promise<void> | null;
  hidden: boolean;
  /** The session compacted itself in step with OpenCode: the next history, which starts
   *  at OpenCode's checkpoint, is adopted instead of starting over. */
  adoptCheckpoint: boolean;
  /** Run once the current prompt finishes (after its `finish`). */
  afterTurn: (() => void) | null;
  /** Calls that arrived while no stream was attached (parallel subagents, a permission
   *  asked while OpenCode runs the previous step): emitted with the next continuation. */
  queuedItems: StepItem[];
  lastActive: number;
}

/** One tool-call (or bridged permission question) of the step sent to OpenCode. */
interface StepItem {
  id: string;
  toolName: string;
  input: string;
  /** Visible text emitted right before the call (the plan of an ExitPlanMode). */
  preface?: string;
  /** Read-only tool: wait briefly for siblings issued in parallel. */
  parallel?: boolean;
}

/** Mutable handle so the stream's `cancel` callback can reach the state that
 *  `onStart` resolves asynchronously. */
interface TurnRef { t: TurnState | null }

interface Continuation {
  t: TurnState;
  results: Array<{ toolCallId: string; result: unknown; output: any }>;
  /** History index of the last message carrying one of `results`. */
  lastResultAt: number;
  /** Messages after the results: a steered user message, a `<system-update>`,
   *  a subagent result, the max-steps prefill… The agent hasn't seen any of them. */
  extras: any[];
  /** A result says the tool was interrupted: the user aborted the turn. */
  aborted: boolean;
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

/** Usage accounting (claude-agent-acp 0.31): `PromptResponse.usage` is the SUM over
 *  every API request of the turn — neither per request nor per session — so it is
 *  only used for ratios; the context size comes from `usage_update.used` (see
 *  `usageNow`). Subtracting snapshots (≤0.8) or reporting the sum as-is (0.9 working
 *  tree) both misled OpenCode's auto-compaction. */

async function collectGenerate(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3GenerateResult> {
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

/** The call comes from an OpenCode subagent session (V2 sends the parent's id). */
function isChildCall(options: LanguageModelV3CallOptions): boolean {
  const h = options.headers ?? {};
  return !!(h["x-parent-session-id"] ?? h["X-Parent-Session-Id"]);
}

/** Identity of what a session is CREATED with (`_meta.claudeCode.options` + system
 *  prompt mode). Model, effort and mode are applied live, so they don't count. */
function profileKey(ctrl: ClaudeCodeControl, systemMode: string): string {
  const { model: _m, effort: _e, ...creation } = buildClaudeCodeOptions(ctrl);
  return hashText(JSON.stringify({ o: creation, s: systemMode }));
}

/** Message + structured data of an ACP error (`RequestError.data.errorKind`, details). */
function errorText(err: unknown): string {
  if (!err || typeof err !== "object") return String(err ?? "");
  const e = err as any;
  return [e.message, e.data !== undefined ? JSON.stringify(e.data) : ""].filter(Boolean).join(" ");
}

/** Claude's usage/rate limit, rewritten so the user knows to switch models — and in
 *  words OpenCode's retry classifier doesn't match ("try again", "overloaded"…), so it
 *  isn't retried in a loop against an exhausted subscription. */
export function limitError(err: unknown): Error | undefined {
  const raw = errorText(err);
  if (!/usage limit|rate[ _-]?limit|billing_error|hit your limit|limit reached|out of (?:extra )?usage|quota exceeded|\b429\b/i.test(raw)) return undefined;
  const epoch = raw.match(/\|(\d{10})\b/)?.[1];
  const resets = raw.match(/resets? (?:at )?([^.,;\n"]+)/i)?.[1]?.trim();
  const when = epoch ? new Date(Number(epoch) * 1000).toLocaleString() : resets;
  const e = new Error(`Claude Code: límite de uso alcanzado${when ? ` (se restablece: ${when})` : ""}. Cambia de modelo en OpenCode para continuar; la sesión de Claude se conserva para cuando vuelvas.`);
  e.name = "ClaudeUsageLimit";
  return e;
}

/** Total text size of a prompt (diagnostics). */
function blocksChars(blocks: any[]): number {
  let n = 0;
  for (const b of blocks) n += typeof b?.text === "string" ? b.text.length : 0;
  return n;
}


export class ACPOrchestratorModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "acp";
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private agent: ChildProcess | null = null;
  private closeTransport: (() => void) | null = null;
  private connection: any = null;
  private connecting: Promise<void> | null = null;
  /** Live conversations, keyed by OpenCode sessionID (or the conversation hash).
   *  ONE state per conversation: a single shared state made two open chats — or a
   *  subagent — tear each other's session down and replay the history every turn. */
  private readonly sessions = new Map<string, TurnState>();
  /** Same states indexed by ACP sessionId, to route agent-initiated callbacks. */
  private readonly byAcpSession = new Map<string, TurnState>();
  /** Per-conversation lock for session lookup/creation (see `startFresh`). */
  private readonly locks = new Map<string, Promise<void>>();
  /** Per-call model override (see `doStream`). */
  private readonly callModel = new WeakMap<object, string>();
  private idSeq = 0;
  private promptCaps: Record<string, boolean> = {};
  /** The agent merges a prompt sent mid-turn into the running turn (claude-agent-acp). */
  private promptQueueing = false;

  constructor(private readonly config: ACPModelConfig) {
    this.modelId = config.modelId ?? "claude-code";
  }

  // ---- LanguageModelV3 ------------------------------------------------------

  async doStream(
    options: LanguageModelV3CallOptions,
    /** Model for THIS call when one orchestrator (one agent process) serves several
     *  OpenCode models — see `ACPModelView`. */
    modelId?: string,
  ): Promise<{ stream: ReadableStream<LanguageModelV3StreamPart>; warnings: never[] }> {
    if (modelId) this.callModel.set(options, modelId);
    if (recording()) {
      const po = this.providerOptions(options);
      record(this.convId(options), {
        kind: "call",
        modelId: this.callModel.get(options) ?? this.modelId,
        ocAgent: po.ocAgent,
        poKeys: Object.keys(po),
        headers: Object.fromEntries(Object.entries(options.headers ?? {}).filter(([k]) => /^x-/i.test(k))),
        tools: (options.tools ?? []).map((x: any) => x.name),
        toolChoice: options.toolChoice,
        prompt: sanitizePrompt(options.prompt as any[]),
      });
    }
    const continuation = this.detectContinuation(options.prompt, options);
    const ref: TurnRef = { t: continuation?.t ?? null };
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (controller) => void this.onStart(controller, options, continuation, ref),
      cancel: () => this.onCancel(ref),
    });
    return { stream, warnings: [] };
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { stream } = await this.doStream(options);
    return collectGenerate(stream);
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
      if (continuation?.aborted && continuation.extras.length) {
        // The user interrupted the turn while a tool ran and then wrote again: OpenCode
        // records the tool as `aborted` and appends the new message. Resolving the tool
        // would continue the OLD turn and swallow that message — stop the turn instead,
        // then handle the prompt as a fresh turn whose tail is the new message.
        const t = continuation.t;
        this.decide(options, { decision: "interrupted", session: t.sessionId, results: continuation.results.map((r) => r.toolCallId), extras: continuation.extras.length });
        this.abortTurn(t, "tool interrupted by the user");
        await this.settle(t);
        this.markKnown(t, historyOf(options.prompt).slice(0, continuation.lastResultAt + 1));
        continuation = null;
      }
      if (continuation) {
        const t = continuation.t;
        ref.t = t;
        t.controller = controller;
        t.lastActive = Date.now();
        // Everything in this prompt is known to the agent once this branch is done: its
        // own tool-calls, the results it receives right now and the extras delivered
        // below. Recording them is what stops the next turn from replaying them.
        this.markKnown(t, historyOf(options.prompt));
        // Text/thinking that arrived while the stream was closed goes out FIRST, in
        // order, so nothing the agent said before calling the tool is lost.
        this.flushPending(t);
        this.decide(options, {
          decision: "continuation", session: t.sessionId,
          results: continuation.results.map((r) => r.toolCallId), extras: continuation.extras.length,
        });
        // Steered message / update: queued into the RUNNING turn, exactly like typing
        // while Claude Code works (claude-agent-acp `promptQueueing`). The original
        // prompt then resolves early; the generation guard keeps it off this stream.
        // Without queueing it rides on the last tool result instead.
        // Keep the registry in step mid-turn too: a restart now resumes right here
        // instead of replaying every tool round-trip since the user's message.
        if (t.ocSession) setLink(t.ocSession, t.sessionId, t.sentKeys.length, t.convKey, t.ownPrefixes);
        const extraBlocks = continuation.extras.length ? this.midTurnBlocks(t, continuation.extras) : [];
        const results = continuation.results;
        const lastTool = results.map((r) => !t.pendingPermissions.has(r.toolCallId)).lastIndexOf(true);
        const piggyback = extraBlocks.length > 0 && !this.promptQueueing && lastTool >= 0;
        results.forEach(({ toolCallId, result, output }, i) => {
          const permResolve = t.pendingPermissions.get(toolCallId);
          if (permResolve) {
            // Permission bridge: the user's `question` answer came back as the
            // tool-result → resolve the deferred requestPermission.
            t.pendingPermissions.delete(toolCallId);
            permResolve(output);
            return;
          }
          t.pendingTools.delete(toolCallId);
          t.host.resolveToolCall(toolCallId, piggyback && i === lastTool ? this.appendToResult(result, extraBlocks) : result);
        });
        if (extraBlocks.length && !piggyback) this.sendPrompt(t, extraBlocks);
        // Calls that arrived while OpenCode ran the previous step go out now as the next one.
        if (t.queuedItems.length) {
          t.stepItems.push(...t.queuedItems);
          t.queuedItems = [];
          this.closeStep(t);
        } else if (t.doneResp && !(extraBlocks.length && !piggyback)) this.finishFromDone(t);
        return;
      }

      // Serialized per conversation: two calls racing for the same key (title + first
      // turn in programmatic use, a retry) must not both create a session — the loser
      // would be orphaned with its Claude Code process.
      await this.withLock(this.convId(options), () => this.startFresh(controller, options, ref));
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
    if (t.hidden) return; // native /compact chatter ("Compacting…") is not part of the answer
    this.trackOwnText(t, part);
    if (t.controller) {
      try { t.controller.enqueue(part); return; } catch { /* closed underneath us */ }
    }
    t.pending.push(part);
    // Cap anti-OOM: con el controller cerrado mucho rato `pending` crecería sin
    // límite — se descartan los chunks más antiguos.
    if (t.pending.length > MAX_PENDING_PARTS) {
      t.pending.splice(0, t.pending.length - MAX_PENDING_PARTS);
      dbg(`pending desbordado (>${MAX_PENDING_PARTS}) — descartados los más antiguos`);
    }
  }

  /** A turn that is not a continuation: reuse the live session (append), or create /
   *  resume one. Runs under the conversation lock. */
  private async startFresh(controller: StreamController, options: LanguageModelV3CallOptions, ref: TurnRef) {
    await this.ensureConnected();
    const tools = this.convertTools(options.tools);
    const ctrl = this.effectiveCtrl(options);
    const po = this.providerOptions(options);
    const ocSession: string | undefined = po.ocSession;
    const convKey = hashText(firstUserText(options.prompt));
    const toolsKey = tools.map((x) => x.name).sort().join(",");
    // The system prompt is part of the session identity ONLY when it actually
    // travels. Under the default `preset` mode OpenCode's system is never sent
    // (see buildSystemPromptMeta), so hashing it would tear the session down —
    // and replay the whole history — every time OpenCode swaps agents or its
    // dynamic blocks (date, AGENTS.md, skills) shift. The factual part of that
    // system is forwarded separately as user context (see contextBlocks).
    const systemMode = ctrl.systemPromptMode ?? "preset";
    const systemKey = systemMode === "preset" ? "preset" : hashText(systemText(options.prompt));
    // Params baked into newSession's _meta (thinking/systemPromptMode) can't change
    // mid-session → a change forces a fresh session. mode/effort are applied at
    // runtime via set_mode/set_config_option instead (no reset needed).
    const cfgKey = profileKey(ctrl, systemMode);
    const hist = historyOf(options.prompt);
    const keys = hist.map((m) => msgKey(m));

    // OpenCode's title/summary call arrives on the same model and session but with
    // NO tools. Give it a throwaway session instead of letting it evict the real
    // conversation. Only when the live conversation DOES have tools — a genuinely
    // tool-less conversation (programmatic use) must keep reusing its own session.
    const baseKey = ocSession ?? convKey;
    const live = this.sessions.get(baseKey);
    const key = tools.length === 0 && live && live.toolsKey !== "" ? `${baseKey}:notools` : baseKey;

    const mode = this.historyMode(ctrl);
    // OpenCode compacted (this session, or another model before switching back): the
    // history now starts at its `<conversation-checkpoint>`.
    const checkpoint = firstUserText(options.prompt).startsWith("<conversation-checkpoint>");

    // An OpenCode compaction request: the live session holds the whole conversation
    // with a warm cache — summarizing there costs a normal turn, not a cold replay of
    // everything into a throwaway session.
    if (po.requestKind === "compaction" && live && (await this.serveCompaction(live, controller, options, ref, mode))) return;

    let t = this.sessions.get(key);
    if (t && t.convKey !== convKey) {
      if (checkpoint && mode !== "legacy") {
        this.decide(options, { decision: mode === "v2" ? "checkpoint-keep" : "shadow-checkpoint", session: t.sessionId, adopt: t.adoptCheckpoint });
      }
      // key reused for another conversation (or compacted, outside v2)
      if (!(checkpoint && mode === "v2")) { this.endTurn(t); t = undefined; }
    }

    // (2) Reuse the live session whenever we can — this is what keeps the cache warm.
    if (t) {
      let drop: string | null = null;
      if (t.systemKey !== systemKey) drop = "system prompt changed";
      else if (t.cfgKey !== cfgKey) {
        // Another agent profile (native tools, allowed tools, setting sources…): those are
        // fixed at creation. Fork the live session with the new profile — same context,
        // no replay — instead of starting over; only a failed fork falls back to that.
        const cls = this.classify(t, hist, keys, ctrl);
        if (cls.kind !== "append" || !(await this.forkInPlace(t, ctrl, tools, systemMode, options.prompt, cfgKey))) {
          drop = "creation config changed";
        }
      }
      if (!drop) {
        // A changed tool set is applied to the LIVE session (MCP list_changed)
        // rather than forcing a new one.
        if (t.toolsKey !== toolsKey) {
          t.host.setTools(tools);
          t.host.notifyToolsChanged();
          t.toolsKey = toolsKey;
          dbg(`tools changed (${tools.length}) — refreshed in place, session kept`);
        }
        if (t.compacting) await Promise.race([t.compacting, new Promise((r) => setTimeout(r, COMPACT_WAIT_MS))]);
        let cls = this.classify(t, hist, keys, ctrl, options);
        // v2: OpenCode's checkpoint replaced the history. Keep the session: either it
        // compacted itself in step (adopt — only what follows the checkpoint is new), or
        // another model ran meanwhile (its summary is what the agent hasn't seen).
        let lead: any[] = [];
        if (cls.kind !== "append" && checkpoint && mode === "v2" && t.convKey !== convKey) {
          const adopt = t.adoptCheckpoint && hist.length > 1;
          cls = { kind: "append", fromIndex: adopt ? 1 : 0 };
          if (!adopt) lead = [{ type: "text", text: CHECKPOINT_NOTE }];
          t.convKey = convKey;
          t.adoptCheckpoint = false;
        }
        // smartRevert: the user rewound to a message that opened a turn of this session →
        // fork the session at Claude's state right before it. Nothing is replayed and the
        // shared prefix stays cached; anything unexpected falls back to a new session.
        if (cls.kind !== "append" && ctrl.smartRevert !== false) {
          const at = classifyHistory(t.sentKeys, keys).fromIndex;
          const cp = t.checkpoints.find((c) => c.at === at);
          if (cp && (await this.forkInPlace(t, ctrl, tools, systemMode, options.prompt, cfgKey, { resumeSessionAt: cp.uuid }, "revert"))) {
            this.markKnown(t, hist.slice(0, at));
            t.checkpoints = t.checkpoints.filter((c) => c.at < at);
            this.decide(options, { decision: "smart-revert", session: t.sessionId, at, uuid: cp.uuid });
            cls = { kind: "append", fromIndex: at };
          }
        }
        if (cls.kind !== "append") {
          drop = cls.kind === "revert" ? "history reverted" : "history diverged (compaction/rollback)";
        } else {
          const live = t;
          ref.t = live;
          dbg(`reuse session ${live.sessionId} — ${keys.length - cls.fromIndex} new msg(s) (cache-friendly)`);
          // A fresh user turn: a prior turn that is still running or was abandoned
          // (continuation never arrived) is stopped first, so it can neither hang the
          // agent nor leak its leftovers into this answer.
          if (live.inflight || live.pendingTools.size || live.pendingPermissions.size) {
            this.abortTurn(live, "superseded by a new user turn");
            await this.settle(live);
          }
          live.pending = [];
          live.doneResp = null;
          live.controller = controller;
          live.lastActive = Date.now();
          live.isChild = isChildCall(options);
          if (ocSession) live.ocSession = ocSession;
          if (po.ocAgent) live.ocAgent = String(po.ocAgent);
          live.hasQuestion = typeof po.hasQuestion === "boolean" ? po.hasQuestion : undefined;
          await this.applySessionConfig(live, ctrl);
          // The tail opens with the agent's OWN previous answer (V2 stores it after we
          // sent the prompt): it already has it, so it isn't sent back.
          const rawTail = hist.slice(cls.fromIndex);
          const tail = this.dropOwnLead(live, rawTail);
          const blocks = [
            ...this.contextBlocks(live, options.prompt, ctrl),
            ...lead,
            ...(tail.length ? this.blocksFor(tail, live) : rawTail.length ? [] : this.lastUserBlocks(options.prompt)),
          ];
          this.decide(options, {
            decision: "reuse", session: live.sessionId, from: cls.fromIndex, sent: live.sentKeys.length,
            keys: keys.length, tail: tail.length, ownSkipped: rawTail.length - tail.length, chars: blocksChars(blocks),
          });
          if (ctrl.smartRevert !== false) this.recordCheckpoint(live, hist, cls.fromIndex);
          this.markKnown(live, hist);
          if (ocSession) setLink(ocSession, live.sessionId, hist.length, convKey, live.ownPrefixes);
          this.sendPrompt(live, blocks.length ? blocks : [{ type: "text", text: "" }]);
          return;
        }
      }
      dbg(`dropping session ${t.sessionId} — ${drop}`);
      {
        const at = this.classify(t, hist, keys, ctrl).fromIndex;
        this.decide(options, {
          decision: "drop", session: t.sessionId, reason: drop, at, sent: t.sentKeys.length, keys: keys.length,
          sentKey: t.sentKeys[at], inKey: keys[at],
        });
      }
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
    const resumePrefixes: string[] = Array.isArray(po.resumeIdPrefixes) ? po.resumeIdPrefixes.map(String) : [];
    let sessionId: string | undefined;
    let replayFull = true;
    // A registry entry for a DIFFERENT conversation (first message changed: compaction,
    // or a reused id) must not be resumed — the agent would carry the wrong context.
    const sameConv = !po.resumeConvKey || po.resumeConvKey === convKey;
    if (!sameConv) dbg(`resumeConvKey mismatch (registry=${po.resumeConvKey} current=${convKey}) — not resuming`);
    if (resumeId && sameConv && resumeLen > 0 && hist.length > resumeLen) {
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
      hasQuestion: typeof po.hasQuestion === "boolean" ? po.hasQuestion : undefined,
      isChild: isChildCall(options),
      // Resume path: carry the persisted snapshot over so the registry keeps a
      // value even if the resumed session never completes another turn.
      lastUsage: replayFull ? undefined : po.resumeLastUsage,
      // Full replay covers the whole history; a bare resume only covers up to what
      // the registry last recorded — the rest still needs sending below.
      sentKeys: replayFull ? [] : keys.slice(0, resumeLen),
      sentAnchors: replayFull ? [] : anchorsOf(hist.slice(0, resumeLen)).map((a) => a.key),
      sentTransient: new Set(),
      controller,
      pending: [],
      pendingTools: new Set(),
      pendingPermissions: new Map(),
      textId: null,
      reasoningId: null,
      ownPrefixes: [idPrefix, ...(replayFull ? [] : resumePrefixes)],
      ownTexts: new Set(),
      textAcc: new Map(),
      stepText: "",
      gen: 0,
      inflight: null,
      doneResp: null,
      aborted: false,
      stepItems: [],
      stepTimer: null,
      queuedItems: [],
      nativeCalls: new Map(),
      checkpoints: [],
      compacting: null,
      hidden: false,
      adoptCheckpoint: false,
      afterTurn: null,
      lastActive: Date.now(),
    };
    ref.t = t;
    host.onToolCall((c) => this.onToolCall(t!, c));
    host.onToolCancelled((id) => this.onToolCancelled(t!, id));
    this.sessions.set(key, t);
    this.byAcpSession.set(sessionId, t);
    this.evictIdleSessions();
    this.startSweeper();
    await this.applySessionConfig(t, ctrl);
    if (ocSession) setLink(ocSession, sessionId, hist.length, convKey, t.ownPrefixes);
    // Resume: the registry may lag behind (process died mid-turn), and the agent's own
    // last answer follows the recorded point — the resumed session already has it.
    const tail = replayFull ? hist : this.dropOwnLead(t, hist.slice(resumeLen));
    if (DEBUG && !replayFull) dbg(`resume — catch-up ${tail.length} msg(s)`);
    const promptBlocks = [
      ...this.contextBlocks(t, options.prompt, ctrl),
      ...(tail.length ? this.blocksFor(tail, t, replayFull ? "replay" : "tail") : [{ type: "text", text: "" }]),
    ];
    this.decide(options, {
      decision: replayFull ? "new" : "resume", session: sessionId, keys: keys.length,
      tail: tail.length, chars: blocksChars(promptBlocks),
    });
    this.markKnown(t, hist);
    this.sendPrompt(t, promptBlocks);
  }

  /** Swap `t` onto a fork of its ACP session created with the current profile. The
   *  fork carries the whole transcript, so what `t` knows (sentKeys, own output) still
   *  holds; it gets its own MCP host. The old session is closed. */
  private async forkInPlace(
    t: TurnState, ctrl: ClaudeCodeControl, tools: McpToolDef[], systemMode: string,
    prompt: LanguageModelV3CallOptions["prompt"], cfgKey: string, extra?: Record<string, unknown>,
    why = "agent profile changed",
  ): Promise<boolean> {
    if (t.inflight || t.pendingTools.size || t.pendingPermissions.size) {
      this.abortTurn(t, why);
      await this.settle(t);
    }
    const idPrefix = `acp_${randomBytes(5).toString("hex")}_`;
    const host = new McpHost("opencode", idPrefix);
    try {
      await host.start();
      host.setTools(tools);
      const meta: any = { claudeCode: { options: { ...buildClaudeCodeOptions(ctrl), ...(extra ?? {}) } } };
      const sysMeta = this.buildSystemPromptMeta(prompt, systemMode);
      if (sysMeta !== undefined) meta.systemPrompt = sysMeta;
      const res = await this.connection.unstable_forkSession({
        sessionId: t.sessionId,
        cwd: this.config.cwd ?? process.cwd(),
        mcpServers: [host.getServerConfig()],
        _meta: meta,
      });
      if (!res?.sessionId) throw new Error("fork returned no sessionId");
      const old = { id: t.sessionId, host: t.host };
      this.byAcpSession.delete(old.id);
      t.sessionId = res.sessionId;
      t.host = host;
      t.idPrefix = idPrefix;
      t.ownPrefixes = [idPrefix, ...t.ownPrefixes].slice(0, 8);
      t.cfgKey = cfgKey;
      t.appliedMode = undefined; // re-applied on the fork by applySessionConfig
      t.appliedEffort = undefined;
      t.appliedModel = undefined;
      host.onToolCall((c) => this.onToolCall(t, c));
      host.onToolCancelled((id) => this.onToolCancelled(t, id));
      this.byAcpSession.set(t.sessionId, t);
      old.host.stop();
      this.closeAcpSession(old.id);
      note(`session ${old.id} → fork ${t.sessionId} (${why}, context kept) — retomable con: claude --resume ${t.sessionId}`);
      return true;
    } catch (e) {
      host.stop();
      dbg(`fork of ${t.sessionId} failed (${e instanceof Error ? e.message : String(e)}) — new session instead`);
      return false;
    }
  }

  /** Remember where this turn starts (index of its first user message) and Claude's
   *  last transcript entry before it. */
  private recordCheckpoint(t: TurnState, hist: any[], from: number) {
    let at = from;
    while (at < hist.length && hist[at].role !== "user") at++;
    if (at >= hist.length || t.checkpoints.some((c) => c.at === at)) return;
    const uuid = this.lastAssistantUuid(t);
    if (uuid) t.checkpoints.push({ at, uuid });
  }

  /** uuid of the last main-thread assistant entry in the session's transcript
   *  (`<configDir>/projects/<cwd as slug>/<sessionId>.jsonl`), read from its tail. */
  private lastAssistantUuid(t: TurnState): string | undefined {
    try {
      const dir = resolveConfigDir(this.config.claudeCode ?? {}) ?? join(homedir(), ".claude");
      const slug = (this.config.cwd ?? process.cwd()).replace(/[^a-zA-Z0-9]/g, "-");
      const file = join(dir, "projects", slug, `${t.sessionId}.jsonl`);
      const fd = openSync(file, "r");
      try {
        const size = fstatSync(fd).size;
        const len = Math.min(size, 256 * 1024);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, size - len);
        const lines = buf.toString("utf8").split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const e = JSON.parse(lines[i]);
            if (e?.type === "assistant" && typeof e.uuid === "string" && !e.isSidechain) return e.uuid;
          } catch { /* partial first line */ }
        }
      } finally { closeSync(fd); }
    } catch { /* no transcript (other configDir, agent not writing one) */ }
    return undefined;
  }

  /** Free the agent-side session (its Claude Code process and MCP servers). The client
   *  SDK has no method for it; the agent implements `session/close`. */
  private closeAcpSession(sessionId: string) {
    try {
      Promise.resolve(this.connection?.extMethod?.("session/close", { sessionId })).catch(() => { /* older agent */ });
    } catch { /* ignore */ }
  }

  /** Answer OpenCode's compaction request inside the live session (it already holds
   *  the conversation and its cache): only the summary instruction is sent. In v2 the
   *  session then compacts itself natively, so the checkpoint can be adopted next turn.
   *  Returns false when the session is busy (V2 can compact mid tool loop). */
  private async serveCompaction(
    t: TurnState, controller: StreamController, options: LanguageModelV3CallOptions, ref: TurnRef, mode: string,
  ): Promise<boolean> {
    if (t.compacting) await Promise.race([t.compacting, new Promise((r) => setTimeout(r, COMPACT_WAIT_MS))]);
    if (t.inflight || t.pendingTools.size || t.pendingPermissions.size || t.queuedItems.length) return false;
    ref.t = t;
    t.controller = controller;
    t.pending = [];
    t.doneResp = null;
    t.lastActive = Date.now();
    this.decide(options, { decision: "compaction-live", session: t.sessionId, mode });
    t.afterTurn = mode === "v2" ? () => this.nativeCompact(t) : null;
    this.sendPrompt(t, this.lastUserBlocks(options.prompt));
    return true;
  }

  /** Native `/compact` of the live session, output hidden. */
  private nativeCompact(t: TurnState) {
    t.hidden = true;
    const gen = ++t.gen;
    const done = this.connection
      .prompt({ sessionId: t.sessionId, prompt: [{ type: "text", text: "/compact" }] })
      .then(
        () => { if (gen === t.gen) t.adoptCheckpoint = true; },
        (e: any) => dbg(`native /compact failed: ${errorText(e)}`),
      )
      .finally(() => {
        t.hidden = false;
        if (t.compacting === done) t.compacting = null;
      });
    t.compacting = done;
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const chained = prev.then(() => mine);
    this.locks.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }

  /** Remember the text of every block we emit: OpenCode stores each block as one part of
   *  the assistant message it sends back next turn, which is how `dropOwnLead` knows the
   *  agent already has it. */
  private trackOwnText(t: TurnState, part: LanguageModelV3StreamPart) {
    switch (part.type) {
      case "text-delta":
      case "reasoning-delta":
        t.textAcc.set(part.id, (t.textAcc.get(part.id) ?? "") + part.delta);
        if (part.type === "text-delta") t.stepText += part.delta;
        break;
      case "finish":
        if (t.stepText.trim()) t.ownTexts.add(ownTextKey(t.stepText));
        t.stepText = "";
        break;
      case "text-end":
      case "reasoning-end": {
        const text = t.textAcc.get(part.id);
        t.textAcc.delete(part.id);
        if (text) t.ownTexts.add(ownTextKey(text));
        if (t.ownTexts.size > MAX_OWN_TEXTS) t.ownTexts.delete(t.ownTexts.values().next().value!);
        break;
      }
    }
  }

  private isOwnId(t: TurnState, id: unknown): boolean {
    const s = String(id ?? "");
    return t.ownPrefixes.some((p) => s.startsWith(p));
  }

  /** Strip the agent's own output from the head of a tail: the assistant/tool messages
   *  before the next user message, as long as they carry only our ids and (when this
   *  process emitted them) only text we emitted. A message that fails the check — another
   *  model's turn — stops the skip, so it still reaches the agent. After a restart there
   *  is no emitted text to compare, and the position alone decides. */
  private dropOwnLead(t: TurnState, tail: any[]): any[] {
    let i = 0;
    for (; i < tail.length; i++) {
      const m = tail[i];
      if (m.role === "user" || m.role === "system" || !Array.isArray(m.content)) break;
      const joined = m.content.filter((p: any) => p?.type === "text").map((p: any) => String(p.text ?? "")).join("");
      const wholeOwn = !!joined.trim() && t.ownTexts.has(ownTextKey(joined));
      const own = m.content.every((p: any) => {
        if (p?.type === "tool-call" || p?.type === "tool-result") return this.isOwnId(t, p.toolCallId);
        if (p?.type === "text" || p?.type === "reasoning") {
          const text = String(p.text ?? "");
          return !text.trim() || t.ownTexts.size === 0 || t.ownTexts.has(ownTextKey(text)) || (p.type === "text" && wholeOwn);
        }
        return true;
      });
      if (!own) break;
    }
    return tail.slice(i);
  }

  /** Everything in `hist` is now known to the agent (both fingerprints). */
  private markKnown(t: TurnState, hist: any[]) {
    t.sentKeys = hist.map((m) => msgKey(m));
    t.sentAnchors = anchorsOf(hist).map((a) => a.key);
  }

  private historyMode(ctrl: ClaudeCodeControl): "legacy" | "shadow" | "v2" {
    return ctrl.historyMode ?? (process.env.ACP_HISTORY_MODE as ClaudeCodeControl["historyMode"]) ?? "shadow";
  }

  /** Legacy per-message keys or anchors, per `historyMode`. In `shadow` (the default
   *  while the anchor fingerprint proves itself on real sessions) both are computed, the
   *  legacy one decides, and every disagreement is logged for review. */
  private classify(t: TurnState, hist: any[], keys: string[], ctrl: ClaudeCodeControl, options?: LanguageModelV3CallOptions) {
    const mode = this.historyMode(ctrl);
    const legacy = classifyHistory(t.sentKeys, keys);
    if (mode === "legacy") return legacy;
    const anchors = classifyAnchors(t.sentAnchors, anchorsOf(hist));
    // Cut points are comparable only for appends (for a divergence each scheme reports a
    // different landmark), so only a different kind — or a different cut — is evidence.
    const differs = legacy.kind !== anchors.kind || (legacy.kind === "append" && legacy.fromIndex !== anchors.fromIndex);
    if (options && differs) {
      this.decide(options, {
        decision: "shadow-diff", mode, session: t.sessionId,
        legacy: `${legacy.kind}@${legacy.fromIndex}`, anchors: `${anchors.kind}@${anchors.fromIndex}`,
        legacyKey: [t.sentKeys[legacy.fromIndex], keys[legacy.fromIndex]],
      });
    }
    return mode === "v2" ? anchors : legacy;
  }

  /** Send a prompt as the session's newest generation. Completions of older ones — a
   *  cancelled turn, or the original prompt the agent resolves early when it merges a
   *  queued one — are ignored instead of closing the stream of the current turn. */
  private sendPrompt(t: TurnState, blocks: any[]) {
    const gen = ++t.gen;
    t.aborted = false;
    t.doneResp = null;
    const settled = this.connection
      .prompt({ sessionId: t.sessionId, prompt: blocks })
      .then(
        (resp: any) => {
          if (gen === t.gen) this.onPromptDone(t, resp);
          else dbg(`stale prompt completion ignored (gen ${gen} < ${t.gen}, ${resp?.stopReason})`);
        },
        (err: any) => {
          if (gen === t.gen) this.onPromptError(t, err);
          else dbg(`stale prompt error ignored (gen ${gen} < ${t.gen})`);
        },
      )
      .then(() => { if (t.inflight === settled) t.inflight = null; });
    t.inflight = settled;
  }

  /** Wait (bounded) for the running prompt to settle — e.g. after a cancel. */
  private async settle(t: TurnState, ms = SETTLE_MS) {
    const p = t.inflight;
    if (!p) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([p, new Promise<void>((r) => { timer = setTimeout(r, ms); })]);
    clearTimeout(timer);
  }

  /** Stop the current turn for good: cancel it agent-side, unblock everything it waits
   *  on (deferred tool calls, bridged permissions) and drop what it still produces. */
  private abortTurn(t: TurnState, why: string) {
    dbg(`abort turn of ${t.sessionId} (${why})`);
    t.aborted = true;
    try { this.connection?.cancel?.({ sessionId: t.sessionId }); } catch { /* ignore */ }
    for (const id of t.pendingTools) t.host.rejectToolCall(id, "Tool execution interrupted by the user");
    t.pendingTools.clear();
    this.drainPermissions(t);
    t.controller = null;
    t.textId = null;
    t.reasoningId = null;
    t.textAcc.clear();
    t.pending = [];
    t.doneResp = null;
    if (t.stepTimer) { clearTimeout(t.stepTimer); t.stepTimer = null; }
    t.stepItems = [];
    t.queuedItems = [];
  }

  /** The prompt completed while no stream was attached: close the current one with it. */
  private finishFromDone(t: TurnState) {
    const resp = t.doneResp;
    t.doneResp = null;
    this.onPromptDone(t, resp);
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
    if (!t.controller) {
      // Finished while detached. After an abort that's just the cancellation landing;
      // otherwise keep it, so the next stream of this turn can still be finished.
      if (!t.aborted && resp?.stopReason !== "cancelled") t.doneResp = resp;
      return;
    }
    if (t.stepItems.length) { this.closeStep(t); t.doneResp = resp; return; }
    this.closeBlocks(t);
    this.flushPending(t);
    const turn = resp?.usage; // sum over the turn's requests (see usageNow)
    if (turn) {
      t.lastUsage = turn;
      if (t.ocSession) updateUsage(t.ocSession, turn); // survive process restarts
    }
    if (DEBUG && turn) dbg(`usage(turn): in=${turn.inputTokens} out=${turn.outputTokens} cacheR=${turn.cachedReadTokens} cacheW=${turn.cachedWriteTokens}`);
    const finish: LanguageModelV3StreamPart = {
      type: "finish",
      usage: this.usageNow(t, turn),
      finishReason: { unified: resp?.stopReason === "max_tokens" ? "length" : "stop", raw: resp?.stopReason },
    };
    this.trackOwnText(t, finish);
    try {
      t.controller.enqueue(finish);
      t.controller.close();
    } catch { /* ignore */ }
    t.controller = null; // keep the session for the next turn (delta)
    t.lastActive = Date.now();
    const after = t.afterTurn;
    t.afterTurn = null;
    after?.();
    // A tool-less side call (title/summary in programmatic use) never continues.
    if (t.key.endsWith(":notools")) queueMicrotask(() => this.endTurn(t));
  }

  private onPromptError(t: TurnState, err: unknown) {
    // The agent dropped the session (its Claude Code process died): talking to it again
    // would fail every turn. Forget it here; the next turn resumes the transcript.
    if (/process exited unexpectedly|session not found/i.test(errorText(err))) {
      note(`session ${t.sessionId} lost agent-side — the next turn resumes it`);
      queueMicrotask(() => this.endTurn(t));
    }
    if (!t.controller) return;
    dbg(`prompt error: ${errorText(err)}`);
    try {
      t.controller.enqueue({ type: "error", error: limitError(err) ?? err });
      t.controller.close();
    } catch { /* ignore */ }
    t.controller = null;
  }

  /** Fired by the MCP host when the agent calls an OpenCode tool. The call is NOT
   *  resolved here: it waits for OpenCode to run the tool and send the continuation. */
  private onToolCall(t: TurnState, call: { toolCallId: string; name: string; args: Record<string, unknown> }) {
    if (t.aborted) { t.host.rejectToolCall(call.toolCallId, "Turn aborted"); return; }
    dbg(`agent → tool-call ${call.name} (${call.toolCallId}) → emit to OpenCode`);
    t.pendingTools.add(call.toolCallId);
    // `call.args` puede traer refs circulares/BigInt → JSON.stringify lanzaría y
    // tumbaría el turno: degradar a marcador en vez de crashear.
    let inputJson: string;
    try {
      inputJson = JSON.stringify(call.args ?? {});
    } catch (e) {
      dbg(`tool-call ${call.name}: args no serializables (${e instanceof Error ? e.message : String(e)}) — input="<serialization error>"`);
      inputJson = '"<serialization error>"';
    }
    this.addStepItem(t, { id: call.toolCallId, toolName: call.name, input: inputJson, parallel: this.parallelTools().includes(call.name) });
  }

  /** The agent cancelled a call: if OpenCode hasn't been given it yet, it never will be.
   *  (An already emitted one stays pending so its continuation is still recognised.) */
  private onToolCancelled(t: TurnState, toolCallId: string) {
    const queued = (items: StepItem[]) => items.filter((it) => it.id !== toolCallId);
    const before = t.queuedItems.length + t.stepItems.length;
    t.queuedItems = queued(t.queuedItems);
    t.stepItems = queued(t.stepItems);
    if (t.queuedItems.length + t.stepItems.length < before) t.pendingTools.delete(toolCallId);
    dbg(`agent cancelled tool-call ${toolCallId}`);
  }

  private parallelTools(): string[] {
    return this.config.claudeCode?.parallelTools ?? PARALLEL_TOOLS;
  }

  /** Collect a call into the current step. Serial tools close the step at once; a
   *  read-only one waits TOOL_BATCH_MS for the siblings Claude Code issues in parallel,
   *  so OpenCode gets them in ONE step and runs them in parallel too. With no stream
   *  attached the call is queued for the next continuation — never dropped. */
  private addStepItem(t: TurnState, item: StepItem) {
    if (!t.controller) { t.queuedItems.push(item); return; }
    t.stepItems.push(item);
    if (!item.parallel) { this.closeStep(t); return; }
    if (!t.stepTimer) {
      t.stepTimer = setTimeout(() => this.closeStep(t), this.config.claudeCode?.toolBatchMs ?? TOOL_BATCH_MS);
      t.stepTimer.unref?.();
    }
  }

  /** Usage for a `finish`: the CURRENT context size (OpenCode reads input + cache +
   *  output of the last step as the prompt size when deciding to compact), split into
   *  cache read/write/no-cache with the ratios of the turn's totals. The turn totals
   *  themselves are a sum over all its requests — reporting them inflated the context
   *  N-fold and triggered compactions early. */
  private usageNow(t: TurnState, turn?: any): LanguageModelV3Usage {
    const used = t.contextUsed;
    if (used === undefined) return turn ? mapUsage(turn) : emptyUsage(); // agent without usage_update
    if (used === 0) {
      // just compacted: tiny but non-zero, so OpenCode keeps this step as its anchor
      return { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0 } } as LanguageModelV3Usage;
    }
    const ratios = turn ?? t.lastUsage ?? {};
    const out = Math.min(turn?.outputTokens ?? 0, used);
    const input = used - out;
    const nc = ratios.inputTokens ?? 0, cr = ratios.cachedReadTokens ?? 0, cw = ratios.cachedWriteTokens ?? 0;
    const all = nc + cr + cw;
    const cacheRead = all ? Math.round((input * cr) / all) : 0;
    const cacheWrite = all ? Math.round((input * cw) / all) : 0;
    return {
      inputTokens: { total: input, noCache: Math.max(0, input - cacheRead - cacheWrite), cacheRead, cacheWrite },
      outputTokens: { total: out, text: out },
    } as LanguageModelV3Usage;
  }

  /** Emit the collected calls and end the stream with ONE `tool-calls` finish (OpenCode
   *  rejects a second finish in a step). */
  private closeStep(t: TurnState) {
    if (t.stepTimer) { clearTimeout(t.stepTimer); t.stepTimer = null; }
    const items = t.stepItems;
    t.stepItems = [];
    if (!items.length) return;
    if (!t.controller) { t.queuedItems.push(...items); return; }
    this.closeBlocks(t);
    for (const it of items) {
      if (it.preface) {
        const id = `plan${++this.idSeq}`;
        this.emit(t, { type: "text-start", id });
        this.emit(t, { type: "text-delta", id, delta: it.preface });
        this.emit(t, { type: "text-end", id });
      }
      this.emit(t, { type: "tool-input-start", id: it.id, toolName: it.toolName });
      this.emit(t, { type: "tool-input-delta", id: it.id, delta: it.input });
      this.emit(t, { type: "tool-input-end", id: it.id });
      this.emit(t, { type: "tool-call", toolCallId: it.id, toolName: it.toolName, input: it.input });
    }
    this.emit(t, { type: "finish", usage: this.usageNow(t), finishReason: { unified: "tool-calls", raw: "tool_use" } });
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
    // Sin turno vivo (crash/reinicio, turno abortado) — denegar es más seguro que aprobar
    // a ciegas. Con el stream cerrado por un paso de tools, la pregunta se encola.
    if (!t || t.aborted) return Promise.resolve(this.permOutcome(params, false));
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
    // An agent without `question` (OpenCode's `general` subagent denies it) can't show
    // the dialog: the call would just fail. Deny now, with nothing left hanging.
    if (t.hasQuestion === false) {
      dbg(`requestPermission(${native}) → denied: agent ${agent} has no question tool`);
      return Promise.resolve(this.permOutcome(params, false));
    }
    // (2) "ask": raise a `question` dialog and wait for its tool-result.
    // Own prefix: unique across processes (a bare counter restarts at 0 and collided
    // with old `perm_N` answers still in the history) and recognised as own traffic.
    const callId = `${t.idPrefix}perm_${++this.idSeq}`;
    dbg(`requestPermission(${native}) → bridge as question (${callId})`);
    if (toolCall?.kind === "switch_mode") return this.askPlanApproval(t, callId, params);
    return new Promise<{ outcome: any }>((resolve) => {
      t.pendingPermissions.set(callId, (output: any) => {
        const verdict = this.questionVerdict(output);
        if (verdict.approved && verdict.always && target.always) addAlwaysRule(agent, native, target.always);
        resolve(this.permOutcome(params, verdict.approved));
      });
      this.emitPermissionCall(t, callId, toolCall, native, target);
    });
  }

  /** ExitPlanMode: offer the agent's OWN choices (auto / accept edits / approve each
   *  edit / keep planning) instead of a generic allow/deny that always meant "approve
   *  each edit". A typed answer means "keep planning, and here's why": the plan is
   *  rejected and the text reaches the agent as a message, so it revises the plan. */
  private askPlanApproval(t: TurnState, callId: string, params: any): Promise<{ outcome: any }> {
    const options: any[] = (params?.options ?? []).filter((o: any) => o?.optionId && o?.name);
    const reject = options.find((o) => o.kind === "reject_once" || o.kind === "reject_always");
    const input = JSON.stringify({
      questions: [{
        question: "Approve the plan above?",
        header: "Plan",
        options: options.map((o) => ({
          label: String(o.name),
          description: o.optionId === "plan" ? "Reject and keep refining the plan (or type what to change)" : `Approve; session mode → ${o.optionId}`,
        })),
      }],
    });
    return new Promise<{ outcome: any }>((resolve) => {
      t.pendingPermissions.set(callId, (output: any) => {
        const picked = this.isErrorOutput(output) ? undefined : this.answerLabel(output);
        const norm = this.normalizeAnswer(picked ?? "");
        const match = norm ? options.find((o) => this.normalizeAnswer(String(o.name)) === norm) : undefined;
        if (match) { resolve({ outcome: { outcome: "selected", optionId: match.optionId } }); return; }
        resolve(reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } });
        const feedback = String(picked ?? "").trim();
        if (feedback && !t.aborted) this.sendPrompt(t, [{ type: "text", text: `Feedback on the proposed plan — keep planning and revise it:\n${feedback}` }]);
      });
      this.addStepItem(t, { id: callId, toolName: "question", input, preface: this.planText(params?.toolCall) || undefined });
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
    this.addStepItem(t, { id: callId, toolName: "question", input });
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
      case "usage_update":
        if (typeof update.used === "number") t.contextUsed = update.used;
        break;
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
      case "tool_call":
      case "tool_call_update":
        this.onNativeTool(t, update);
        break;
      default:
        break;
    }
  }

  /** Native Claude Code tools run INSIDE the agent: OpenCode never sees them, so after a
   *  switch to another model what Claude read, searched or delegated was simply gone.
   *  Each one that completes is written into the answer as a short text block — plain
   *  text, the only form every model accepts (tools marked provider-executed would be
   *  replayed to other providers as calls they don't know). OpenCode's own tools
   *  (mcp__opencode__*) are skipped: they're already in the history. */
  private onNativeTool(t: TurnState, u: any) {
    const mode = this.config.claudeCode?.nativeActivity ?? "text";
    if (mode === "off" || !u?.toolCallId) return;
    const meta = u._meta?.claudeCode ?? {};
    const prev = t.nativeCalls.get(u.toolCallId) ?? {};
    const call = {
      toolName: meta.toolName ?? prev.toolName,
      title: (typeof u.title === "string" && u.title) || prev.title,
      parent: meta.parentToolUseId ?? prev.parent,
    };
    t.nativeCalls.set(u.toolCallId, call);
    if (u.status !== "completed" && u.status !== "failed") return;
    t.nativeCalls.delete(u.toolCallId);
    const name = String(call.toolName ?? "");
    if (!name || name.startsWith("mcp__") || NATIVE_SILENT.has(name)) return;
    const result = NATIVE_WITH_RESULT.has(name) ? this.nativeResultText(u) : "";
    const cap = this.config.claudeCode?.nativeActivityChars ?? NATIVE_RESULT_CHARS;
    const body = result.length > cap ? `${result.slice(0, cap)}…[truncated, ${result.length} chars]` : result;
    const head = `${call.parent ? "  ↳ " : ""}⚙ ${name}${call.title && call.title !== name ? `: ${call.title}` : ""}${u.status === "failed" ? " — failed" : ""}`;
    const id = `n${++this.idSeq}`;
    this.closeBlocks(t);
    this.emit(t, { type: "text-start", id });
    this.emit(t, { type: "text-delta", id, delta: `\n${head}\n${body ? `\n\`\`\`text\n${body}\n\`\`\`\n` : ""}` });
    this.emit(t, { type: "text-end", id });
  }

  private nativeResultText(u: any): string {
    const content: any[] = Array.isArray(u.content) ? u.content : [];
    const text = content
      .map((c) => (c?.type === "content" && c.content?.type === "text" ? c.content.text : typeof c?.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) return text.trim();
    const raw = u.rawOutput;
    if (typeof raw === "string") return raw.trim();
    if (Array.isArray(raw)) return raw.map((x: any) => (typeof x?.text === "string" ? x.text : "")).join("\n").trim();
    return "";
  }

  private closeBlocks(t: TurnState) {
    if (t.textId) { this.emit(t, { type: "text-end", id: t.textId }); t.textId = null; }
    if (t.reasoningId) { this.emit(t, { type: "reasoning-end", id: t.reasoningId }); t.reasoningId = null; }
  }

  private endTurn(t: TurnState) {
    // Settle any deferred permission requests (deny/cancel) so the agent never
    // stays blocked awaiting a verdict that will no longer arrive.
    this.drainPermissions(t);
    try { if (this.connection && t.sessionId) this.connection.cancel?.({ sessionId: t.sessionId }); } catch { /* ignore */ }
    t.host.stop();
    // Without this the agent keeps the session — and its `claude` process — forever.
    if (this.connection && t.sessionId) this.closeAcpSession(t.sessionId);
    if (this.sessions.get(t.key) === t) this.sessions.delete(t.key);
    this.byAcpSession.delete(t.sessionId);
  }

  /** Keep at most MAX_LIVE_SESSIONS conversations alive; tear down the oldest idle ones
   *  (never one with work in flight) so hosts and agent sessions don't pile up. */
  private evictIdleSessions() {
    const max = this.config.claudeCode?.maxLiveSessions ?? MAX_LIVE_SESSIONS;
    if (this.sessions.size <= max) return;
    const idle = [...this.sessions.values()]
      .filter((s) => !s.controller && s.pendingTools.size === 0 && s.pendingPermissions.size === 0)
      .sort((a, b) => a.lastActive - b.lastActive);
    while (this.sessions.size > max && idle.length) {
      const victim = idle.shift()!;
      dbg(`evicting idle session ${victim.sessionId} (LRU)`);
      this.endTurn(victim);
    }
  }

  /** Resolve every outstanding bridged permission as denied so the agent unblocks. */
  private drainPermissions(t: TurnState) {
    if (t.pendingPermissions.size === 0) return;
    const abandoned = { type: "error-text", value: "Permission request abandoned" };
    for (const resolve of [...t.pendingPermissions.values()]) { try { resolve(abandoned); } catch { /* ignore */ } }
    t.pendingPermissions.clear();
  }

  /** Per-call provider options: V2 nests them under `providerOptionKey(package,
   *  providerID)` = the providerID. El fallback al primer objeto del mapa sería
   *  voraz (podría tomar opciones de OTRO provider): solo se acepta si la key
   *  contiene nuestro provider id (`acp`) o el objeto trae forma conocida
   *  (ocSession/ocAgent/resumeId/…/mode/effort/native*); si no, como ausente. */
  private providerOptions(options: LanguageModelV3CallOptions): Record<string, any> {
    const all = (options.providerOptions ?? {}) as Record<string, unknown>;
    const own = all[this.provider];
    if (own && typeof own === "object") return own as Record<string, any>;
    const SHAPE_KEYS = new Set([
      "ocSession", "ocAgent", "resumeId", "resumeLen", "resumeConvKey", "resumeLastUsage", "resumeIdPrefixes",
      "requestKind", "hasQuestion",
      "mode", "effort", "thinking", "systemPromptMode", "forwardEnvContext",
      "tools", "allowedTools", "disallowedTools", "settingSources", "strictMcpConfig",
      "nativeTools", "resourceSearch", "nativeSubagents", "nativeSkills", "projectMemory", "skillShell",
    ]);
    for (const [key, value] of Object.entries(all)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      if (String(key).toLowerCase().includes(this.provider)) return value as Record<string, any>;
      if (Object.keys(value).some((k) => SHAPE_KEYS.has(k) || k.startsWith("native"))) return value as Record<string, any>;
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
    const modelId = this.callModel.get(options) ?? this.modelId;
    if (!ctrl.model && modelId && modelId !== "claude-code") ctrl.model = modelId;
    return ctrl;
  }

  /** Apply runtime config (mode/effort) to a live ACP session via set_mode/set_config_option. */
  private async applySessionConfig(t: TurnState, ctrl: ClaudeCodeControl): Promise<void> {
    if (ctrl.model && ctrl.model !== t.appliedModel) {
      try {
        await this.connection.unstable_setSessionModel({ sessionId: t.sessionId, modelId: ctrl.model });
        t.appliedModel = ctrl.model;
        dbg(`model → ${ctrl.model}`);
      } catch (e) {
        note(`aviso: no se pudo aplicar el modelo ${ctrl.model} (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    // A CHANGED request (the user reselected the plan agent) overrides a mode the agent
    // set for itself. Without this reset an ExitPlanMode would permanently pin the
    // session out of plan mode, and going back to the plan agent would do nothing.
    if (ctrl.mode !== t.requestedMode) {
      t.requestedMode = ctrl.mode;
      // Leaving the plan agent for a non-plan one after the plan was approved keeps the
      // mode the user picked in that approval (acceptEdits, auto…) instead of downgrading
      // it to the new agent's default. Only (re)entering plan resets it.
      const keepApproved = t.modeChangedByAgent && ctrl.mode !== "plan" && t.appliedMode !== "plan";
      if (!keepApproved) t.modeChangedByAgent = false;
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
    // Si `connect()` lanza, `connecting` debe resetearse: si no, todos los
    // `ensureConnected()` futuros reutilizarían la promesa rechazada y colgarían.
    this.connecting = this.connect().then(
      () => undefined,
      (err) => { this.connecting = null; throw err; },
    );
    return this.connecting;
  }

  private async connect() {
    const ctrl = this.config.claudeCode ?? {};
    const env: Record<string, string> = { ...(process.env as Record<string, string>), ...(this.config.env ?? {}) };
    if (this.config.claudeExecutable) env.CLAUDE_CODE_EXECUTABLE = this.config.claudeExecutable;
    const configDir = resolveConfigDir(ctrl);
    if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
    if (this.config.streamCloseTimeoutMs) env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = String(this.config.streamCloseTimeoutMs);
    // Claude compacts its own session before OpenCode's threshold (context − 32k), so
    // OpenCode's compaction — which forces a new session elsewhere — rarely triggers.
    const pct = ctrl.autoCompactPct ?? 75;
    if (pct && !env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(pct);
    // Model selection: the agent resolves the effective model from ANTHROPIC_MODEL
    // (getAvailableModels overrides options.model otherwise). claudeCode.model wins,
    // else the OpenCode modelId (unless the neutral "claude-code").
    const model = ctrl.model ?? (this.modelId !== "claude-code" ? this.modelId : undefined);
    if (model) env.ANTHROPIC_MODEL = model;

    const stream = this.config.transport ? this.openTransport() : this.spawnAgent(env);
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
    this.promptQueueing = !!initResult?.agentCapabilities?._meta?.claudeCode?.promptQueueing;
    dbg(`connected to agent — promptCapabilities: ${JSON.stringify(this.promptCaps)}`);
  }

  private openTransport() {
    const t = this.config.transport!();
    this.closeTransport = t.close ?? null;
    return ndJsonStream(t.input as any, t.output as any);
  }

  private spawnAgent(env: Record<string, string>) {
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
    return ndJsonStream(
      Writable.toWeb(this.agent.stdin!) as any,
      Readable.toWeb(this.agent.stdout!) as any,
    );
  }

  /** V2 reads every stream to its end; a cancel only comes from an error or the user
   *  aborting (V1 also cancelled to PAUSE for a permission prompt — not anymore). So a
   *  cancel ends the turn: the agent stops, deferred calls are released, leftovers are
   *  dropped. The session itself — and its prompt cache — stays for the next message. */
  private onCancel(ref: TurnRef) {
    const t = ref.t;
    if (!t) return;
    this.abortTurn(t, "stream cancelled");
  }

  private sweeper: ReturnType<typeof setInterval> | null = null;

  private startSweeper() {
    if (this.sweeper) return;
    const c = this.config.claudeCode ?? {};
    const shortest = Math.min(c.idleSessionTtlMs ?? IDLE_TTL_MS, c.childSessionTtlMs ?? CHILD_TTL_MS);
    this.sweeper = setInterval(() => this.sweepIdle(), Math.max(20, Math.min(30_000, shortest / 2)));
    this.sweeper.unref?.();
  }

  /** Close sessions nobody is using. Only resumable ones (an OpenCode session id, so
   *  the registry can bring them back without a replay); a turn left waiting on
   *  OpenCode for hours is treated as abandoned. */
  private sweepIdle() {
    const c = this.config.claudeCode ?? {};
    const now = Date.now();
    for (const t of [...this.sessions.values()]) {
      if (!t.ocSession) continue;
      const idle = now - t.lastActive;
      const waiting = t.pendingTools.size > 0 || t.pendingPermissions.size > 0 || t.queuedItems.length > 0;
      if (waiting) {
        if (idle > ABANDONED_TTL_MS) { this.abortTurn(t, "abandoned"); this.endTurn(t); }
        continue;
      }
      if (t.controller || t.inflight) continue;
      const ttl = t.isChild ? c.childSessionTtlMs ?? CHILD_TTL_MS : c.idleSessionTtlMs ?? IDLE_TTL_MS;
      if (idle > ttl) {
        dbg(`closing idle session ${t.sessionId} (${Math.round(idle / 1000)}s)`);
        this.endTurn(t);
      }
    }
  }

  cleanup() {
    if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = null; }
    for (const t of [...this.sessions.values()]) this.endTurn(t);
    this.sessions.clear();
    this.byAcpSession.clear();
    try { this.agent?.kill(); } catch { /* ignore */ }
    try { this.closeTransport?.(); } catch { /* ignore */ }
    this.agent = null;
    this.closeTransport = null;
    this.connection = null;
    this.connecting = null;
  }

  // ---- diagnostics ----------------------------------------------------------

  /** Conversation id for logs/recordings: OpenCode's sessionID, else the first-message hash. */
  private convId(options: LanguageModelV3CallOptions): string {
    const po = this.providerOptions(options);
    return typeof po.ocSession === "string" ? po.ocSession : `conv_${hashText(firstUserText(options.prompt))}`;
  }

  /** One line per turn decision (file log + recording): the evidence needed to tell a
   *  genuine divergence from a false one after the fact. */
  private decide(options: LanguageModelV3CallOptions, d: Record<string, unknown>) {
    const conv = this.convId(options);
    log.trace(`${conv} ${JSON.stringify(d)}`);
    record(conv, { kind: "decision", ...d });
  }

  // ---- conversions ----------------------------------------------------------

  private convertTools(tools: LanguageModelV3CallOptions["tools"]): McpToolDef[] {
    if (!tools) return [];
    const out: McpToolDef[] = [];
    for (const t of tools) {
      if ((t as any).type === "function") {
        const name = (t as any).name;
        out.push({
          name,
          description: this.toolDescription(name, (t as any).description),
          inputSchema: (t as any).inputSchema ?? { type: "object", properties: {} },
          ...(this.parallelTools().includes(name) ? { annotations: { readOnlyHint: true } } : {}),
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
    if (name === "subagent") {
      return `${description ?? ""}\n\nPrefer this tool for delegating substantial work: the child session is visible in OpenCode and any model can continue it, so its result stays part of the shared conversation. Use your native Task tool for your own specialised agents or quick self-contained lookups.`.trim();
    }
    if (name === "question") {
      return `${description ?? ""}\n\nIMPORTANT: this is the ONLY way to ask the user something — the native AskUserQuestion tool is unavailable here. Use it whenever the request is ambiguous or a decision is the user's to make, instead of assuming.`.trim();
    }
    return description;
  }





  /** Messages the agent hasn't seen, as prompt blocks.
   *  - `tail` (live or resumed session): the user's messages verbatim; every run of
   *    assistant/tool messages between them was produced by ANOTHER model or agent in
   *    OpenCode (the agent's own output is dropped beforehand), and is labelled so —
   *    as a bare "Assistant:" the agent took those actions for its own.
   *  - `replay` (brand-new session): everything before the current request becomes a
   *    bounded `<conversation_history>`; the request itself follows on its own. */
  private blocksFor(msgs: any[], t: TurnState | null, mode: "tail" | "replay" = "tail"): any[] {
    if (mode === "replay") return this.replayBlocks(msgs, t);
    const blocks: any[] = [];
    for (let i = 0; i < msgs.length; ) {
      if (msgs[i].role === "user") {
        const m = msgs[i++];
        if (isTransient(m) && t) {
          const k = msgKey(m);
          if (t.sentTransient.has(k)) continue;
          t.sentTransient.add(k);
        }
        blocks.push(...this.messageToBlocks(m, false, t));
        continue;
      }
      const run: any[] = [];
      while (i < msgs.length && msgs[i].role !== "user") run.push(msgs[i++]);
      const inner = run.flatMap((m) => this.renderMessage(m, t));
      if (inner.length) {
        blocks.push({ type: "text", text: "<other_model_turn>\n(Another model or agent answered this part in OpenCode — you did not write it or run these tools.)" });
        blocks.push(...inner);
        blocks.push({ type: "text", text: "</other_model_turn>" });
      }
    }
    return blocks;
  }

  private replayBlocks(msgs: any[], t: TurnState | null): any[] {
    let cut = msgs.length;
    while (cut > 0 && msgs[cut - 1].role === "user") cut--;
    const current = msgs.slice(cut).flatMap((m) => this.messageToBlocks(m, false, t));
    let rendered = msgs.slice(0, cut).map((m) => this.renderMessage(m, t)).filter((b) => b.length);
    if (!rendered.length) return current;
    // Budget: keep the opening message (usually the task) and the most recent ones.
    let omitted = 0;
    while (rendered.length > 2 && rendered.reduce((n, b) => n + blocksChars(b), 0) > REPLAY_BUDGET_CHARS) {
      rendered.splice(1, 1);
      omitted++;
    }
    return [
      { type: "text", text: "<conversation_history>\n(Earlier turns of this conversation, replayed because the session was restarted. Context only: do not repeat or re-run anything from it.)" },
      ...rendered[0],
      ...(omitted ? [{ type: "text", text: `<omitted messages="${omitted}" reason="replay budget"/>` }] : []),
      ...rendered.slice(1).flat(),
      { type: "text", text: "</conversation_history>" },
      ...(current.length ? current : [{ type: "text", text: "(Continue the conversation above.)" }]),
    ];
  }

  /** One message as tagged blocks (for history and other models' turns). Reasoning and
   *  the agent's own tool traffic are left out: neither is something to re-read. */
  private renderMessage(msg: any, t: TurnState | null): any[] {
    const role = msg.role === "assistant" ? "assistant" : msg.role === "user" ? "user" : null;
    if (typeof msg.content === "string") {
      const text = stripInjected(msg.content).trim();
      return text && role ? [{ type: "text", text: `<${role}>\n${text}\n</${role}>` }] : [];
    }
    const blocks: any[] = [];
    for (const part of msg.content as any[]) {
      // OUR OWN tool traffic: the agent already holds these in its session (they came
      // back over MCP). Replaying them as text duplicated whole file/shell outputs on
      // every turn and blew the prompt cache — by far the biggest token sink.
      if ((part.type === "tool-call" || part.type === "tool-result") && t && this.isOwnId(t, part.toolCallId)) continue;
      if (part.type === "text") {
        const text = stripInjected(String(part.text ?? "")).trim();
        if (text && role) blocks.push({ type: "text", text: `<${role}>\n${text}\n</${role}>` });
      } else if (part.type === "tool-call") {
        const input = typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {});
        blocks.push({ type: "text", text: `<tool_call name="${part.toolName}">${input}</tool_call>` });
      } else if (part.type === "tool-result") {
        blocks.push({ type: "text", text: `<tool_result name="${part.toolName}">${this.truncate(stripInjected(this.outputToText(part.output)))}</tool_result>` });
      } else if (part.type === "file") {
        blocks.push(this.fileToBlock(part) ?? { type: "text", text: `[Attachment ${part.mediaType ?? "file"} not supported by the agent]` });
      }
    }
    return blocks;
  }

  /** A user message verbatim (text + attachments), minus tags other plugins inject. */
  private messageToBlocks(msg: any, _withPrefix: boolean, t: TurnState | null): any[] {
    if (typeof msg.content === "string") return [{ type: "text", text: stripInjected(msg.content) }];
    const blocks: any[] = [];
    for (const part of msg.content as any[]) {
      if ((part.type === "tool-call" || part.type === "tool-result") && t && this.isOwnId(t, part.toolCallId)) continue;
      if (part.type === "text") blocks.push({ type: "text", text: stripInjected(String(part.text ?? "")) });
      else if (part.type === "tool-call") blocks.push({ type: "text", text: `<tool_call name="${part.toolName}">${JSON.stringify(part.input)}</tool_call>` });
      else if (part.type === "tool-result") blocks.push({ type: "text", text: `<tool_result name="${part.toolName}">${this.truncate(this.outputToText(part.output))}</tool_result>` });
      else if (part.type === "file") blocks.push(this.fileToBlock(part) ?? { type: "text", text: `[Attachment ${part.mediaType ?? "file"} not supported by the agent]` });
    }
    return blocks;
  }

  /** A foreign tool-result is replayed only so the agent can follow the thread —
   *  the full payload isn't worth the tokens. */
  private truncate(s: string): string {
    const cap = this.config.claudeCode?.catchupResultChars ?? CATCHUP_RESULT_CHARS;
    return s.length <= cap ? s : `${s.slice(0, cap)}…[truncated, ${s.length} chars]`;
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
    const text = systemText(prompt);
    if (!text) return undefined;
    return mode === "replace" ? text : { append: text };
  }


  /** The FACTUAL part of OpenCode's system prompt: where we are, what the workspace is,
   *  what references exist. Under `preset` the system prompt itself never reaches the
   *  agent (forwarding it would get the session billed as extra usage), but this
   *  context is genuinely useful and carries no instructions, so it rides along as
   *  user content instead. Everything else — OpenCode's behavioural instructions,
   *  AGENTS.md (the agent loads it itself via projectMemory), MCP/skill catalogues —
   *  is deliberately left out. */
  private extractContextBlock(prompt: LanguageModelV3CallOptions["prompt"]): string {
    const sys = systemText(prompt);
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
      // V2's Code Mode catalog lives in the system prompt (which `preset` never sends):
      // without it the agent sees an `execute` tool but not what it can call through it.
      // Sent once; V2 announces later changes itself as a `<system-update>` message.
      const catalog = codeModeSection(systemText(prompt));
      return [{
        type: "text",
        text: `<opencode_context>\n${block}\n  Session started: ${now.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})\n</opencode_context>`
          + (catalog ? `\n<code_mode_catalog>\n${catalog}\n</code_mode_catalog>` : ""),
      }];
    }
    const prev = new Set(t.lastContextBlock.split("\n").map((l) => l.trim()).filter(Boolean));
    const changed = block.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("<") && !prev.has(l));
    t.lastContextBlock = block;
    if (!changed.length) return [];
    dbg(`context delta (${changed.length} line(s))`);
    return [{ type: "text", text: `<opencode_context_update>\n${changed.join("\n")}\n</opencode_context_update>` }];
  }

  /** What OpenCode appended after the results of a continuation, as prompt blocks:
   *  user text verbatim (a steered message, a subagent result, a `<system-update>`), and
   *  any assistant prefill (V2's max-steps notice) as an explicit notice. */
  private midTurnBlocks(t: TurnState, extras: any[]): any[] {
    const blocks: any[] = [];
    for (const m of extras) {
      if (m.role === "user") blocks.push(...this.messageToBlocks(m, false, t));
      else if (m.role === "assistant") {
        const text = (Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }])
          .filter((p: any) => p?.type === "text" && String(p.text ?? "").trim())
          .map((p: any) => p.text)
          .join("\n");
        if (text) blocks.push({ type: "text", text: `<opencode_notice>\n${text}\n</opencode_notice>` });
      }
    }
    return blocks;
  }

  /** Fallback when the agent can't queue a prompt: the extras ride on a tool result. */
  private appendToResult(result: any, blocks: any[]): any {
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const note = { type: "text", text: `<user_message_during_turn>\n${text}\n</user_message_during_turn>` };
    const content = Array.isArray(result?.content) ? result.content : [];
    return { ...(result ?? {}), content: [...content, note] };
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
   *  answers. Acotado a la conversación actual (`ocSession`/convKey de ESTA llamada):
   *  iterar todas las sesiones cruzaba continuaciones de chats concurrentes. */
  private detectContinuation(
    prompt: LanguageModelV3CallOptions["prompt"],
    options?: LanguageModelV3CallOptions,
  ): Continuation | null {
    let candidates: Array<TurnState | undefined>;
    if (options) {
      const po = this.providerOptions(options);
      const baseKey = typeof po.ocSession === "string" ? po.ocSession : hashText(firstUserText(prompt));
      candidates = [this.sessions.get(baseKey), this.sessions.get(`${baseKey}:notools`)];
    } else {
      candidates = [...this.sessions.values()];
    }
    const hist = historyOf(prompt);
    for (const t of candidates) {
      if (!t) continue;
      if (t.pendingTools.size === 0 && t.pendingPermissions.size === 0) continue;
      // Last occurrence wins: ids are unique per session now, but a history can still
      // hold an older answer with the same id (pre-0.10 bare `perm_N`).
      const found = new Map<string, { toolCallId: string; result: unknown; output: any }>();
      let lastResultAt = -1;
      hist.forEach((msg, idx) => {
        if (msg.role !== "tool" && msg.role !== "assistant") return;
        for (const part of (msg as any).content as any[]) {
          if (part?.type === "tool-result" && (t.pendingTools.has(part.toolCallId) || t.pendingPermissions.has(part.toolCallId))) {
            found.set(part.toolCallId, { toolCallId: part.toolCallId, result: this.toMcpResult(part.output), output: part.output });
            lastResultAt = idx;
          }
        }
      });
      if (!found.size) continue;
      const results = [...found.values()];
      return {
        t,
        results,
        lastResultAt,
        extras: hist.slice(lastResultAt + 1),
        aborted: results.some((r) => isInterrupted(r.output)),
      };
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
   *  a typed-in answer) fail CLOSED so an unclear verdict never runs the tool.
   *  Verificado: OpenCode V2 no expone identificador estable (sin schema de la tool
   *  `question` en node_modules/@opencode-ai ni en /opt/OpenCode/resources; el shape
   *  documentado es etiqueta en `{ answers: [["…"]] }` o texto renderizado) → match
   *  por etiqueta normalizada (minúsculas, trim, "_" y espacios colapsados) con
   *  fallback deny ante cualquier cosa no reconocida. Flujo de 3 opciones intacto. */
  private questionVerdict(output: any): PermissionVerdict {
    if (this.isErrorOutput(output)) return { approved: false, always: false };
    const answer = this.normalizeAnswer(this.answerLabel(output));
    if (answer.includes("always allow")) return { approved: true, always: true };
    if (answer.includes("allow once")) return { approved: true, always: false };
    return { approved: false, always: false };
  }

  /** Normaliza una etiqueta de respuesta para el match robusto. */
  private normalizeAnswer(s: string): string {
    return String(s ?? "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  }

  /** The chosen label: typed output (`{ answers: [["Always allow"]] }`) first,
   *  then the rendered text fallback (`"question"="Always allow"`). */
  private answerLabel(output: any): string {
    const answers = output?.value?.answers;
    if (Array.isArray(answers)) {
      const first = answers[0];
      const cand = Array.isArray(first) ? first[0] : first;
      if (typeof cand === "string") return cand;
      // Por si OpenCode V2 tipa la respuesta algún día (objeto con optionId/id
      // estable): preferir el identificador antes que el texto renderizado.
      if (cand && typeof cand === "object") {
        const stable = (cand as any).label ?? (cand as any).value ?? (cand as any).text ?? (cand as any).optionId ?? (cand as any).id;
        if (typeof stable === "string") return stable;
      }
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

/** One OpenCode model served by a shared orchestrator. Every model of the provider
 *  talks to the SAME agent process and session map: switching opus ↔ sonnet mid-
 *  conversation is a `session/set_model` on the live session, not a second process
 *  resuming a session that is still open in the first one. */
export class ACPModelView implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "acp";
  readonly supportedUrls: Record<string, RegExp[]> = {};

  constructor(private readonly core: ACPOrchestratorModel, readonly modelId: string) {}

  doStream(options: LanguageModelV3CallOptions) {
    return this.core.doStream(options, this.modelId);
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { stream } = await this.doStream(options);
    return collectGenerate(stream);
  }
}
