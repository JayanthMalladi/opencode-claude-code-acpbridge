# Development — `opencode-claude-code-acpbridge`

How the package works inside, its key flows, and how to extend it. For usage see the
[README](../README.md); for ready-made configs see [examples/](../examples/).

> **OpenCode V2 only.** The plugin half uses the V2 plugin runtime (`Plugin.define`, promise
> API) and the V2 config format. It does not load in OpenCode V1.

---

## 1. Overview

One npm package that OpenCode loads as **two things at once**:

- **Provider** (`createACPModelProvider`): implements `LanguageModelV3` from the Vercel AI
  SDK. Underneath it is an **ACP client** (Agent Client Protocol) that spawns
  `claude-agent-acp`, the ACP adapter for Claude Code.
- **Plugin** (`export default Plugin.define({ id, setup })`, V2 promise API):
  - registers the provider and the agents through transforms;
  - injects the session id and the per-call options through the `context` hook;
  - names sessions without a model call (`title` hook);
  - drops the stored session link on `session.revert.*` events.

  For local development the entry point is the root `index.js`: when the plugin target is a
  directory, OpenCode's `Host.resolve` looks for `<dir>/index.*`.

The guiding principle is **"OpenCode orchestrates"**. Claude only **reasons and proposes**
tool calls; **OpenCode runs them** (with its permissions and TUI) and feeds the result back.
To get there, Claude Code's common native tools are **disabled**, and **OpenCode's tools** are
exposed to it through a synthetic MCP server. The native tools that stay enabled are the ones
with no OpenCode equivalent, and they go through the **permission bridge** (§4).

---

## 2. Architecture

```
                 ┌───────────────────────── OpenCode process ──────────────────────────┐
                 │                                                                      │
 OpenCode  ──────┼─►  Plugin (V2)                    Provider (LanguageModelV3)          │
  (TUI/run)      │      • provider.transform:           • doStream(prompt, tools)        │
                 │      • registers the acp provider    • ACPOrchestratorModel           │
                 │      • agent.transform:              persistent ACP session           │
                 │          claude-code + rules ──────► providerOptions.acp              │
                 │      • session.hook("context"): ◄─── ocSession/ocAgent/resume*        │
                 │          session id + options ─────► + per-agent mode/effort          │
                 │      • event: session.revert.* → clearLink                            │
                 │                                       │                               │
                 │                               McpHost (TCP) ◄── OpenCode's tools      │
                 │                                         │ getServerConfig()           │
                 └─────────────────────────────────────────┼────────────────────────────┘
                                                           │ spawn (stdio JSON-RPC, ACP)
                                                           ▼
                                             claude-agent-acp (separate process)
                                                           │  spawns over stdio
                                                           ▼
                                             mcp-runtime.js (node) ──TCP──► McpHost
                                             (MCP server "opencode", defers tools/call)
```

- **ACP channel:** stdio between the provider and `claude-agent-acp` (newline-delimited
  JSON-RPC, `@agentclientprotocol/sdk`).
- **Tool channel:** the agent starts `mcp-runtime.js` as an MCP server over stdio. The runtime
  forwards each `tools/call` over **TCP** to the `McpHost` inside the provider, which
  **defers** it until OpenCode has run the tool.

---

## 3. Components (`src/`)

### `provider/model.ts` — `ACPOrchestratorModel`
The core. Implements `doStream`/`doGenerate` and keeps **one persistent ACP session per
conversation**.

- **Connection** (`connect`): spawns the agent with its environment and opens a
  `ClientSideConnection`, then `initialize`. The environment it sets:
  - `CLAUDE_CODE_EXECUTABLE`;
  - `CLAUDE_CONFIG_DIR`, only with `configDir: "isolated"` or a path;
  - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (`autoCompactPct`, default 75);
  - `ANTHROPIC_MODEL`, only when `claudeCode.model` is set;
  - `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT`, only with `streamCloseTimeoutMs`. claude-agent-acp
    0.31 doesn't read it.

  `requestPermission` is **not** auto-approved: it goes through the permission bridge (§4).
