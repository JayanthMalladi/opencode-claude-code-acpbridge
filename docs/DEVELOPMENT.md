# Desarrollo — `opencode-claude-code-acpbridge`

Guía de arquitectura interna, flujos y cómo extender el paquete. Para uso, ver el [README](../README.md); para configuraciones de ejemplo, [examples/](../examples/).

---

## 1. Visión general

Un único paquete npm que OpenCode carga como **dos cosas a la vez**:

- **Provider** (`createACPModelProvider`) — implementa `LanguageModelV3` (Vercel AI SDK). Por debajo es un **cliente ACP** que spawnea `claude-agent-acp` (Claude Code).
- **Plugin** (`export default { id, server }`) — hooks de OpenCode que **auto-registran** el provider y los agentes, y puentean el `sessionID`.

El principio rector es **"OpenCode orquesta"**: el agente Claude solo **razona y propone** llamadas a herramientas; **OpenCode las ejecuta** (con sus permisos y TUI) y reinyecta el resultado. Para lograrlo, al agente se le **desactivan sus herramientas nativas** (`tools: []`) y se le exponen **las de OpenCode** mediante un MCP server sintético.

---

## 2. Arquitectura

```
                 ┌───────────────────────── proceso OpenCode ─────────────────────────┐
                 │                                                                     │
 OpenCode  ──────┼─►  Plugin (hooks)                Provider (LanguageModelV3)         │
  (TUI/run)      │      • config: inyecta             • doStream(prompt, tools)        │
                 │        cfg.provider + cfg.agent     • ACPOrchestratorModel           │
                 │      • chat.params: sessionID ─────► providerOptions.acp             │
                 │                                        │                             │
                 │                              McpHost (TCP) ◄── tools de OpenCode     │
                 │                                        │ getServerConfig()           │
                 └────────────────────────────────────────┼────────────────────────────┘
                                                          │ spawn (stdio JSON-RPC ACP)
                                                          ▼
                                            claude-agent-acp (proceso aparte)
                                                          │  spawnea por stdio
                                                          ▼
                                            mcp-runtime.js (node) ──TCP──► McpHost
                                            (MCP server "opencode", difiere tools/call)
```

- **Canal ACP**: stdio entre el provider y `claude-agent-acp` (JSON-RPC ndjson, `@agentclientprotocol/sdk`).
- **Canal de tools**: el agente arranca `mcp-runtime.js` como MCP server (stdio); este reenvía cada `tools/call` por **TCP** al `McpHost` (dentro del provider), que lo **difiere** hasta que OpenCode ejecuta la tool.

---

## 3. Componentes (`src/`)

### `provider/model.ts` — `ACPOrchestratorModel`
El corazón. Implementa `doStream`/`doGenerate` y mantiene una **sesión ACP persistente por conversación**.

