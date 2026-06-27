# Changelog

Todas las versiones notables de `opencode-claude-code-acpbridge`. Formato basado en
[Keep a Changelog](https://keepachangelog.com/); versionado [SemVer](https://semver.org/).

## [0.7.0] — 2026-06-27

Capacidades nativas de Claude Code dentro de OpenCode, con un **puente de permisos**
que mantiene a OpenCode al mando de cada acción ("potencia nativa sin estropear nada").

### Added
- **Puente de permisos**: cuando el agente usa una tool **nativa** de Claude (Skill, Read,
  NotebookEdit, Task, búsqueda de recursos MCP), su `requestPermission` (ACP) se enruta al
  **prompt `ask` de OpenCode** vía la meta-tool `claude_permission`. El prompt muestra la
  **tool nativa** y la acción; soporta **"Allow always"** y **reglas glob por tool**
  (`permission: { Bash: { "git *": "allow" }, Skill: { "*": "ask" } }`).
- **Toggles de features nativos** en `claudeCode` (componen las options del SDK; con todos
  off = cerebro limpio): `nativeTools`, `resourceSearch`, `nativeSubagents` (subagente que
  delega a OpenCode), `nativeSkills`, `projectMemory`, `skillShell`, `allowedTools`.
  Verificado: **todos mantienen la suscripción** (0 extra usage).
- **Modelo híbrido**: las tools comunes (bash/read/write/edit/grep/…) las orquesta OpenCode
  sin doble permiso (`allowedTools: ["mcp__opencode"]`); las nativas superiores van por el puente.
- Tool nativa **`Read`** habilitada en el agente `claude-code` (lectura multimodal: imágenes/PDF/notebooks).
- Scripts de verificación (`scripts/`): `verify-billing.mjs`, `spike-permission-bridge.mjs`.

### Changed
- El agente `claude-code` pasa de `mode: "bypassPermissions"` a **`mode: "default"`** (para que el
  puente actúe). El "cerebro limpio" clásico sigue disponible (`mode: "bypassPermissions"` + sin toggles).

### Fixed
- **`host closed`**: `onCancel` ya no derriba la sesión mientras hay un tool-call/permiso diferido en
  vuelo (OpenCode cancela el stream al pausar para el `ask`); un **watchdog** libera si la continuación
  no llega.
- **Desincronización de auth (401)**: el symlink de credenciales del config dir aislado se **re-enlaza en
  cada arranque** (el agente podía reemplazarlo con un archivo obsoleto al refrescar el token).
- El puente **falla cerrado** (deniega ante un veredicto ambiguo); `endTurn`/reuse **drenan** los permisos
  pendientes para que el agente nunca quede colgado.
- `claude_permission` se **filtra del host** (el agente ya no la ve como `mcp__opencode__claude_permission`).
- El agente ya no intenta tools nativas comunes que no puede ejecutar (`disallowedTools` Bash/Write/Edit/…).

## [0.6.0]

### Changed
- **Renombrado**: `acp-model-provider` → **`opencode-claude-code-acpbridge`** (plugin exclusivo para usar
  Claude Code en OpenCode).

### Added
- `strictMcpConfig` (default `true`): ignora los connectors de la cuenta claude.ai (Gmail/Drive/Supabase/…).
- `thinking` por defecto `{type:"enabled", display:"summarized"}`: el **bloque de razonamiento** se ve en OpenCode.
- **Reanudación de sesión entre procesos** (registro `sessions.json` + `unstable_resumeSession`).
- **Reporte de consumo de tokens** (mapeo de `PromptResponse.usage` del ACP).

## [0.5.x]

### Added
- **Auto-registro** del provider (config mínima): descubre los modelos del agente e inyecta `provider.acp`
  con metadata de models.dev.
- **Agentes inyectados** `claude-code` / `claude-code-plan`, con modo/esfuerzo por agente en caliente; la
  config del usuario en `opencode.json` tiene precedencia (merge).
- **Facturación por suscripción** (`systemPromptMode: "preset"`): 0 extra usage.
- Documentación completa (README + `docs/DEVELOPMENT.md` + `examples/`).