- **Session identity:** one `TurnState` per conversation, in a `Map` keyed by the OpenCode
  session id, plus an index by ACP `sessionId` to route the agent's callbacks. Recreating a
  session throws away Claude's prompt cache, which lives and dies with it, so it is recreated
  as rarely as possible:
  - `systemKey` only counts **if the system prompt actually travels**. With
    `systemPromptMode: "preset"` (the default) it doesn't, so switching agents in OpenCode
    recreates nothing.
  - `toolsKey` doesn't recreate either: a different tool set is applied live with an MCP
    `notifications/tools/list_changed`.
  - `cfgKey` is the full **creation profile**: `buildClaudeCodeOptions` without model and
    effort, plus `systemPromptMode`. When it changes (an agent with other native tools), the
    session is **forked** (`unstable_forkSession` with the new `_meta`, `forkInPlace`) instead
    of recreated.
  - A different acp model is applied with `unstable_setSessionModel`. There is **one**
    orchestrator (one agent process) for every model of the provider; each model id is an
    `ACPModelView` over it (`factory.ts`).
  - A call without tools (titles or summaries in programmatic use) goes to a separate
    `:notools` session that closes after answering. Inside OpenCode the plugin sets titles
    without a model.
  - A per-conversation lock (`withLock`) guards creating and reusing a session.
- **History sync** (`history.ts`): two fingerprints of what the agent already knows.
  - `sentKeys`: the legacy per-message keys.
  - `sentAnchors`: the user's messages plus tool-call ids.
  - `historyMode` decides which one acts; `shadow` logs every disagreement.
  - The incoming prompt is classified as *append* (send only the tail), *revert* or
    *divergence*.
  - The tail is cleaned of the agent's **own output** (`dropOwnLead`: emitted texts in
    `ownTexts`, ids with its own prefix in `ownPrefixes`).
  - Another model's turns travel as `<other_model_turn>`. A full replay is a bounded
    `<conversation_history>` (about 400,000 characters, newest kept).
- **Turns and generations:** each `session/prompt` carries a generation (`sendPrompt`). The
  completion of an old one, cancelled or merged by the agent's prompt queue, is ignored.
  `abortTurn` cancels, rejects the deferred MCP calls and drains pending permissions; `settle`
  waits for the old prompt to finish.
- **Stream buffer** (`emit`/`flushPending`): text and thinking arrive over the ACP stdio,
  while tool calls arrive over the host's TCP socket, with no guaranteed order. When a tool
  call closes the stream, whatever keeps arriving is **buffered** and flushed into the
  continuation stream instead of being lost.
- **Factual context** (`contextBlocks`): with `preset`, OpenCode's system prompt never reaches
  the agent. So its `<env>` block (and `<available_references>`) is forwarded as **user**
  content: in full the first time, then only the changes.
- **`effectiveCtrl(options)`**: merges `config.claudeCode` with `providerOptions.acp`
  (per-agent or per-call mode, effort, thinking, systemPromptMode and the native toggles).
- **`applySessionConfig`**: applies the model (`unstable_setSessionModel`), the `mode`
  (`setSessionMode`) and the `effort` (`setSessionConfigOption`) **live**, without
  recreating the session.
- **Deferred tool flow:** see §4.
- **Usage** (`usageNow`): the context size comes from `usage_update.used`, the last request.
  `PromptResponse.usage` is the SUM over the turn and only provides the cache proportions.
