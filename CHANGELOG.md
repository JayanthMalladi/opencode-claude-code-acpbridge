# Changelog

All notable changes to `opencode-claude-code-acpbridge`. The format is based on
[Keep a Changelog](https://keepachangelog.com/) and versions follow [SemVer](https://semver.org/).

> **OpenCode V2 only since 0.9.0.** Versions 0.9.0 and later load only in OpenCode V2. If you
> are still on OpenCode V1, stay on 0.8.x. See [MIGRATION_V2.md](MIGRATION_V2.md).

## [0.11.0] — 2026-10-26

### Changed — breaking

- **One agent per Claude Code mode.** The plugin injects a `claude-<mode>` agent for every
  session mode the agent reports: `claude-default`, `claude-plan`, `claude-acceptedits`,
  `claude-auto`, `claude-dontask`, `claude-bypasspermissions` (the six known modes when
  discovery has none). They replace `claude-code` and `claude-code-plan`, with no aliases:
  rename those agents in your `agents` section (`claude-code` → `claude-default`,
  `claude-code-plan` → `claude-plan`). The mode only governs Claude's native tools; OpenCode's
  tools keep the agent's OpenCode permissions. Effort stays a model variant; `claude-plan`
  keeps `high`.
- **The `acp` models are paired with the Claude Code agents** (`pairModels`, default `true`).
  OpenCode V2 offers every model to every agent, so the plugin enforces it:
  - selecting an agent or model that breaks the pair moves the session back to a valid model
    (the agent's own, the session's last non-`acp` model, or OpenCode's default `model`);
  - an `acp` request from any other agent fails at once (HTTP 400, `x-should-retry: false`);
  - OpenCode subagents launched from a `claude-*` agent get their own model or the default one
    instead of inheriting `acp`.

  Agents you declare with an `acp/…` model count as Claude Code agents. `pairModels: false`
  restores the old behaviour.
- The usage-limit error now says to switch agent rather than model.

### Fixed

- **Each effort variant started its own agent process.** OpenCode V2 builds a new SDK instance
  for every distinct model `settings`, and the effort variants are settings, so `#high`,
  `#low` and the plain model each spawned a `claude-agent-acp` that resumed the same Claude
  session apart from the others (cache partly cold; going back to a variant found a process
  that had missed the turns in between). Provider instances built from the same agent config
  now share one orchestrator: effort switches live with `setSessionConfigOption`, and the
  model without a variant restores the session's own effort.

## [0.10.1] — 2026-10-23

### Fixed

- **The usage-limit error was retried by OpenCode ≥ 2.1.** OpenCode 2.1 no longer decides
  retries by the wording of the error message: any error it cannot classify is retried,
  about 10 attempts over ~84 s, before the user can switch models. The error is now an
  `APICallError` with HTTP 402 and `x-should-retry: false`. OpenCode classifies that as
  `QuotaExceeded` and fails at once.

### Changed

- Documentation translated to English and rewritten for newcomers; OpenCode V2 only stated
  explicitly.
- Runtime messages (usage-limit error, session notes, mode-change notice) translated to English.
- `@opencode/plugin` peer range narrowed to `^2.0.14` (excludes a future 3.x).

### Added

- MIT `LICENSE` file.
- Load-time compatibility warnings: OpenCode major version, and `claude-agent-acp` older than
  the tested 0.31.
- `prepublishOnly` install check (`scripts/check-install.mjs`).

## [0.10.0] — 2026-10-22 — history sync, concurrency and continuity across models

A full review of the bridge against the OpenCode V2 source, `claude-agent-acp` 0.31 and
**real** recorded sessions. The goal: switch between `acp` and other models in the same
session without losing anything, and reuse the Claude Code session whenever possible.
Everything below is covered by `npm test` (a fake ACP agent plus real V2 prompts) and by the
scripts that run against the real agent.

### Fixed

- **Claude's own reply was resent every turn** as `"Assistant: …"` inside the user message
  (seen in transcripts; the model once called it "a fake message"). The provider now
  recognises its own output (emitted texts, ids carrying its prefix) and does not send it back.
- **Lost messages**: what you typed while the agent was working (a *steer*), and the message
  sent after **interrupting** a tool, were treated as a continuation of the turn and never
  arrived. Now a steer joins the running turn (Claude Code's native queue), and an
  interruption cancels the turn before the new message is sent.
- **Turns by another model attributed to Claude**: they arrived as
  `Assistant: [Called tool …]`, so Claude believed it had made them. They now come wrapped in
  `<other_model_turn>`.
- **Concurrent tool calls dropped** (native subagents running in parallel): the second call
  was lost and the turn hung. Calls are now queued; read-only ones (`readOnlyHint`) are batched
  into one step that OpenCode runs in parallel.
- **Security**: the bridge's `perm_N` ids repeated across processes, so an old answer
  ("Always allow") could approve a new permission. Ids now carry their own prefix and the last
  match wins.
- An old prompt finishing (cancelled or merged) closed the stream of the following turn; text
  from an aborted turn showed up at the start of the next one.
- Two simultaneous calls for the same conversation created two sessions (one orphaned).
- **Usage**: `PromptResponse.usage` is the sum of every request in the turn; reporting it as a
  single request inflated the context size and triggered early compactions. The real context
  occupancy (`usage_update.used`) is reported now, also on tool steps.
- **Sessions were never closed**: each one left a `claude` process running. Now
  `session/close` is sent when a session is discarded, with an idle TTL (15 min; subagents
  2 min) and an LRU of 6.
- **Junk titles** (`<invoke name="Read">`): with `preset`, the title instructions never reached
  Claude. The plugin now titles the session from its first message, without calling the model.
- **OpenCode subagents running on `acp`** (they inherit the parent's model): with no profile,
  every OpenCode tool asked the bridge for permission, and `general` (which has no `question`
  tool) got them denied. Now every agent auto-allows OpenCode's tools, and the bridge denies
  with a reason when the agent cannot ask. Rules are published for every agent.
- Switching to an agent with a different native profile reused the session with the old
  profile; it now **forks** it (`session/fork`), keeping the context.
- Going back from plan to `claude-code` downgraded to `default` the mode chosen when the plan
  was approved.
- Resume after a restart resent the provider's own traffic, and happened even when the
  registry entry belonged to another conversation; the registry is now also updated mid-turn.
- A session lost on the agent side (dead `claude` process) failed on every turn; it is now
  dropped and resumed.
- `mcp-runtime` ignored SIGTERM (registering the handler disables the default exit).

### Added

- **Native compaction**: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=75` (`autoCompactPct`) makes Claude
  compact before OpenCode does; if OpenCode compacts, the summary comes from the **live
  session** (before: a full cold replay, 17K+ characters in the recording).
- **`historyMode`** (default `shadow`): a fingerprint made of anchors (user messages + tool ids)
  that is immune to V2 re-rendering (reasoning→text, model switches), transient plan reminders
  and DCP tags. In `shadow` it only logs disagreements; `v2` decides, and also adopts
  OpenCode's checkpoint or catches up with another model's.
- **`smartRevert`** (on by default): a revert forks the session right before the reverted
  message (`resumeSessionAt`) instead of replaying; `false` turns it off.
- **One agent process for every model** of the provider; switching models uses
  `session/set_model` without losing the session.
- **Portable native activity** (`nativeActivity`): Task/WebSearch/Skill leave a `⚙ …` line
  (with its result) in the reply, so any model can see it.
- **ExitPlanMode** with the real options (auto / accept edits / approve each edit / keep
  planning); a typed answer comes back as feedback.
- Claude usage limit → a clear, non-retryable error ("switch models").
- Bounded (~400K characters) and labelled replay; the current request is sent separately.
- V2's initial **Code Mode** catalog is forwarded as context.
- Log file under `~/.acp-model-provider/logs/`, the `ACP_RECORD` recorder,
  `scripts/sanitize-recording.mjs`, the `npm test` suite, `scripts/verify-smart-revert.mjs`.
- Options: `historyMode`, `catchupResultChars`, `parallelTools`, `toolBatchMs`,
  `autoCompactPct`, `nativeActivity(Chars)`, `maxLiveSessions`, `idle/childSessionTtlMs`,
  `smartRevert`; plugin: `titleFromModel`.

### Changed

- Native `Read` is no longer in the default profile (what it read never reached OpenCode's
  history); V2's `read` covers images and PDFs.
- `allowedTools` defaults to `["mcp__opencode"]` for every agent.
- The `claude-code*` agents deny `compress` (opencode-dcp).
- The session registry has an in-memory cache and pruning (30 days / 500 entries).

## [0.9.0] — 2026-10-01 — OpenCode V2

> ⚠️ **0.9.0+ works only with OpenCode V2; for OpenCode V1 stay on 0.8.x.**
>
> The port is a **complete runtime breaking change**: the V1 plugin
> (`export default { id, server }`, `config`/`chat.params` hooks) does not load in OpenCode V2,
> and the V2 plugin (`Plugin.define`) does not load in OpenCode V1.

Port of the plugin and the provider to OpenCode's **V2** plugin runtime.

### Breaking changes

| Area | V1 (0.8.x) | V2 (0.9.0) |
| :--- | :--- | :--- |
| **Plugin runtime** | `export default { id, server }`, `config`/`chat.params` hooks | `Plugin.define({ id, setup })` with the promise API (`setup` returns a cleanup) |
| **Plugin config** | `"plugin": [[pkg, {opts}]]` | `"plugins": [{ "package", "options" }]` |
| **Provider auto-registration** | the `config` hook mutated `cfg.provider.acp` | `provider.transform` registers it as `aisdk:<spec>` (with `options.command`); if you declare `provider.<id>` by hand, it is not overwritten |
| **Per-call injection** | `chat.params` hook → `providerOptions.acp.{ocSession, resumeId, resumeLen}` | `session.hook("context")` → `ocSession`, `ocAgent`, `resumeId`, `resumeLen`, `resumeLastUsage`, `resumeConvKey`, plus the agent's options, per call |
| **Agents (config)** | `agent:` section with `permission` (map `{tool: "allow"\|"deny"\|"ask"\|glob}`) and `disable` | `agents:` section with `permissions` (ruleset array `[{action, resource, effect}]`), `disabled` and `mode: "subagent"\|"primary"\|"all"` |
| **Per-agent options** | `agent.<n>.options` (mode/effort/native*) | `plugins[0].options.agents.<n>.options` (same options, different path) |
| **Permission bridge** | `claude_permission` meta-tool (an `ask` prompt via `ctx.ask`) | emits a **tool call to OpenCode's built-in `question` tool** (dialog `Allow once` / `Always allow` / `Deny`); rules from `agents.<n>.permissions` evaluated in `src/plugin/bridge-rules.ts`, **fail-closed** (deliberately ignores `action:"*"`); `Always allow` is saved in `~/.acp-model-provider/always.json` |
| **Effort variants** | `acp/opus:low` | `acp/opus#low` (`provider/model#variant`) |
| **Revert / compaction** | fingerprint via `chat.params` | `session.revert.committed\|cleared` events → `clearLink` |
| **Local development** | target = a file (`…/dist/index.js`) | target = a **directory path** with a root `index.js` (V2's `Host.resolve` looks for `<dir>/index.*`); files are rejected |
| **CLI** | `opencode run` applied `agent.model` | `opencode run` **without `-m` ignores `agent.model`** (uses the global model); use `-m acp/…` |
| **Requirements** | OpenCode V1 | OpenCode **V2 (`>= 2.0.14`)** and the `@agentclientprotocol/claude-agent-acp` agent (formerly `@zed-industries/claude-agent-acp`) |

Practical migration guide: [MIGRATION_V2.md](MIGRATION_V2.md) and the [README](README.md).

### Added

- **Provider auto-registration as `aisdk:<spec>`** (with `options.command`); if you declare
  `provider.<id>` by hand in config, the plugin no longer overwrites it (new guard).
- **Revert/compaction**: the plugin listens to `session.revert.*` and clears the session link
  → a full replay when the history diverges.
- **Local directory entrypoint**: a root `index.js` re-exports `dist/` (V2's `Host.resolve`
  looks for `<dir>/index.*`); in development, `package` = the directory path.

## [0.8.0] — 2026-08-21

A release focused on **token cost** and **session continuity**. Almost every problem had the
same root cause: the provider recreated the ACP session far too easily, and each recreation
means a full history replay and a cold prompt cache. Now a conversation survives changes of
agent, tools and system prompt while keeping the same Claude Code session.

### ⚠️ Breaking

- **`claudeCode.configDir` now inherits `~/.claude` by default** (previously `"isolated"`).
  Sessions started from OpenCode are now stored in `~/.claude/projects/…`, so **they can be
  resumed natively with `claude --resume <id>`** (the provider prints the id when it creates
  each session). This does **not** bring back the user's ecosystem: `settingSources`, `tools`
  and `strictMcpConfig` still decide what the agent loads; `configDir` only decides where its
  state lives. To get the old behaviour back: `"configDir": "isolated"`. A welcome side effect:
  the credentials symlink is gone, and with it the class of 401 desync bugs.
- **The advertised context limit is no longer inflated to 1M** for the `default` model; only
  the real `[1m]` variants declare it. Advertising 1M kept OpenCode's auto-compaction from ever
  triggering, and the conversation grew without bound.

### Fixed

- **Disproportionate token spend (the main cause).** `sentLen` was set at the start of the
  turn and not updated in the continuation branch, so every turn resent as plain text **all the
  `tool-call`/`tool-result` pairs of the previous turn** (full file dumps, shell output, greps)
  that the agent **already had** in its session. It also invalidated the prompt cache every
  turn. The state now records the fingerprint of the history already sent, and the provider's
  own calls (identified by the host's nonce prefix) are left out of the catch-up; other
  models' results are truncated to 2000 characters.
- **Switching agents destroyed the session and replayed everything.** `systemKey` hashed
  OpenCode's system prompt even with `systemPromptMode: "preset"`, a mode in which that system
  prompt is **never sent to the agent**. Any agent switch, or the churn of OpenCode's dynamic
  blocks (date, `AGENTS.md`, skills), recreated the session over text the agent never saw.
  The system prompt now counts as identity only when it is actually sent, and the
  `claude-code-plan` → build → `claude-code` flow keeps the same ACP session.
- **A change in the tool set no longer recreates the session.** It is applied live to the
  running session through `notifications/tools/list_changed` over the MCP channel.
- **The title/summary model call no longer destroyed the conversation.** It arrives with
  `tools=0` on the same model and session; it is now served by a separate throwaway session.
- **Truncated text and invisible reasoning (same cause).** Text and thinking arrive over ACP
  stdio, while tool calls arrive over the `McpHost` TCP socket, with no guaranteed ordering.
  When a tool call closed the stream, everything still arriving was **silently dropped**, and
  since thinking is emitted right before each tool call, it vanished almost entirely even with
  `effort: max`. Those chunks are now **buffered** and flushed in order into the continuation
  stream.
- **Reverting messages left both sides out of sync.** The provider kept only a counter, so a
  truncated history fell into a silent fallback that resent **the whole** history on top of a
  session that already had it. The history fingerprint is now compared to tell an *append*
  (send only what's new) from a *revert* / *compaction divergence* (new session from the
  truncated history). The plugin also listens to `session.updated` and drops the registered
  link as soon as the revert point moves.
- **Two simultaneous conversations destroyed each other's session.** There was a single
  `TurnState` per model instance, shared by every chat and subagent: each turn switched
  conversation and forced a full replay. There is now **one session per conversation** (with an
  LRU bound), and the agent's callbacks are routed by `sessionId`.
- **`claude-code-plan` had no way out of plan mode.** `ExitPlanMode` was not exposed to the
  agent, it did not see OpenCode's `plan_exit`, and the bridge forced `plan` again every turn:
  a closed loop that left all the already-written `switch_mode` handling dead. `ExitPlanMode`
  is now exposed, and **re-selecting the plan agent by hand re-applies `mode: "plan"`**
  (before, `modeChangedByAgent` was never reset).
- **Approving a plan granted `bypassPermissions`.** The first `allow_*` option offered by the
  agent was picked, and that is the broadest one. `default` (manual approval of edits) is now
  preferred for `switch_mode`.
- **The agent did not use OpenCode's `question` tool.** Its instruction lives in OpenCode's
  system prompt, which is not forwarded with `preset`, and its native `AskUserQuestion` is
  disabled by the ACP agent itself. The `question` tool's **description** now says so
  explicitly (a tool description is not a system prompt: it doesn't affect billing).
- **The agent had no web search.** OpenCode only registers its `websearch` for
  `providerID: "opencode"` (or with exa/parallel), and native `WebSearch` was in
  `disallowedTools`. Native `WebSearch` is now part of the profile.
- **Tool results arrived flattened to text**, losing images and attachments. Structured
  content is now mapped to MCP blocks.
- **A rejected `effort` was silently swallowed**; a warning is now printed to stderr.
- **Cancelling a turn no longer tears down the session**: the turn is cancelled and the session
  (and its cache) is kept for the next message.

### Changed

- **`claude-code` and `claude-code-plan` share exactly the same tool and permission profile**,
  and differ **only** in their initial mode. Before, they also differed in `nativeTools`, which
  left a half-way state: the agent left plan mode on its own (OpenCode does not switch agents
  because of it) and believed it could edit while OpenCode still gave it the restricted
  profile.
- **New option `claudeCode.forwardEnvContext`** (default `true`): forwards the **factual** part
  of OpenCode's system prompt (`<env>`: working directory, workspace root, git, platform, date;
  and `<available_references>`) as user context. With `preset` the system prompt never reaches
  the agent, so it worked without knowing where it was. Only factual blocks are sent, never
  OpenCode's behavioural instructions, so the session stays on the subscription (verified with
  `scripts/verify-billing.mjs`). It is sent in full once per session, then only the delta of
  what changed.
- The Claude Code session id is logged to stderr when the session is created, without needing
  `ACP_DEBUG`, together with the command to resume it.

### Known issues

- The per-turn `usage` breakdown is reported cumulatively by the ACP agent, and some turns may
  show a delta of 0; the session total is correct.

## Changes between 0.7.0 and 0.8.0

These entries were listed as "Unreleased" after 0.7.0 and shipped with 0.8.0.

### Added

- **Proper `ExitPlanMode` handling.** When the agent leaves plan mode (it arrives as a
  `requestPermission` with `toolCall.kind === "switch_mode"`):
  - the **plan** (markdown in `rawInput.plan`) is now **rendered as assistant text** before the
    approval prompt, instead of being buried in the metadata;
  - the permission is labelled consistently as **`ExitPlanMode`** (a
    `permission: { ExitPlanMode: "allow" }` rule is possible; by default it asks);
  - `current_mode_update` is now handled and, once the plan is approved (plan →
    default/acceptEdits), the bridge **stops forcing** the agent's mode again, so the
    implementation continues in the same session instead of going back to plan on the next
    turn.

### Fixed

- **Switching from a normal agent to `claude-code` (ACP) mid-session ignored all previous
  progress.** Both the live reuse of an ACP session (`this.current`, which survives an agent
  switch intact) and the `resume` after a process restart assumed that the only new thing
  since the last ACP turn was the latest user message (`lastUserBlocks`). If another agent
  (e.g. a different model) ran turns in the same OpenCode conversation in between, those turns
  never reached Claude Code: it resumed/reused with its old history plus only the newest
  message, which looked like a fresh session. `TurnState` now keeps `sentLen` (how far the
  agent's knowledge goes), and each send uses `catchUpBlocks`, which rebuilds as a transcript
  (with role prefixes) **everything** that happened from `sentLen` on: one message in the
  normal case, the whole stretch if another agent ran in between.
- **Corrupted tool results (stale/misrouted results).** The `toolCallId` was minted as
  `acp_${counter}` with a counter **per `McpHost`** that **reset to 0** on every ACP session
  reset (tool/system prompt change, new conversation, resume). Within one conversation
  OpenCode resends the whole history; after a reset a new call got `acp_1` again, and
  `detectContinuation` matched it with an **old** tool result in the history: glob returned a
  README, bash returned "background agent task launched", and so on. Each host now uses a
  **random nonce prefix** (`acp_<hex>_${counter}`), so ids never collide across sessions,
  process restarts or resumes.
- **`claude-code-plan`: subagents (`Task`) failed.** The plan agent had no `nativeSubagents`,
  so its `Task` was not Claude Code's native one but OpenCode's forwarded `task`. OpenCode then
  created subagents (`explore`, …) routed to **other providers** (`opencode-go`/`opencode`),
  which failed with *Bad Gateway* / *Insufficient Balance* / *ProviderModelNotFound*.
  `claude-code-plan` now shares the same native feature base as `claude-code` (native
  subagents that run on the subscription and delegate tools to OpenCode), with `mode: "plan"`
  and without the native editing tool (`NotebookEdit`), since plan mode is read-only.

## [0.7.0] — 2026-06-27

Native Claude Code capabilities inside OpenCode, with a **permission bridge** that keeps
OpenCode in charge of every action ("native power without breaking anything").

### Added

- **Permission bridge**: when the agent uses a **native** Claude tool (Skill, Read,
  NotebookEdit, Task, MCP resource search), its `requestPermission` (ACP) is routed to
  **OpenCode's `ask` prompt** through the `claude_permission` meta-tool. The prompt shows the
  **native tool** and the action; it supports **"Allow always"** and **per-tool glob rules**
  (`permission: { Bash: { "git *": "allow" }, Skill: { "*": "ask" } }`).
- **Native feature toggles** in `claudeCode` (they compose the SDK options; with all of them
  off you get the clean brain): `nativeTools`, `resourceSearch`, `nativeSubagents` (a subagent
  that delegates to OpenCode), `nativeSkills`, `projectMemory`, `skillShell`, `allowedTools`.
  Verified: **all of them keep the subscription** (0 extra usage).
- **Hybrid model**: common tools (bash/read/write/edit/grep/…) are orchestrated by OpenCode
  without double permission prompts (`allowedTools: ["mcp__opencode"]`); the better native
  tools go through the bridge.
- Native **`Read`** tool enabled in the `claude-code` agent (multimodal reading:
  images/PDF/notebooks).
- Verification scripts (`scripts/`): `verify-billing.mjs`, `spike-permission-bridge.mjs`.

### Changed

- The `claude-code` agent moves from `mode: "bypassPermissions"` to **`mode: "default"`** (so
  the bridge can act). The classic clean brain is still available (`mode: "bypassPermissions"`
  with no toggles).

### Fixed

- **`host closed`**: `onCancel` no longer tears down the session while a deferred tool call or
  permission is in flight (OpenCode cancels the stream when it pauses for the `ask`); a
  **watchdog** releases it if the continuation never arrives.
- **Auth desync (401)**: the credentials symlink of the isolated config dir is **re-linked on
  every start** (the agent could replace it with a stale file when refreshing the token).
- The bridge **fails closed** (denies on an ambiguous verdict); `endTurn`/reuse **drain**
  pending permissions so the agent is never left hanging.
- `claude_permission` is **filtered out of the host** (the agent no longer sees it as
  `mcp__opencode__claude_permission`).
- The agent no longer tries common native tools it cannot run (`disallowedTools`
  Bash/Write/Edit/…).

## [0.6.0]

### Changed

- **Renamed**: `acp-model-provider` → **`opencode-claude-code-acpbridge`** (a plugin dedicated
  to using Claude Code inside OpenCode).

### Added

- `strictMcpConfig` (default `true`): ignores the claude.ai account connectors
  (Gmail/Drive/Supabase/…).
- `thinking` defaults to `{type:"enabled", display:"summarized"}`: the **reasoning block** is
  visible in OpenCode.
- **Session resume across processes** (`sessions.json` registry + `unstable_resumeSession`).
- **Token usage reporting** (mapping of ACP's `PromptResponse.usage`).

## [0.5.x]

### Added

- **Provider auto-registration** (minimal config): discovers the agent's models and injects
  `provider.acp` with models.dev metadata.
- **Injected agents** `claude-code` / `claude-code-plan`, with per-agent mode/effort changed
  live; the user's config in `opencode.json` takes precedence (merge).
- **Subscription billing** (`systemPromptMode: "preset"`): 0 extra usage.
- Complete documentation (README + `docs/DEVELOPMENT.md` + `examples/`).
