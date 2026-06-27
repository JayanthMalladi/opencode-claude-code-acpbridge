# Ejemplos de configuración

`opencode.json` listos para distintos casos de uso. Copia el que encaje en `~/.config/opencode/opencode.json` (global) o `<proyecto>/.opencode/opencode.json`.

> **En desarrollo** (sin publicar el paquete), sustituye `"opencode-claude-code-acpbridge"` por la ruta local:
> `"file:///ruta/a/opencode-claude-code-acpbridge"`. El resto es idéntico.

| Archivo | Caso de uso | Parámetros clave |
|---|---|---|
| [`01-minimal.jsonc`](01-minimal.jsonc) | **Empezar ya** — auto-registro, consume de tu suscripción. | solo `plugin` |
| [`02-permisos-por-agente.jsonc`](02-permisos-por-agente.jsonc) | **Filtrar herramientas** del agente sin tocar el plugin. | `agent.claude-code.permission` |
| [`03-fidelidad-opencode.jsonc`](03-fidelidad-opencode.jsonc) | El agente **sigue el system/agentes de OpenCode** (a cambio de *extra usage*). | `claudeCode.systemPromptMode: "append"` |
| [`04-modelo-y-esfuerzo.jsonc`](04-modelo-y-esfuerzo.jsonc) | **Fijar modelo y esfuerzo** (rápido/barato o máxima calidad). | `claudeCode.model` / `effort` / variantes |
| [`05-agentes-personalizados.jsonc`](05-agentes-personalizados.jsonc) | **Tus propios agentes** (por modelo, por modo) o desactivar los de serie. | `plugin.options.agents` |
| [`06-ecosistema-claude.jsonc`](06-ecosistema-claude.jsonc) | **Heredar tu Claude Code** (skills/hooks/MCP de `~/.claude`). | `claudeCode.configDir: false`, `settingSources` |
| [`07-provider-manual.jsonc`](07-provider-manual.jsonc) | **Control total**: declaras el provider a mano (sin auto-registro). | `provider.acp` |
| [`08-puente-permisos.jsonc`](08-puente-permisos.jsonc) | **Puente de permisos**: reglas por tool nativa (con globs) + toggles de features. | `agent.claude-code.permission` / `options` |

Notas transversales:
- El default `systemPromptMode: "preset"` es lo que mantiene el consumo en tu **suscripción** (0 extra usage). Cámbialo solo si aceptas *extra usage*.
- Logs: `ACP_DEBUG=1 opencode run …`. Refrescar modelos: `npx opencode-claude-code-acpbridge sync claude-agent-acp`.