- **Compaction:**
  - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` makes Claude Code compact its own session first.
  - A compaction request from OpenCode (`requestKind`) is served in the live session
    (`serveCompaction`).
  - With `historyMode: "v2"`, a hidden native `/compact` follows (`nativeCompact`) and the
    checkpoint is adopted with no new session.
- **Resources:**
  - `session/close` (through `extMethod`) when a session is dropped;
  - idle sweep (`sweepIdle`) with per-session and per-subagent TTLs;
  - an LRU cap of `maxLiveSessions` (default 6).

### `acp/mcp-host.ts` — `McpHost`
TCP server inside the provider. `setTools()` receives OpenCode's tools; it answers the
runtime's `getTools`/`callTool`. It **defers** each `callTool`: it keeps
`{socket, runtimeId}` per `toolCallId` and answers when OpenCode delivers the result
(`resolveToolCall`), or fails it (`rejectToolCall`).

### `acp/mcp-runtime.ts`
**Dependency-free** stdio MCP server (only `node:net`/`node:readline`) that the agent spawns.
It forwards `tools/list`/`tools/call` over TCP to the host (port in `ACP_TOOL_HOST_PORT`).
- **No client-side timeout:** a `tools/call` can wait for OpenCode as long as the agent allows
  (`MCP_TOOL_TIMEOUT`, about 27 h in claude-agent-acp 0.31).
- **Forwarding:** `_meta["claudecode/toolUseId"]` and the agent's `notifications/cancelled` go
  on to the host.
- **Shutdown:** it is hardened against `EPIPE`/`ECONNRESET`, which happen when the agent kills
  it on close.

### `acp/claude-config.ts`
`ClaudeCodeControl` (the options type), `buildClaudeCodeOptions` (builds
`_meta.claudeCode.options`) and `resolveConfigDir`/`prepareIsolatedConfigDir`.

- **"Clean brain" by default:**
  - `tools: []`, `settingSources: []`;
  - `strictMcpConfig: true`, so no claude.ai connectors;
  - `allowedTools: ["mcp__opencode"]`, so OpenCode's own tools never trigger a second prompt.
- **Config dir:** the default is `configDir: false`. The agent keeps its state in your
  `~/.claude`, so sessions can be resumed with `claude --resume <id>`. That doesn't pull in
  your ecosystem: `settingSources`/`tools`/`strictMcpConfig` still decide what loads.
  `"isolated"` uses `~/.acp-model-provider/claude-config` with `~/.claude/.credentials.json`
  **symlinked** in, re-linked on every start: the agent may replace the link with a stale
  copy when it refreshes the token, which ends in 401s.
- **Native feature toggles** (they compose `tools`/`settingSources`/`agents`/`settings`; all
  off = clean brain): `nativeTools`, `resourceSearch`, `nativeSubagents` (adds
  `DEFAULT_SUBAGENT`, which delegates to OpenCode's tools), `nativeSkills`, `projectMemory`,
  `skillShell`, `allowedTools`. A raw override (`ctrl.tools`/`ctrl.settingSources`) **wins**
  over the composition.

### `plugin/index.ts` · `bridge-rules.ts`
- **`provider.transform`:**
  - discovers the models, with a 1 h cache;
  - builds `Model.Info[]` (`buildModelsInfo`);
  - **registers** the `acp` provider (`package: aisdk:<spec>`; `settings` = the agent config).

  Without `command` (or `ACP_COMMAND`) it registers nothing, so you can declare the provider
  by hand. An `acp` provider that already exists is kept as it is.
- **`agent.transform`:**
  - **Injection.** Adds `claude-code`/`claude-code-plan`, or the plugin's `options.agents`,
    which **replaces** that list; `agents: false` injects none. It only fills empty fields
    (`description`, `model`), so it stays idempotent across config reloads and respects your
    config.
  - **Rules it adds.** `{action:"question", resource:"*", effect:"allow"}` when the agent has
    the `question` tool, because the bridge's dialog runs through it. `compress: deny`, for
    the DCP plugin: rewriting OpenCode's copy of the history would only force cold replays.
  - **Publishing.** It **publishes** every agent's rules to the bridge (`publishAgentRules`),
    not only its own: a subagent inherits its parent's model and may run on this provider.
- **`session.hook("context")`**, also for the `compaction` and `generate` calls (only for the
  `acp` provider), injects per call:
  - `ocSession`/`ocAgent`/`requestKind`;
  - the registry's `resumeId`/`resumeLen`/`resumeLastUsage`/`resumeConvKey`/`resumeIdPrefixes`;
  - the agent's Claude options (`mode`, native toggles…).

  V2 passes no provider options from config: everything the model needs comes through this
  hook.
- **`session.hook("title")`:** names the session from the first user message with no model
  call (`titleFrom`), unless the `titleFromModel` option is set.
- **`event.subscribe`:** `session.revert.committed|cleared` → `clearLink`, so a restart never
  resumes a session that remembers undone turns. The live session handles the revert itself
  (`smartRevert`, §4).
- **`bridge-rules.ts`** (shared by plugin and provider, like `sessions.ts`):
  - a per-agent rule store plus the persistent `~/.acp-model-provider/always.json`;
  - `evaluate()` mirrors V2's `Permission.evaluate` with **one deliberate difference**: it
    ignores `action:"*"` rules, because V2's defaults are `*: allow` and would approve every
    native tool. The default is `ask`.

### `plugin/discover.ts` · `catalog.ts` · `cache.ts` · `sessions.ts` · `compat.ts`
- `discover`: a **short-lived** ACP connection → `availableModels`, `modes`,
  `promptCapabilities`, agent version.
- `catalog`:
  - model metadata from `~/.cache/opencode/models.json` (or models.dev);
  - effort `variants` (low, medium, high, xhigh, max);
  - the agent's `default` maps to the Opus family.

  `buildModels` serves the CLI and diagnostics; `buildModelsInfo` produces the `Model.Info[]`
  for `provider.transform`.
- `cache`: TTL caches in `~/.acp-model-provider/`.
- `sessions`: the `sessions.json` registry (OpenCode session id ↔ ACP sessionId, plus
  usage, conversation key and id prefixes). It is pruned to 30 days / 500 entries.
- `compat`: load-time warnings when OpenCode or `claude-agent-acp` is outside the tested range.

### `provider/factory.ts` · `env.ts` · `history.ts` · `recorder.ts` · `bin/cli.ts` · `log.ts`
- `factory.ts`: the provider factory. One shared `ACPOrchestratorModel`, plus an
  `ACPModelView` per model id.
- `env.ts`: config from environment variables.
- `recorder.ts`: the `ACP_RECORD` recorder (§5).
- `bin/cli.ts`: the `sync` command (`npx opencode-claude-code-acpbridge sync claude-agent-acp`).
- `log.ts`: the shared logger.
  - Daily file log in `~/.acp-model-provider/logs/acp-YYYYMMDD.log`. `ACP_LOG=0` turns it off;
    `ACP_LOG_DIR` moves it.
  - `ACP_DEBUG=1` adds the debug lines on stderr.

---

## 4. Key flows

### Deferred tool call (the core of "OpenCode orchestrates")
1. `doStream` receives the prompt and the tools. The provider exposes the tools through
   `McpHost` and sends the prompt to the agent.
2. The agent decides to use a tool and calls the `mcp-runtime` MCP server, which forwards
   `callTool` over TCP to the `McpHost`.
3. `McpHost.onToolCall` → the provider **emits to OpenCode**
   `tool-input-start/delta/end` → `tool-call` (with the **real** tool name) →
   `finish("tool-calls")`, and **leaves the MCP `callTool` pending**.
4. OpenCode runs the tool (permissions, TUI) and brings the `tool-result` in the **next**
   `doStream`.
5. The provider detects the continuation (`detectContinuation`) and calls
   `McpHost.resolveToolCall(id, result)`. The MCP `callTool` finally answers and the agent
   continues the same turn.

Details:
- **Grouping by step.** Tool calls are grouped per step (`addStepItem`/`closeStep`). Read-only
  ones wait `toolBatchMs` for their siblings, and all of them leave with a **single** `finish`.
- **Late calls.** Calls that arrive once the stream has closed are queued (`queuedItems`) and
  leave at the start of the next continuation.
- **Messages after the results.** If the continuation brings messages after the tool results
  (a steer, a `<system-update>`, a subagent result, the max-steps prefill), they go into the
  running turn: as a queued prompt, or appended to the last result when the agent doesn't
  support `promptQueueing`.
- **Aborts.** If a result is `aborted` and a new message follows, the old turn is cancelled and
  the message goes as a new turn.
- **Cancelled calls.** An agent `notifications/cancelled` withdraws a call that hasn't been
  emitted yet.

### Sessions: incremental messages (the central requirement)
ACP is a live session: the agent remembers everything already sent. So **re-sending the
whole history every turn burns tokens and breaks the prompt cache** (commit `4a7d7be`, 0.8.0).
OpenCode, on the other hand, always builds the full prompt. The provider decides what actually
travels:

- **Reuse** (same process, same conversation): the fingerprints detect an *append* and only
  the **tail** is sent, without the agent's own output. Nothing is re-sent and the cache stays
  warm. Turns by another model (after a model switch) travel as `<other_model_turn>`.
- **Resume** (new process): the `context` hook brings `resumeId`/`resumeLen` from the
  `sessions.json` registry. If the history grew without diverging and the conversation key
  matches, `unstable_resumeSession(acpSessionId)` resumes it and only the unseen part travels.
- **Profile change** (`cfgKey`): fork of the live session with the new options, no replay.
- **System prompt change** (only when it travels: `append`/`replace`): a new session with a
  bounded replay.
- **Revert:**
  - with `smartRevert` (default on), the session is forked back to the point before the
    reverted message (`resumeSessionAt`, from the transcript checkpoint), with no replay;
  - if that isn't possible, a new session with a bounded replay.
- **Compaction:** served in the live session (see `serveCompaction`). With `historyMode: "v2"`
  the resulting `<conversation-checkpoint>` is adopted without a new session.
- **Any other divergence:** a new session with a bounded replay.

### Mode and effort per agent
Per-agent options travel like this:
1. They live in `plugins[].options.agents.<name>.options`, because V2's `Agent.Info` has no
   `options` field.
2. The `context` hook puts them in `event.options` on every call.
3. V2 nests them as `providerOptions.<providerID>`.
4. `doStream` reads them (`effectiveCtrl`).
5. `setSessionMode`/`setSessionConfigOption` apply them live.

The effort chosen as a **model variant** (`acp/default#high`) lands in the same place, through
the variant's `settings`. An explicit `effort` of the agent wins (request > model defaults).
`effort` only applies when the model exposes levels in `session/configOptions`; otherwise
it's a non-fatal warning.

