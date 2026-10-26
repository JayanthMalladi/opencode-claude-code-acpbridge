# Configuration examples

Ready-made `opencode.json` files for common use cases. **OpenCode V2 only**: these use the V2
config format (`"plugins": [{ "package", "options" }]`, `"agents"`, `"providers"`) and don't work
with OpenCode V1.

Copy the one that fits into `~/.config/opencode/opencode.json` (applies to every project) or
into `opencode.json` at the root of a project. Merge it with what you already have.

> **Local development** (without the npm package): replace
> `"package": "opencode-claude-code-acpbridge"` with the **directory** of your checkout, e.g.
> `"package": "/path/to/opencode-claude-code-acpbridge"`. OpenCode V2 rejects a file as a plugin
> target. The directory needs the root `index.js`, which re-exports `dist/`, so build it first
> with `npm run build`. Everything else stays the same.

| File | Use case | Key settings |
|---|---|---|
| [`01-minimal.jsonc`](01-minimal.jsonc) | **Get started**: the plugin registers everything; usage goes against your subscription. | `plugins[]` with `{package, options:{command}}` |
| [`02-per-agent-permissions.jsonc`](02-per-agent-permissions.jsonc) | **Limit what an agent can do** without touching the plugin. | `agents.*.permissions` (rules) |
| [`03-opencode-fidelity.jsonc`](03-opencode-fidelity.jsonc) | Claude **follows OpenCode's system prompt and agents** (billed as *extra usage*). | `claudeCode.systemPromptMode: "append"` |
| [`04-model-and-effort.jsonc`](04-model-and-effort.jsonc) | **Choose model and effort** (fast and cheap, or maximum quality), plus an extra agent. | `agents.*.model` with `#variant` (`acp/default#max`) |
| [`05-custom-agents.jsonc`](05-custom-agents.jsonc) | **Your own agents** (per model, per mode) instead of the built-in ones. | `plugins[0].options.agents` (definitions) + `agents` (mode) |
| [`06-claude-ecosystem.jsonc`](06-claude-ecosystem.jsonc) | **Load your Claude Code setup** (settings/hooks/agents from `~/.claude`, account MCP connectors). | `claudeCode.settingSources`, `strictMcpConfig: false` |
| [`07-manual-provider.jsonc`](07-manual-provider.jsonc) | **Full control**: you declare the provider yourself; the plugin respects it. | `providers.acp` |
| [`08-permission-bridge.jsonc`](08-permission-bridge.jsonc) | **Permission bridge**: rules per native Claude Code tool. | `agents.*.permissions` with native tool names |

Notes for all of them:
- **Billing.** The default `systemPromptMode: "preset"` keeps usage on your Claude
  **subscription** (no extra usage). Change it only if you accept *extra usage*.
- **Logs and caches.**
  - Debug logs: `ACP_DEBUG=1 opencode run …`. A daily log is written by default (`ACP_LOG=0` turns it off) to
    `~/.acp-model-provider/logs/`.
  - Refresh the model list: `npx opencode-claude-code-acpbridge sync claude-agent-acp`.
- **Requirement.** The ACP agent is `@agentclientprotocol/claude-agent-acp` (binary
  `claude-agent-acp`); install it with `npm i -g @agentclientprotocol/claude-agent-acp`.
- **CLI.** `opencode run --agent claude-default -m acp/default "…"`. Without `-m`, `run` ignores
  the agent's `model` and uses the global model from your config: that's how the V2 CLI works.
- **Agent definitions.** The plugin's `options.agents` **replaces** the built-in `claude-<mode>`
  agents. To add an extra agent and keep the built-in ones, declare it in OpenCode's
  own `agents` section with an `acp/…` model (example 04).
