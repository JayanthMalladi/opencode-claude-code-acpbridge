# Ejemplos de configuración

`opencode.json` listos para distintos casos de uso (OpenCode V2). Copia el que encaje en `~/.config/opencode/opencode.json` (global) o `<proyecto>/.opencode/opencode.json`.

> **En desarrollo** (sin publicar el paquete), sustituye `"package": "opencode-claude-code-acpbridge"` por la **RUTA DEL DIRECTORIO** local: `"package": "/ruta/a/opencode-claude-code-acpbridge"` (los ficheros como destino están rechazados por V2). El directorio necesita el `index.js` raíz que re-exporta `dist/`, así que compila antes con `npm run build`. El resto es idéntico.

| Archivo | Caso de uso | Parámetros clave |
|---|---|---|
| [`01-minimal.jsonc`](01-minimal.jsonc) | **Empezar ya** — auto-registro, consume de tu suscripción. | `plugins[]` con `{package, options:{command}}` |
| [`02-permisos-por-agente.jsonc`](02-permisos-por-agente.jsonc) | **Filtrar herramientas** del agente sin tocar el plugin. | `agents.*.permissions` (ruleset) |
| [`03-fidelidad-opencode.jsonc`](03-fidelidad-opencode.jsonc) | El agente **sigue el system/agentes de OpenCode** (a cambio de *extra usage*). | `claudeCode.systemPromptMode: "append"` |
| [`04-modelo-y-esfuerzo.jsonc`](04-modelo-y-esfuerzo.jsonc) | **Fijar modelo y esfuerzo** (rápido/barato o máxima calidad). | `agents.*.model` con `#variant` (`acp/default#max`) |
| [`05-agentes-personalizados.jsonc`](05-agentes-personalizados.jsonc) | **Tus propios agentes** (por modelo, por modo) o desactivar los de serie. | `plugins[0].options.agents` (defs) + `agents` (mode) |
| [`06-ecosistema-claude.jsonc`](06-ecosistema-claude.jsonc) | **Heredar tu Claude Code** (skills/hooks/MCP de `~/.claude`). | `claudeCode.configDir: false`, `settingSources` |
| [`07-provider-manual.jsonc`](07-provider-manual.jsonc) | **Control total**: declaras el provider a mano; el plugin lo respeta. | `provider.acp` manual |
| [`08-puente-permisos.jsonc`](08-puente-permisos.jsonc) | **Puente de permisos**: reglas por tool nativa + toggles de features. | `agents.*.permissions` (ruleset) + toggles en `plugins[0].options.agents` |

Notas transversales:
- El default `systemPromptMode: "preset"` es lo que mantiene el consumo en tu **suscripción** (0 extra usage). Cámbialo solo si aceptas *extra usage*.
- Logs: `ACP_DEBUG=1 opencode run …`. Refrescar modelos: `npx opencode-claude-code-acpbridge sync claude-agent-acp`.
- Requisito: el agente ACP es `@agentclientprotocol/claude-agent-acp` (binario `claude-agent-acp`).
- CLI: `opencode --standalone run --agent claude-code -m acp/default "…"`. Ojo: `run` **sin `-m`** ignora `agent.model` y usa el model global de config (comportamiento V2 del CLI).