### Permission bridge (native tools)
When the agent uses a **native** Claude Code tool that OpenCode can't run for it (Skill,
NotebookEdit, WebSearch, native subagents, ExitPlanMode…), Claude Code calls
`requestPermission` (ACP). The provider routes the decision:

1. **Rules first** (`evaluate` in `bridge-rules.ts`). With `ocAgent`, the native tool name
   (the first word of the ACP tool title) and its target (the skill name, the notebook path,
   the command…), it looks at the published rules and `always.json`.
   - `allow`/`deny` decide with **no dialog**.
   - `action:"*"` rules are ignored, and the default is `ask` (fail-safe).
2. **`ask` → a `question` dialog.** `onRequestPermission` returns a pending Promise and
   **emits to OpenCode** a tool call of OpenCode's own **`question`** tool
   (`{questions:[{question, header:"Permission", options:[Allow once, Always allow, Deny]}]}`),
   then `finish` (same pattern as a tool call). OpenCode runs `question` and the dialog shows
   up in the TUI.
3. **The answer.** The next `doStream` carries the `question` result.
   - `detectContinuation` tells it apart from tool results (`pendingPermissions` vs
     `pendingTools`), and `questionVerdict` parses it: the exact label of the typed output
     (`{answers:[["Always allow"]]}`), or the rendered text (`"q"="Always allow"`).
   - `Always allow` stores the rule in `always.json` (`addAlwaysRule`).
   - **Anything ambiguous fails CLOSED** (deny), including a free-form typed answer.