- **Conexión** (`connect`): spawnea el agente con el env correcto (`CLAUDE_CODE_EXECUTABLE`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT`, `ANTHROPIC_MODEL`), abre `ClientSideConnection`, `initialize`. El cliente auto-aprueba `requestPermission` (OpenCode ya gobierna los permisos).
- **Identidad de sesión**: una `TurnState` por conversación (`Map` indexado por el sessionID de OpenCode), más un índice por `sessionId` ACP para enrutar los callbacks del agente. Recrear la sesión tira el prompt cache de Claude (vive y muere con ella), así que se recrea lo mínimo posible:
  - `systemKey` solo cuenta **si el system de verdad viaja** — con `systemPromptMode: "preset"` (default) no viaja, así que cambiar de agente en OpenCode **no** recrea nada.
  - `toolsKey` ya **no** recrea: un set de tools distinto se aplica en caliente con `notifications/tools/list_changed` por el canal MCP.
  - `cfgKey` (thinking/systemPromptMode) sí recrea: son parámetros de creación.
  - La llamada del small model (títulos/resúmenes, `tools=0`) va a una sesión efímera aparte.
- **Sincronía de historial**: `sentKeys` guarda una huella por mensaje no-system ya enviado. Comparando con el prompt entrante se distingue *append* (envía solo la cola), *revert* (el prompt es prefijo estricto → sesión nueva) y *divergencia* por compactación (→ sesión nueva). En el catch-up se **omiten** los `tool-call`/`tool-result` propios (prefijo nonce del host: el agente ya los tiene) y se truncan los ajenos.
- **Buffer de stream** (`emit`/`flushPending`): texto y thinking llegan por stdio ACP mientras las tool-calls llegan por el socket TCP del host, sin orden garantizado. Cuando una tool-call cierra el stream, lo que sigue llegando se **bufferiza** y se vuelca en el stream de continuación en vez de perderse.
- **Contexto factual** (`contextBlocks`): con `preset` el system de OpenCode no llega al agente, así que su bloque `<env>` (y `<available_references>`) se reenvía como contenido de **usuario** — completo la primera vez, luego solo el delta.
- **`effectiveCtrl(options)`**: fusiona `config.claudeCode` con `providerOptions.acp` (mode/effort/thinking/systemPromptMode por agente/llamada).
- **`applySessionConfig`**: aplica `mode` (`setSessionMode`) y `effort` (`setSessionConfigOption`) **en caliente** (sin recrear).
- **Flujo de tools diferidas** (ver §4).
- **Usage**: `mapUsage`/`subtractUsage` → emite el consumo de tokens por turno en el `finish`.

### `acp/mcp-host.ts` — `McpHost`
TCP server dentro del provider. `setTools()` recibe las tools de OpenCode; cuando el runtime pide `getTools`/`callTool`, responde. **Difiere** los `callTool`: guarda `{socket, runtimeId}` por `toolCallId` y resuelve cuando OpenCode entrega el resultado (`resolveToolCall`).

### `acp/mcp-runtime.ts`
MCP server **stdio sin dependencias** (solo `node:net`/`node:readline`) que el agente spawnea. Reenvía `tools/list`/`tools/call` por TCP al host (puerto en `ACP_TOOL_HOST_PORT`). No impone timeout cliente → el `tools/call` puede esperar a OpenCode tanto como `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT`. Blindado contra `EPIPE`/`ECONNRESET` (el agente lo mata al cerrar).

### `acp/claude-config.ts`
`ClaudeCodeControl` (tipo) + `buildClaudeCodeOptions` (→ `_meta.claudeCode.options`) + `resolveConfigDir`/`prepareIsolatedConfigDir`. El **"cerebro limpio"** por defecto: `tools:[]`, `settingSources:[]`, `strictMcpConfig:true` (sin connectors claude.ai), y un `CLAUDE_CONFIG_DIR` aislado con `~/.claude/.credentials.json` **symlinkeado** (auth sin heredar el ecosistema). `prepareIsolatedConfigDir` **re-enlaza el symlink en cada arranque**: el agente puede reemplazarlo con un archivo obsoleto al refrescar el token → 401; re-linkear lo mantiene sincronizado con `~/.claude`.
**Toggles de features nativos** (componen `tools`/`settingSources`/`agents`/`settings`; con todos off = cerebro limpio, cero regresión): `nativeTools`, `resourceSearch`, `nativeSubagents` (→ `DEFAULT_SUBAGENT` que delega a OpenCode), `nativeSkills`, `projectMemory`, `skillShell`, `allowedTools`. Un override crudo (`ctrl.tools`/`ctrl.settingSources`) **gana** sobre la composición.

### `plugin/index.ts`
- Hook **`config(cfg)`**: descubre modelos (con caché), construye la metadata y **muta** `cfg.provider.acp` y `cfg.agent` (auto-registro). `deepMerge` da precedencia a los agentes que el usuario declaró.
- Hook **`chat.params`**: inyecta `providerOptions.acp.{ocSession, resumeId, resumeLen}` (el `sessionID` de OpenCode + lo que haya en el registro).

### `plugin/discover.ts` · `catalog.ts` · `cache.ts` · `sessions.ts`
- `discover`: conexión ACP **efímera** → `availableModels`/`modes`/`promptCapabilities`.
- `catalog`: metadata desde `~/.cache/opencode/models.json` (o `models.dev`), `variants` de effort, `default`→opus.
- `cache`: cachés TTL en `~/.acp-model-provider/`.
- `sessions`: registro `sessions.json` (sessionID OpenCode ↔ sessionId ACP).

### `provider/factory.ts` · `env.ts` · `bin/cli.ts`
Factory del provider (una instancia por `modelId`), config por env vars, y el comando `sync`.

---

## 4. Flujos clave

### Tool-call diferido (el núcleo de "OpenCode orquesta")
1. `doStream` recibe el prompt + tools. El provider las expone vía `McpHost` y manda el prompt al agente.
2. El agente decide usar una tool → llama al MCP `mcp-runtime` → este reenvía `callTool` por TCP al `McpHost`.
3. `McpHost.onToolCall` → el provider **emite a OpenCode** `tool-input-start/delta/end` → `tool-call` (con el nombre **real**) → `finish("tool-calls")`, y **deja el `callTool` MCP pendiente**.
4. OpenCode ejecuta la tool (permisos/TUI) y en el **siguiente `doStream`** trae el `tool-result`.
5. El provider detecta la continuación, hace `McpHost.resolveToolCall(id, result)` → el `callTool` MCP por fin responde → el agente continúa el mismo turno.

### Sesión: reuse / reset / resume
- **Reuse** (mismo proceso, misma conversación): envía solo el último mensaje → el agente reaprovecha su prompt cache.
- **Reset**: cambia conversación/tools/system/cfg → cierra la vieja y crea `newSession` con el historial completo.
- **Resume** (proceso nuevo): `chat.params` aporta `resumeId` desde `sessions.json`; si el historial creció (no divergió), `unstable_resumeSession(acpSessionId)` reanuda **sin reenviar historial**. Si falla o el historial divergió (compactación/rollback) → `newSession`.

### Modo y esfuerzo por agente
`cfg.agent.<n>.options` → OpenCode los pasa como `providerOptions.acp` (key = `providerID`, ver `transform.ts` de OpenCode) → `doStream` los lee (`effectiveCtrl`) → `setSessionMode`/`setSessionConfigOption` en caliente.

### Puente de permisos (tools nativas)
Cuando el agente está en modo `default` (no `bypassPermissions`) y usa una tool **nativa** (Skill/Read/NotebookEdit/Task), Claude Code llama `requestPermission` (ACP). El provider **no auto-aprueba**: lo difiere y lo enruta a OpenCode reusando el patrón de tool-call diferido.

1. `requestPermission(params)` → `onRequestPermission` guarda un resolver en `TurnState.pendingPermissions` y **emite a OpenCode** un tool-call de la meta-tool **`claude_permission`** (con `{tool, kind, title, input}`), luego `finish` y cierra el controller (igual que `onToolCall`). Devuelve una Promise (el agente espera).
2. OpenCode ejecuta `claude_permission` (registrada por el plugin); su `execute` hace **`ctx.ask({permission: <tool nativa>, patterns:[target], always:[glob]})`** → **prompt `ask`** mostrando la tool nativa y la acción. Aprobar → `"approved"`; rechazar → `PermissionRejectedError` (tool-error).
3. El siguiente `doStream` trae el tool-result de `claude_permission`. `detectContinuation`/`onStart` lo distinguen de tool-results MCP (`pendingPermissions` vs `pendingTools`) y resuelven la Promise: **`isApprovedOutput` falla CERRADO** (solo un veredicto explícito "approved" permite; error/ambiguo → deny). El agente ejecuta (o no) la tool nativa.

Robustez: `claude_permission` se **filtra del host** (`convertTools`) para que el agente no la vea; `onCancel` **no derriba** la sesión con trabajo diferido en vuelo (era la causa de *host closed* cuando OpenCode pausa para el `ask`) pero arma un **watchdog** que libera si la continuación nunca llega; `endTurn`/reuse **drenan** `pendingPermissions` (deny) para que el agente nunca cuelgue. Las tools comunes van en `allowedTools: ["mcp__opencode"]` (no piden `requestPermission`; OpenCode las orquesta).

### Facturación (suscripción vs extra usage)
Anthropic clasifica la sesión por el **system prompt**: si reenvías el de OpenCode (`append`/`replace`), la trata como app de terceros → *extra usage*; con `preset` (default) usa el preset oficial `claude_code` → **suscripción**. Decidido empíricamente; ver [acp-subscription-billing](../README.md#system-prompt-y-facturación-suscripción-vs-extra-usage).

---

## 5. Build y pruebas

```bash
npm install
npm run build            # tsc → dist/
ACP_DEBUG=1 …            # logs [acp-orchestrator] / [acp-mcp-host] / [acp-plugin] en stderr
```

**Scripts de verificación** (`scripts/`, no se publican a npm, requieren `dist/`):

- `node scripts/verify-billing.mjs` — comprueba que cada feature nativo mantiene la **suscripción** (0 extra usage).
- `node scripts/spike-permission-bridge.mjs` — valida el **puente de permisos** e2e (approved crea el archivo; denied no).

**Spikes** (sin OpenCode): scripts `.mjs` dentro del repo que importan `../dist/...` y usan `streamText` del AI SDK o el SDK ACP directamente. Patrón típico:

```js
import { streamText } from "ai";
import { createACPModelProvider } from "../dist/index.js";
const model = createACPModelProvider({ command:"claude-agent-acp", claudeExecutable:"…", claudeCode:{configDir:"isolated"} }).languageModel("sonnet");
for await (const p of streamText({ model, prompt:"di ok", providerOptions:{ acp:{ mode:"bypassPermissions", effort:"low" } } }).fullStream) { /* … */ }
```

Para inspeccionar lo que el provider envía, hay un volcado opt-in: setea `ACP_DUMP=<archivo>` para escribir `{modelId,ctrl,meta,prompt}` del primer turno con tools (úsalo solo en depuración).

Nota de coste: un prompt real consume de tu suscripción; los spikes de inspección (discovery, construir config, `setSessionMode`) no gastan tokens.

---

## 6. Extender

- **Nuevos agentes por defecto**: edita el objeto `defs` en el hook `config` (`plugin/index.ts`). Cada entrada `{ description, model, mode, variant, options }`. El usuario siempre puede sobreescribir vía `agent.<n>` en su `opencode.json` (merge).
- **Nuevos parámetros por-llamada**: añádelos a `ClaudeCodeControl` y léelos en `effectiveCtrl`; si son runtime, aplícalos en `applySessionConfig` (hay `setSessionMode`, `setSessionConfigOption`, `unstable_setSessionModel`).
- **Más metadata de modelos**: `catalog.ts` (`buildModels`/`matchCatalog`).
- **Otro agente ACP** (no Claude Code): el provider es genérico ACP; el comando/exe y el "cerebro limpio" se controlan por `options`. Las partes específicas de Claude están en `claude-config.ts`.

---

## 7. Decisiones de diseño no obvias

- **`tools: []`** desactiva las tools nativas del agente — sin esto habría dos ejecutores y el modelo "OpenCode orquesta" se rompe.
- **El runtime MCP corre con `node`, no `process.execPath`** — dentro de OpenCode `process.execPath` es el binario `opencode`, que no ejecuta un script JS arbitrario. Override con `ACP_RUNTIME_NODE`.
- **Auth con config dir aislado** — un dir vacío rompe la auth; se **enlaza** `~/.claude/.credentials.json`.
- **`systemPromptMode: "preset"` por defecto** — cualquier otro modo reenvía el system de OpenCode y dispara *extra usage*.
- **Robustez EPIPE** — al cerrar el agente (p. ej. tras un error de API), sockets/pipes emiten EPIPE; blindado en `model.ts`/`discover.ts`/`mcp-host.ts`/`mcp-runtime.ts`.
- **`default` = Opus 4.7** — el alias `default` del agente es Opus con 1M ctx; `sonnet[1m]` se factura como *extra usage*.
