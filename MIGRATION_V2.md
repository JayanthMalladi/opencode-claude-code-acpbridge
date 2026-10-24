# Migrating to OpenCode V2

> **This plugin is OpenCode V2 only since 0.9.0.** Versions 0.9.0 and later load only in
> OpenCode V2 (2.0.14 or later; tested on 2.1.1). If you still run OpenCode V1, stay on
> `opencode-claude-code-acpbridge@0.8.x`: the V2 plugin does not load there, and the V1 plugin
> does not load in V2.

This page has two parts:

1. **[Migration guide](#part-1--migration-guide)**: what you, as a user of this plugin, need to
   change when you move from OpenCode V1 (plugin 0.8.x) to OpenCode V2 (plugin 0.9.0+).
2. **[Design notes of the port](#part-2--design-notes-of-the-port-090)**: how the V1 plugin was
   mapped onto the V2 plugin API in 0.9.0. Useful if you want to understand or hack the code;
   later versions changed some internals (see [CHANGELOG](CHANGELOG.md)).

---

## Part 1 — Migration guide

### What changed, in plain words

OpenCode V2 rewrote how plugins work. A plugin is a package that OpenCode's **server** loads to
add features. This one adds two things:

- a **model provider** called `acp`, which sends your prompts to Claude Code over ACP (the
  Agent Client Protocol) instead of calling an API directly;
- two **agents**, `claude-code` and `claude-code-plan`, preconfigured to use that provider.

In V1 you declared the provider yourself and the plugin patched OpenCode's config at startup.
In V2 the plugin registers the provider and the agents itself through V2's plugin API. Your
config shrinks to one entry, and a few keys moved or changed shape.

### 1. Requirements

| | V1 (plugin 0.8.x) | V2 (plugin 0.9.0+) |
| --- | --- | --- |
| OpenCode | V1 | V2, **2.0.14 or later** (check with `opencode --version`) |
| ACP agent | `@zed-industries/claude-agent-acp` | `@agentclientprotocol/claude-agent-acp` (the same agent, renamed), on your `PATH` as `claude-agent-acp` |
| Claude Code | installed and logged in (`claude`) | same |

### 2. The plugin entry

V2 uses a `plugins` **array of objects** instead of V1's `plugin` array of tuples, and you no
longer declare a `provider` block:

```jsonc
// V1 (plugin 0.8.x)
{
  "provider": { "acp": { "npm": "…", "options": { … }, "models": { … } } },
  "plugin": [["opencode-claude-code-acpbridge", { "command": "claude-agent-acp" }]]
}

// V2 (plugin 0.9.0+) — this is all you need
{
  "plugins": [
    { "package": "opencode-claude-code-acpbridge", "options": { "command": "claude-agent-acp" } }
  ]
}
```

- The plugin **discovers the agent's models** and registers the `acp` provider on its own. If
  you still declare `provider.acp` by hand, the plugin leaves your definition alone.
- Put it in `~/.config/opencode/opencode.json` (every project) or in a project's
  `opencode.json`.
- OpenCode installs the package from npm the first time it needs it.

### 3. Agents and their permissions

V2 renamed the agents section and changed the permission format:

| | V1 | V2 |
| --- | --- | --- |
| Section | `agent` | `agents` |
| Permissions | `permission: { Skill: { "*": "ask" } }` (a map) | `permissions: [{ "action": "Skill", "resource": "*", "effect": "ask" }]` (a list of rules) |
| Turn an agent off | `disable: true` | `disabled: true` |
| Agent kind | — | `mode: "primary"` \| `"subagent"` \| `"all"` |

A V2 permission rule is `{ action, resource, effect }`:
- `action` is the tool name;
- `resource` is what the tool acts on (a path, a command…), with `*` / `?` globs;
- `effect` is `allow`, `deny` or `ask`.

When several rules match, the **last** one wins.

```jsonc
{
  "agents": {
    "claude-code": {
      "permissions": [
        { "action": "Skill", "resource": "*", "effect": "allow" },
        { "action": "WebSearch", "resource": "*", "effect": "ask" }
      ]
    }
  }
}
```

**How this applies to Claude Code's own (native) tools.** Most work goes through OpenCode's
tools, which OpenCode already authorizes. Claude Code's native tools (Skill, ExitPlanMode,
WebSearch, NotebookEdit, native subagents…) go through this plugin's **permission bridge**:
- It evaluates your `agents.<name>.permissions` rules for that native tool. `allow` and `deny`
  answer straight away.
- With no matching rule, or with `ask`, it shows OpenCode's **`question`** dialog with **Allow
  once / Always allow / Deny**. The V1 plugin used its own `claude_permission` prompt instead.
- "Always allow" is remembered in `~/.acp-model-provider/always.json`.
- Rules with `action: "*"` are **ignored on purpose**. V2's defaults contain `*: allow`, and
  honouring it would silently approve every native tool.
- Anything ambiguous is denied (fail closed).

### 4. Per-agent Claude options (mode, effort, native features)

V2's agent config has no `options` field, so the Claude-specific options moved into the
**plugin options**:

```jsonc
// V1
{ "agent": { "claude-code": { "options": { "mode": "default", "effort": "high" } } } }

// V2
{
  "plugins": [{
    "package": "opencode-claude-code-acpbridge",
    "options": {
      "command": "claude-agent-acp",
      "agents": {
        "claude-code": {
          "description": "Claude Code (subscription)",
          "model": "default",
          "options": { "mode": "default", "effort": "high" }
        }
      }
    }
  }]
}
```

> ⚠️ Setting `options.agents` **replaces** the two built-in agent definitions (`claude-code`,
> `claude-code-plan`) instead of being merged with them. Agents you leave out are not
> registered. The built-in native feature set (`nativeTools`, `nativeSubagents`, `nativeSkills`,
> `projectMemory`) is not added back either. If you only want to tweak one setting, copy the
> full definitions from the [README](README.md) and change what you need.
> `"agents": false` registers no agents at all.

The plugin sends these options to the provider on every call, through OpenCode's `context` hook.

### 5. Model variants (effort)

The separator between a model and its variant changed from `:` to `#`:

| V1 | V2 |
| --- | --- |
| `acp/opus:low` | `acp/opus#low` |

Variants are Claude Code's effort levels: `low`, `medium`, `high`, `xhigh`, `max`, offered for
models that support reasoning. Picking one sets `effort` for that call.

### 6. Running a local checkout

In V2, `package` must point at the plugin **directory**, which contains a root `index.js`. A
path to a file such as `dist/index.js` is not accepted:

```jsonc
{ "plugins": [{ "package": "/path/to/opencode-claude-code-acpbridge", "options": { "command": "claude-agent-acp" } }] }
```

Run `npm install && npm run build` in that directory first.

### 7. `opencode run` from the command line

On OpenCode 2.0.14, `opencode run` without `-m` ignored the agent's `model` and used the
global model. Pass the model explicitly to be safe:

```sh
opencode run -m acp/default --agent claude-code "your prompt"
```

### 8. Updating the plugin

OpenCode caches the plugins it installs from npm and does not refresh them on its own. In
OpenCode 2.1, `opencode plugin update` only handles TUI plugins, so to get a newer version of
this plugin:

1. stop OpenCode (close the app, or `opencode service stop`);
2. delete its cache entry: `rm -rf ~/.cache/opencode/npm/opencode-claude-code-acpbridge@*`;
3. start OpenCode again. It reinstalls the latest version.

### 9. Checking that it works

- Set `ACP_DEBUG=1` before starting OpenCode. The plugin then logs
  `[acp-plugin] auto-registered provider 'acp' (aisdk:…) — models: …`, both to stderr and to
  `~/.acp-model-provider/logs/acp-YYYYMMDD.log`.
- Pick the `claude-code` agent and send a message.
- To test the permission bridge, ask for something that uses a native tool (a Skill, or
  leaving plan mode). The `question` dialog appears and the turn continues after you answer.
- Revert a message in the TUI. With `ACP_DEBUG=1` the log shows
  `[acp-plugin] session … rewound — link dropped, next turn starts fresh`.

---

## Part 2 — Design notes of the port (0.9.0)

Source of truth: the OpenCode V2 source (`packages/core`, `packages/plugin`) and
`https://opencode.ai/v2/docs/`. The port targeted OpenCode 2.0.14; notes about 2.1 are marked.

### Overview

| Piece | Outcome of the port |
| :---- | :------------------ |
| Provider factory (`createACPModelProvider`) | Compatible as is. V2 (`plugin/provider/sdk-factory.ts`) imports the package, picks the first export whose name starts with `create`, and calls it with the provider options. |
| `LanguageModelV3` (`src/provider/model.ts`) | Compatible: OpenCode's AI SDK bridge takes AI SDK v6 providers (`@ai-sdk/provider` 3.x, the `^3.0.0` peer). Needed two adjustments (below). |
| ACP / MCP host / Claude config / sessions / cache / catalog | No V1 API involved, so unchanged (except `buildModelsInfo` → `Model.Info[]`). |
| Plugin (`src/plugin/index.ts`) | **Full rewrite**: the V1 plugin does not run in V2. |
| Permission bridge (`ctx.ask`) | **No V2 equivalent** at the time → new design based on the `question` tool. |
| `package.json` | `@opencode-ai/plugin` → `@opencode/plugin`. |

### Hook mapping V1 → V2

| V1 | V2 |
| :-- | :-- |
| `tool: { claude_permission }` | Removed (see the permission bridge below). |
| `"chat.params"` (injects `output.options`) | `ctx.session.hook("context")`, mutating `event.options`. Since 0.10.0 the same injection is also registered for the `compaction` and `generate` hooks, plus a `title` hook. Non-generation keys end up in `providerOptions[<providerID>]`. |
| `event` (`session.updated` + `info.revert` → `clearLink`) | `ctx.event.subscribe()`, filtering `session.revert.committed` and `session.revert.cleared` (`event.data.sessionID`). |
| `config` (provider + agent auto-registration) | `ctx.provider.transform` (`editor.add({info, models})`) + `ctx.agent.transform` (`editor.update(id, fn)`, an upsert). |
| `PluginModule { id, server }` | `export default Plugin.define({ id, setup(ctx) })`. V2 reads `id` + `setup()`. |
| `dispose` | `setup` returns a cleanup function. |

What the `context` hook injects on every call (simplified):

```ts
ctx.session.hook("context", (event) => {
  if (event.model.providerID !== providerId) return;
  event.options.ocSession = event.sessionID;      // which OpenCode session this is
  event.options.ocAgent = String(event.agent);    // which agent
  // resumeId / resumeLen / resumeLastUsage / resumeConvKey / resumeIdPrefixes from the registry
  // + the agent's Claude options (mode, effort, native features)
}, { providerID: providerId });
```

V2 passes no provider options from config to the model on its own, so everything the
provider needs per call travels through this hook. The plugin doesn't use the agent's
`request` field.

### Provider registration

- The provider is registered with `package: "aisdk:<spec>"` and `activation: "enabled"`:
  - when installed from npm, `<spec>` is `opencode-claude-code-acpbridge`;
  - from a local checkout, it is `file://<dir>/dist/index.js`;
  - `settings` are the plugin options minus the plugin-only keys.
- Models are `Model.Info[]` instead of the models.dev object. Effort levels become variants:
  `[{ id: "high", settings: { effort: "high" } }]`.
- V2 agent fields: `model | request | system | description | mode | hidden | color | steps |
  disabled | permissions`. There is no `options` field, hence the per-call injection. A model
  reference with a variant looks like `"acp/default#high"`.
- V1 permission maps convert to V2 rulesets: `permission: { Bash: { "git *": "allow" } }`
  becomes `permissions: [{ action: "Bash", resource: "git *", effect: "allow" }]`.

### Permission bridge (decision: OpenCode's `question` tool)

At the time of the port (2.0.14), V2 had no `ctx.ask`.
- The plugin permission API offered only `list`, `get`, `reply` and a `permission.evaluate`
  hook.
- Plugin tools didn't go through `Permission.assert` automatically.
- **OpenCode 2.1 added `ctx.permission.assert`**, which evaluates the session's rules and shows
  the standard permission prompt. The bridge doesn't use it yet; it still uses the `question`
  dialog.

Chosen design (the provider can already emit arbitrary tool calls into the history):

1. ACP `requestPermission` → the bridge evaluates the agent's rules first:
   - `allow` → resolve the ACP request directly (no dialog);
   - `deny` → deny directly;
   - an agent without the `question` tool (e.g. OpenCode's `general` subagent) → deny, since
     it cannot show a dialog;
   - otherwise (`ask`) → emit a deferred tool call to **`question`** with header
     `Permission` and the options `Allow once`, `Always allow`, `Deny`.
2. The `question` tool result comes back through the continuation path. The answer is parsed:
   `Allow once` / `Always allow` → approve; `Deny`, an error or anything ambiguous → deny
   (**fail closed**).
3. `Always allow` saves a rule in `~/.acp-model-provider/always.json`
   (`src/plugin/bridge-rules.ts`, shared by plugin and provider).

Rule semantics (`bridge-rules.ts`) mirror V2's `Permission.evaluate`, but **filtered**:

```ts
candidates = rules.filter(r => r.action !== "*" && wildcard(nativeTool, r.action));
effect     = last candidate whose resource matches the target ?? "ask";   // default ask
```

- `action: "*"` rules (V2's `*: allow` defaults) do not apply to the bridge. It keeps V1's
  default of **asking** for Claude's native tools and avoids accidental auto-allow.
- The rules are published from `ctx.agent.transform`, and replayed on config reload. Since
  0.10.0 that covers every agent, not only `claude-code*`, because a subagent can inherit the
  `acp` model.
- The injected agents get `{ action: "question", resource: "*", effect: "allow" }` when they
  have the `question` tool, so the tool's own permission check doesn't prompt twice.
- Differences from V1:
  - the `question` dialog replaces the permission card;
  - "always" lives in the plugin's own store, not in OpenCode's saved permissions;
  - per-session rules (`session.permissions`) are not evaluated by the bridge.

### Adjustments in `src/provider/model.ts`

1. **`providerOptions` key.** V2 nests per-call options under the provider id, which is `acp`
   unless you set `providerId`. The provider reads `providerOptions[<its id>]`. As a fallback
   it takes the first entry whose key contains that id, or whose content looks like the
   plugin's options. This tolerates custom ids.
2. **Bridge.** `emitPermissionCall` emits `question` instead of `claude_permission`. The verdict
   is parsed from the `question` result (`output.value.answers` or its text). A direct
   allow/deny branch was added to `onRequestPermission`, so no dialog is emitted when a rule
   decides.
3. `convertTools`: the `claude_permission` special case was removed. `question` is shown to the
   agent with a description that nudges it to use it.

### Files changed in the port

| File | Change |
| :--- | :----- |
| `package.json` | `@opencode/plugin` peer; `@opencode-ai/plugin` removed |
| `src/plugin/index.ts` | Rewrite: `Plugin.define`, `provider.transform`, `agent.transform`, `session.hook("context")`, `event.subscribe`, no `tool` |
| `src/plugin/bridge-rules.ts` | **New**: agent rules store + persistent "always" rules + wildcard + `evaluate()` |
| `src/plugin/catalog.ts` | `buildModelsInfo()` → `Model.Info[]` (capabilities, cost, variants, limit, status) |
| `src/index.ts` | Keeps the `create*` exports for the provider factory |
| `src/provider/model.ts` | The adjustments above |
| `README.md` / `docs` | V2 config blocks (`plugins` array, no V1 `provider`/`plugin`) |

### Latent bugs found during the port

1. `providerOptions["acp"]` was hard-coded and broke with a custom `providerId` (fixed with the
   fallback above).
2. Agent options must travel through the `context` hook, since V2 agents have no `options`
   field.
3. V1's `chat.params` only existed for the agent loop. In V2 the same injection also has to
   reach title, compaction and generate calls, which 0.10.0 does with dedicated hooks.
4. `claude_permission` was registered even when there was no bridge; it is gone.

### Verifying a build of the port

1. `npm install && npx tsc --noEmit`.
2. A minimal `opencode.json` with
   `"plugins": [{ "package": "/path/to/opencode-claude-code-acpbridge", "options": { "command": "claude-agent-acp" } }]`.
3. Start OpenCode with `ACP_DEBUG=1` → `[acp-plugin] auto-registered provider 'acp' … models: …`.
4. A turn that uses a native tool (Skill / ExitPlanMode) → `question` dialog → verdict → the
   ACP turn continues.
5. Revert in the TUI → `[acp-plugin] session … rewound — link dropped, next turn starts fresh`.