Robustness:
- **Cancel.** In V2, OpenCode reads each stream to the end, so a cancel is a **real abort**
  (`onCancel` → `abortTurn`).
- **Draining.** Ending a turn drains `pendingPermissions` as deny, so the agent never hangs.
  A request that arrives with the stream closed is **queued** for the next continuation.
- **Ids.** Question ids carry the session's own prefix (`<idPrefix>perm_N`).
- **No `question` tool.** If the agent lacks `question` (`hasQuestion` from the hook), the
  request is denied with a reason.
- **ExitPlanMode.** It shows the agent's real options (`askPlanApproval`); a typed answer
  rejects the plan and reaches Claude as feedback.

### Billing (subscription vs extra usage)
Anthropic classifies the session by its **system prompt**. Forwarding OpenCode's
(`append`/`replace`) makes it a third-party app, billed as *extra usage*. With `preset` (the
default) it's the official `claude_code` preset, so it counts against the **subscription**.
This was established empirically (`scripts/verify-billing.mjs`); see the billing section of
the README.

---

## 5. Build and tests

```bash
npm install
npm run build            # tsc → dist/
npm test                 # tsc + node --test "test/*.test.mjs"
npm run check:install    # installs the packed package like OpenCode does and loads it
```

**Before touching history sync**, run `npm test`. What the suite contains:
- **Fake agent.** `test/fake-agent.mjs` speaks real ACP and drives the real `mcp-runtime`.
- **Characterization.** `test/characterization.test.mjs` pins the behaviours that must stay
  (KEEP) and every bug fixed so far.
