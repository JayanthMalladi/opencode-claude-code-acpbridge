# Changelog

Todas las versiones notables de `opencode-claude-code-acpbridge`. Formato basado en
[Keep a Changelog](https://keepachangelog.com/); versionado [SemVer](https://semver.org/).

## [Sin publicar] — sincronía de historial, concurrencia y continuidad entre modelos

Revisión completa del puente contra el código de OpenCode V2, `claude-agent-acp` 0.31 y
sesiones **reales** grabadas. Objetivo: alternar entre `acp` y otros modelos en la misma
sesión sin perder nada, y que la sesión de Claude Code se reutilice siempre que se pueda.
Todo lo de abajo está cubierto por `npm test` (agente ACP falso + prompts reales de V2) y por
los scripts contra el agente real.

### Fixed

- **La respuesta propia se reenviaba cada turno** como `"Assistant: …"` dentro del mensaje
  del usuario (visto en transcripciones: el modelo llegó a llamarlo "mensaje falso"). El
  provider reconoce ahora su propia salida (textos emitidos, ids con su prefijo) y no la
  devuelve.
- **Mensajes perdidos**: lo que escribías mientras el agente trabajaba (*steer*) y el mensaje
  tras **interrumpir** una tool se trataban como continuación del turno y nunca llegaban.
  Ahora el steer entra en el turno en curso (cola nativa de Claude Code) y la interrupción
  cancela el turno antes de enviar el mensaje nuevo.
- **Turnos de otro modelo atribuidos a Claude**: llegaban como `Assistant: [Called tool …]` y
  Claude creía haberlos hecho él. Ahora van en `<other_model_turn>`.
- **Tool-calls concurrentes descartadas** (subagentes nativos en paralelo): la segunda se
  perdía y el turno colgaba. Ahora se encolan; las de solo lectura (`readOnlyHint`) se
  agrupan en un paso que OpenCode ejecuta en paralelo.
- **Seguridad**: los ids `perm_N` del puente se repetían entre procesos y una respuesta
  vieja ("Always allow") podía aprobar un permiso nuevo. Ids con prefijo propio y última
  coincidencia.
- La finalización de un prompt viejo (cancelado o fusionado) cerraba el stream del turno
  siguiente; texto de un turno abortado aparecía al principio del siguiente.
- Dos llamadas simultáneas a la misma conversación creaban dos sesiones (una huérfana).
- **Usage**: `PromptResponse.usage` es la suma de todos los requests del turno; reportarla
  como un único request inflaba el contexto y adelantaba compactaciones. Ahora se reporta
  la ocupación real (`usage_update.used`), también en los pasos con tools.
- **Sesiones nunca cerradas**: cada una dejaba vivo un proceso `claude`. Ahora
  `session/close` al descartar, TTL de inactividad (15 min; subagentes 2 min) y LRU de 6.
- **Títulos basura** (`<invoke name="Read">`): con `preset` las instrucciones de título no
  llegaban a Claude. El plugin titula a partir del primer mensaje, sin llamar al modelo.
- **Subagentes de OpenCode sobre `acp`** (heredan el modelo del padre): sin perfil, cada tool
  de OpenCode pedía permiso al puente y el `general` (sin `question`) las veía denegadas.
  Ahora todo agente auto-permite las tools de OpenCode y el puente deniega con motivo si el
  agente no puede preguntar. Reglas publicadas para todos los agentes.
- Cambiar a un agente con otro perfil nativo reutilizaba la sesión con el perfil viejo;
  ahora la **bifurca** (`session/fork`) conservando el contexto.
- Volver de plan a `claude-code` rebajaba a `default` el modo elegido al aprobar el plan.
- El resume tras reinicio reenviaba tráfico propio y se hacía aunque el registro fuese de
  otra conversación; el registro se actualiza también a mitad de turno.
- Una sesión perdida en el agente (proceso `claude` muerto) fallaba en cada turno; ahora se
  suelta y se reanuda.
- `mcp-runtime` ignoraba SIGTERM (registrar el handler desactiva la salida por defecto).

### Added

- **Compactación nativa**: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=75` (`autoCompactPct`) para que
  Claude compacte antes que OpenCode; si OpenCode compacta, el resumen sale de la **sesión
  viva** (antes: replay completo en frío, 17K+ caracteres en la grabación).
- **`historyMode`** (`shadow` por defecto): huella por anclas (mensajes del usuario + ids de
  tools) inmune a re-renderizados de V2 (reasoning→texto, cambio de modelo), recordatorios de
  plan transitorios y etiquetas de DCP. En `shadow` solo registra discrepancias; `v2` decide
  y además adopta el checkpoint de OpenCode o pone al día con el de otro modelo.
- **`smartRevert`** (por defecto): un revert bifurca la sesión justo antes del mensaje
  revertido (`resumeSessionAt`) en vez de replay; `false` lo desactiva.
- **Un proceso del agente para todos los modelos** del provider; cambio de modelo con
  `session/set_model` sin perder la sesión.
- **Actividad nativa portable** (`nativeActivity`): Task/WebSearch/Skill dejan una línea
  `⚙ …` (con su resultado) en la respuesta → visible para cualquier modelo.
- **ExitPlanMode** con las opciones reales (auto / aceptar ediciones / aprobar cada edición /
  seguir planificando); una respuesta escrita vuelve como feedback.
- Límite de uso de Claude → error claro, no reintentable ("cambia de modelo").
- Replay acotado (~400K caracteres) y etiquetado; petición actual aparte.
- Catálogo inicial de **Code Mode** de V2 reenviado como contexto.
- Log a fichero `~/.acp-model-provider/logs/`, grabador `ACP_RECORD`,
  `scripts/sanitize-recording.mjs`, suite `npm test`, `scripts/verify-smart-revert.mjs`.
- Opciones: `historyMode`, `catchupResultChars`, `parallelTools`, `toolBatchMs`,
  `autoCompactPct`, `nativeActivity(Chars)`, `maxLiveSessions`, `idle/childSessionTtlMs`,
  `smartRevert`; plugin: `titleFromModel`.

### Changed

- El `Read` nativo sale del perfil por defecto (lo que leía no quedaba en el historial de
  OpenCode); el `read` de V2 cubre imágenes/PDF.
- `allowedTools` vale `["mcp__opencode"]` por defecto para cualquier agente.
- Los agentes `claude-code*` deniegan `compress` (opencode-dcp).
- Registro de sesiones con caché en memoria y poda (30 días / 500 entradas).

## 0.9.0 — OpenCode V2 (2026-10-01)

> ⚠️ **0.9.0+ solo funciona con OpenCode V2; para OpenCode V1 conserva 0.8.x.**
>
> El port es un **breaking change total de runtime**: el plugin V1
> (`export default { id, server }`, hooks `config`/`chat.params`) no se carga en
> OpenCode V2, y el plugin V2 (`Plugin.define`) no se carga en OpenCode V1.

Port del plugin y del provider al runtime de plugins **V2** de OpenCode.

### Breaking changes

| Área | V1 (0.8.x) | V2 (0.9.0) |
| :--- | :--- | :--- |
| **Runtime de plugins** | `export default { id, server }`, hooks `config`/`chat.params` | `Plugin.define({ id, setup })` con API de promesas (`setup` retorna cleanup) |
| **Config del plugin** | `"plugin": [[pkg, {opts}]]` | `"plugins": [{ "package", "options" }]` |
| **Auto-registro del provider** | el hook `config` mutaba `cfg.provider.acp` | `provider.transform` lo registra como `aisdk:<spec>` (con `options.command`); si declaras `provider.<id>` a mano, no lo sobreescribe |
| **Inyección por llamada** | hook `chat.params` → `providerOptions.acp.{ocSession, resumeId, resumeLen}` | `session.hook("context")` → `ocSession`, `ocAgent`, `resumeId`, `resumeLen`, `resumeLastUsage`, `resumeConvKey` + options del agente por llamada |
| **Agentes (config)** | sección `agent:` con `permission` (mapa `{tool: "allow"\|"deny"\|"ask"\|glob}`) y `disable` | sección `agents:` con `permissions` (ruleset array `[{action, resource, effect}]`), `disabled` y `mode: "subagent"\|"primary"\|"all"` |
| **Options por agente** | `agent.<n>.options` (mode/effort/native*) | `plugins[0].options.agents.<n>.options` (misma options, otra ruta) |
| **Puente de permisos** | meta-tool `claude_permission` (prompt `ask` con `ctx.ask`) | emite un **tool-call de la tool nativa `question`** de OpenCode (diálogo `Allow once` / `Always allow` / `Deny`); reglas desde `agents.<n>.permissions` evaluadas en `src/plugin/bridge-rules.ts`, **fail-closed** (ignora `action:"*"` a propósito); `Always allow` persiste en `~/.acp-model-provider/always.json` |
| **Variantes de esfuerzo** | `acp/opus:low` | `acp/opus#low` (`provider/model#variant`) |
| **Revert / compactación** | fingerprint por `chat.params` | eventos `session.revert.committed\|cleared` → `clearLink` |
| **Desarrollo local** | destino = fichero (`…/dist/index.js`) | destino = **ruta de directorio** con `index.js` raíz (V2 `Host.resolve` busca `<dir>/index.*`); los ficheros se rechazan |
| **CLI** | `opencode run` aplicaba `agent.model` | `opencode run` **sin `-m` ignora `agent.model`** (usa el model global); usa `-m acp/…` |
| **Requisitos** | OpenCode V1 | OpenCode **V2 (`>= 2.0.14`)** y agente `@agentclientprotocol/claude-agent-acp` (antes `@zed-industries/claude-agent-acp`) |

Guía práctica de migración: ver [README § De 0.8.x (V1) a 0.9.x (V2)](README.md#de-08x-v1-a-09x-v2)
y [MIGRATION_V2.md](MIGRATION_V2.md).

### Added

- **Auto-registro del provider como `aisdk:<spec>`** (con `options.command`); si declaras
  `provider.<id>` a mano en config, el plugin ya no lo sobreescribe (guard nuevo).
- **Revert/compactación**: el plugin escucha `session.revert.*` y limpia el enlace de
  sesión → replay completo cuando la historia diverge.
- **Entrypoint de directorio local**: `index.js` en la raíz re-exporta `dist/`
  (`Host.resolve` de V2 busca `<dir>/index.*`); en dev, `package` = ruta de directorio.

## [0.8.0] — 2026-08-21

Versión centrada en el **coste de tokens** y en la **continuidad de sesión**. La causa
común de casi todos los problemas era la misma: el provider recreaba la sesión ACP con
demasiada facilidad, y cada recreación implica replay del historial completo y cache de
prompt frío. Ahora una conversación sobrevive a cambios de agente, de tools y de system
prompt manteniendo la misma sesión de Claude Code.

### ⚠️ Breaking

- **`claudeCode.configDir` pasa a heredar `~/.claude` por defecto** (antes `"isolated"`).
  Las sesiones iniciadas desde OpenCode se guardan ahora en `~/.claude/projects/…`, así
  que **se pueden retomar nativamente con `claude --resume <id>`** (el provider imprime el
  id al crear cada sesión). Esto **no** reintroduce el ecosistema del usuario: `settingSources`,
  `tools` y `strictMcpConfig` siguen gobernando qué carga el agente; `configDir` solo decide
  dónde vive su estado. Para volver al comportamiento anterior: `"configDir": "isolated"`.
  Efecto colateral positivo: desaparece el symlink de credenciales y con él la clase de
  bugs de desincronización 401.
- **El límite de contexto publicado deja de inflarse a 1M** para el modelo `default`; solo
  las variantes `[1m]` reales lo declaran. Anunciar 1M impedía que la auto-compactación de
  OpenCode se disparase nunca y la conversación crecía sin límite.

### Fixed

- **Gasto de tokens desproporcionado (causa principal).** `sentLen` se fijaba al inicio del
  turno y no se actualizaba en la rama de continuación, así que en cada turno se reenviaban
  como texto plano **todos los `tool-call`/`tool-result` del turno anterior** — volcados
  íntegros de ficheros, salidas de shell, greps — que el agente **ya tenía** en su sesión.
  Además invalidaba el prompt cache en cada turno. Ahora el estado registra la huella del
  historial ya enviado y las llamadas propias (identificadas por el prefijo nonce del host)
  se omiten del catch-up; los resultados ajenos se truncan a 2000 caracteres.
- **Cambiar de agente destruía la sesión y replayaba todo.** `systemKey` hasheaba el system
  prompt de OpenCode incluso con `systemPromptMode: "preset"`, modo en el que ese system
  **nunca se envía al agente**. Cualquier cambio de agente — o el vaivén de los bloques
  dinámicos de OpenCode (fecha, `AGENTS.md`, skills) — recreaba la sesión por un texto que
  el agente jamás vio. Ahora el system solo cuenta como identidad cuando de verdad viaja,
  y el flujo `claude-code-plan` → build → `claude-code` mantiene la misma sesión ACP.
- **Un cambio en el set de tools ya no recrea la sesión.** Se aplica en caliente a la sesión
  viva mediante `notifications/tools/list_changed` por el canal MCP.
- **La llamada del modelo de títulos/resúmenes ya no destruía la conversación.** Llega con
  `tools=0` sobre el mismo modelo y sesión; ahora se atiende en una sesión efímera aparte.
- **Texto truncado y razonamiento invisible (misma causa).** Texto y thinking llegan por
  stdio ACP mientras las tool-calls llegan por el socket TCP del `McpHost`, sin orden
  garantizado. Al cerrar el stream por una tool-call, todo lo que seguía llegando se
  **descartaba en silencio** — y el thinking se emite justo antes de cada tool-call, por eso
  desaparecía casi entero aun con `effort: max`. Ahora esos chunks se **bufferizan** y se
  vuelcan en orden en el stream de continuación.
- **Revertir mensajes dejaba las dos partes desincronizadas.** El provider solo guardaba un
  contador, así que un historial truncado caía en un fallback silencioso que reenviaba
  **todo** el historial encima de una sesión que ya lo tenía. Ahora se compara la huella del
  historial y se distingue *append* (envía solo lo nuevo) de *revert* / *divergencia por
  compactación* (sesión nueva desde el historial truncado). El plugin además escucha
  `session.updated` y descarta el enlace registrado en cuanto se mueve el punto de revert.
- **Dos conversaciones simultáneas se destruían la sesión mutuamente.** Había un único
  `TurnState` por instancia de modelo, compartido por todos los chats y subagentes: cada
  turno alternaba de conversación y forzaba replay completo. Ahora hay **una sesión por
  conversación** (con cota LRU) y los callbacks del agente se enrutan por `sessionId`.
- **`claude-code-plan` no tenía forma de salir de modo plan.** `ExitPlanMode` no estaba
  expuesta al agente, no veía el `plan_exit` de OpenCode, y el bridge le re-forzaba `plan`
  en cada turno: un ciclo cerrado que dejaba muerto todo el manejo de `switch_mode` ya
  escrito. Ahora se expone `ExitPlanMode`, y **volver a elegir el agente de plan a mano
  vuelve a aplicar `mode: "plan"`** (antes `modeChangedByAgent` no se reseteaba nunca).
- **Aprobar un plan concedía `bypassPermissions`.** Se elegía la primera opción `allow_*`
  ofrecida por el agente, que es la más amplia. Ahora se prefiere `default` (aprobación
  manual de ediciones) para `switch_mode`.
- **El agente no usaba la tool `question` de OpenCode.** Su instrucción vive en el system
  prompt de OpenCode, que con `preset` no se reenvía, y su `AskUserQuestion` nativa está
  deshabilitada por el propio agente ACP. Ahora la **descripción** de `question` lo indica
  explícitamente (una descripción de tool no es system prompt: no afecta a la facturación).
- **El agente se quedaba sin búsqueda web.** OpenCode solo registra su `websearch` para
  `providerID: "opencode"` (o con exa/parallel), y `WebSearch` nativa estaba en
  `disallowedTools`. Ahora `WebSearch` nativa forma parte del perfil.
- **Los resultados de tools llegaban aplanados a texto**, perdiendo imágenes y adjuntos.
  Ahora el contenido estructurado se mapea a bloques MCP.
- **Un `effort` rechazado se tragaba en silencio**; ahora se avisa por stderr.
- **Cancelar un turno ya no tira la sesión**: se cancela el turno y se conserva la sesión
  (y su cache) para el siguiente mensaje.

### Changed

- **`claude-code` y `claude-code-plan` comparten exactamente el mismo perfil de tools y
  permisos**, y difieren **solo** en el modo inicial. Antes diferían también en
  `nativeTools`, lo que dejaba un estado a medias: el agente salía de plan por su cuenta
  (OpenCode no cambia de agente por ello) y creía poder editar mientras OpenCode seguía
  dándole el perfil restringido.
- **Nueva opción `claudeCode.forwardEnvContext`** (default `true`): reenvía la parte
  **factual** del system prompt de OpenCode (`<env>` — directorio de trabajo, raíz del
  workspace, git, plataforma, fecha — y `<available_references>`) como contexto de usuario.
  Con `preset` el system nunca llega al agente y trabajaba sin saber dónde estaba. Solo
  viajan bloques factuales, nunca las instrucciones de comportamiento de OpenCode, así que
  la sesión sigue en suscripción (verificado con `scripts/verify-billing.mjs`). Se envía
  completo una vez por sesión y después solo el delta de lo que cambió.
- El id de sesión de Claude Code se registra por stderr al crearla, sin necesidad de
  `ACP_DEBUG`, junto al comando para retomarla.

### Known issues

- El desglose de `usage` por turno lo reporta el agente ACP de forma acumulativa y algún
  turno puede aparecer con delta 0; el total de la sesión sí es correcto.

## [Unreleased]

### Added
- **Manejo correcto de `ExitPlanMode`.** Cuando el agente sale de modo plan (llega como
  `requestPermission` con `toolCall.kind === "switch_mode"`):
  - el **plan** (markdown en `rawInput.plan`) ahora se **renderiza como texto** del
    asistente antes del prompt de aprobación, en vez de quedar enterrado en la metadata;
  - el permiso se etiqueta de forma estable como **`ExitPlanMode`** (regla
    `permission: { ExitPlanMode: "allow" }` posible; por defecto pregunta);
  - se escucha `current_mode_update` y, tras aprobar (plan → default/acceptEdits), el
    bridge **deja de re-forzar** el modo del agente, de modo que la implementación continúa
    en la misma sesión en lugar de volver a plan en el siguiente turno.

### Fixed
- **Cambiar de agente normal a `claude-code` (ACP) a mitad de sesión ignoraba todo
  el progreso previo.** Tanto la reutilización en caliente de una sesión ACP viva
  (`this.current`, que sobrevive intacta a un cambio de agente) como el `resume`
  tras un reinicio de proceso asumían que lo único nuevo desde el último turno ACP
  era el último mensaje de usuario (`lastUserBlocks`). Si entre medias otro agente
  (p. ej. un modelo distinto) corrió turnos sobre la misma conversación de
  OpenCode, esos turnos nunca llegaban a Claude Code: se resumía/reutilizaba con
  su historial antiguo y solo el mensaje más reciente, dando la impresión de una
  sesión nueva. Ahora `TurnState` guarda `sentLen` (hasta dónde llega el
  conocimiento del agente) y cada envío usa `catchUpBlocks`, que reconstruye como
  transcripción (con prefijo de rol) **todo** lo ocurrido desde `sentLen` en
  adelante — 1 mensaje en el caso normal, el tramo completo si hubo un agente
  intercalado.
- **Corrupción de resultados de tools (resultados rancios/misruteados).** El `toolCallId`
  se acuñaba como `acp_${counter}` con un contador **por `McpHost`** que se **reinicia a 0**
  en cada reset de sesión ACP (cambio de tools/system prompt, nueva conversación, resume).
  Dentro de una misma conversación, OpenCode reenvía todo el historial; tras un reset una
  llamada nueva volvía a recibir `acp_1` y `detectContinuation` la casaba con un tool-result
  **viejo** del historial → glob devolvía un README, bash devolvía "background agent task
  launched", etc. Ahora cada host usa un **prefijo nonce aleatorio** (`acp_<hex>_${counter}`),
  así que los IDs nunca colisionan entre sesiones, reinicios de proceso ni resume.
- **`claude-code-plan`: los subagentes (`Task`) fallaban.** El agente de plan no tenía
  `nativeSubagents`, así que su `Task` no era el nativo de Claude Code sino el `task`
  reenviado de OpenCode → OpenCode creaba subagentes (`explore`, …) enrutados a **otros
  providers** (`opencode-go`/`opencode`), que caían con *Bad Gateway* / *Insufficient
  Balance* / *ProviderModelNotFound*. Ahora `claude-code-plan` comparte la misma base de
  features nativos que `claude-code` (subagentes nativos que corren en la suscripción y
  delegan tools a OpenCode), con `mode: "plan"` y sin la tool de edición nativa
  (`NotebookEdit`) por ser modo de solo lectura.

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