- **Real fixtures.** `test/fixtures/v2/*.jsonl` are **real** OpenCode V2 prompts, recorded with
  `ACP_RECORD=<dir>` and anonymized with `scripts/sanitize-recording.mjs`.
- **Other suites.** `plugin`, `sessions`, `fixtures` and `compat`.

A change to `history.ts` without a real fixture behind it doesn't go in: this logic has
broken several times (0.8.0, 9299af9).

**Switching `historyMode` from `shadow` to `v2`:**
1. Use OpenCode normally for a while in `shadow` (the default).
2. Look for `shadow-diff` lines in `~/.acp-model-provider/logs/acp-YYYYMMDD.log`. Each one is
   a turn where the anchor fingerprint would have decided differently.
3. If they only show cases where `v2` avoids a needless reset, set
   `claudeCode.historyMode: "v2"` (or `ACP_HISTORY_MODE=v2`).

**Smoke test in OpenCode V2** (a test project whose `opencode.json` loads the plugin by its
absolute directory path):

```bash
cd <project> && ACP_DEBUG=1 opencode run --standalone --agent claude-code -m acp/default "reply only: ok"
```

Check the log, in this order:
1. `loading plugin`;
2. `[acp-plugin] auto-registered provider 'acp' … models: …`;
3. `agents registered: claude-code, claude-code-plan`;
4. `[acp-orchestrator] connected to agent`.

Notes:
- `opencode run` **without `-m` ignores the agent's `model`** and uses the global model from
  config: that's how the V2 CLI behaves.
- The bridge's `question` dialog needs the interactive TUI.

**Verification scripts** (`scripts/`, not published to npm; they need `dist/`). They run
against the real `claude-agent-acp`; `VERIFY_MODEL=haiku` makes them cheaper.

| Script | What it checks |
| --- | --- |
| `verify-session-continuity.mjs` | session reuse across turns, revert without memory of undone turns |
| `verify-interleave-fix.mjs` | another model's turns in between are caught up |
| `verify-stream-integrity.mjs` | tool calls, reasoning block, text not cut |
| `verify-smart-revert.mjs` | a revert forks the session instead of replaying (`ACP_RECORD` decisions) |
| `verify-billing.mjs` | every native feature keeps usage on the **subscription** |
| `spike-permission-bridge.mjs` | the permission bridge end to end (approved creates the file, denied doesn't) |
| `check-install.mjs` | `npm pack` + install like OpenCode, then load the plugin and provider |

**Spikes** (without OpenCode): `.mjs` scripts inside the repo that import `../dist/...` and use
the AI SDK's `streamText` or the ACP SDK directly:

```js
import { streamText } from "ai";
import { createACPModelProvider } from "../dist/index.js";
const model = createACPModelProvider({ command: "claude-agent-acp", claudeExecutable: "…" }).languageModel("sonnet");
for await (const p of streamText({ model, prompt: "say ok", providerOptions: { acp: { mode: "bypassPermissions", effort: "low" } } }).fullStream) { /* … */ }
```

**Inspecting what the provider sends:** set `ACP_RECORD=<dir>`. Each conversation gets a JSONL
file with:
- the prompt OpenCode sent, with large payloads cut;
- the decision taken (`new` / `reuse` / `continuation` / `smart-revert` / `shadow-diff`…);
- the blocks that actually went to the agent.

Cost note: a real prompt counts against your subscription. Inspection spikes (discovery,
building config, `setSessionMode`) spend no tokens.

---

## 6. Extending

- **New built-in agents:** edit `agentDefs()` in `plugin/index.ts`.
  - Each entry is `{ name, description, model, variant, options }`.
  - Users replace the whole list with a plain-object `plugins[].options.agents` (no merge
    with the built-in profile), or turn it off with `agents: false`.
  - `model` and `description` are only filled when the user hasn't set them in OpenCode's
    `agents` section.
- **New per-call parameters:** add them to `ClaudeCodeControl`.
  - Read them in `effectiveCtrl`, adding the key to its allow-list so it can come per agent.
  - If they apply at runtime, apply them in `applySessionConfig`. The available calls are
    `setSessionMode`, `setSessionConfigOption` and `unstable_setSessionModel`.
- **More model metadata:** `catalog.ts` (`buildModels`/`matchCatalog`).
- **Another ACP agent (not Claude Code):** the provider is generic ACP; the command and binary
  come from the options. The Claude-specific parts live in `claude-config.ts`.

---

## 7. Non-obvious design decisions

- **Common native tools disabled.**
  - What: `disallowedTools` on the built-in agents covers Bash, Read, Write, Edit, MultiEdit,
    Glob, Grep, WebFetch and TodoWrite, plus `tools: []` in the clean brain.
  - Why: two executors would break "OpenCode orchestrates", and what a native tool reads never
    reaches OpenCode's history. After a switch to another model that content would be gone.
- **The MCP runtime runs with `node`, not `process.execPath`.** Inside OpenCode,
  `process.execPath` is the `opencode` binary, which doesn't run an arbitrary JS script.
  Override with `ACP_RUNTIME_NODE`.
- **Isolated config dir needs the credentials link.** An empty dir breaks auth, so
  `~/.claude/.credentials.json` is **linked** in.
- **`systemPromptMode: "preset"` by default.** Any other mode forwards OpenCode's system prompt
  and triggers *extra usage*.
- **EPIPE hardening.** When the agent closes (e.g. after an API error), sockets and pipes raise
  EPIPE. This is handled in `model.ts`, `discover.ts`, `mcp-host.ts` and `mcp-runtime.ts`.
- **The `default` model.**
  - What: `default` is Claude Code's recommended model, an Opus with a 1M context.
  - Observed: `sonnet[1m]` is billed as *extra usage*.
