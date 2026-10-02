# MIGRATION_V2.md — Port a OpenCode V2

Paquete: `opencode-claude-code-acpbridge` v0.8.0 (V1) → V2 (`@opencode/plugin`, OpenCode 2.0.14).
Fuentes de verdad: `opencode-v2/` (checkout local), docs `https://opencode.ai/v2/docs/…`.

## Estado / Breaking changes (0.9.0)

**Port completado y verificado.** Publicado como **0.9.0** (smoke test OK): auto-registro
del provider (`provider.transform` → `aisdk:<spec>`), agentes inyectados con ruleset
`permissions`, y reuse/resume de sesión **sin reenvío de historial** (incluido el catch-up
tras cambiar de agente).

> ⚠️ **0.9.0+ solo funciona con OpenCode V2; para OpenCode V1 conserva 0.8.x.**

El detalle completo de los breaking changes (runtime de plugins, config `plugins[]`,
`agents.permissions`, variantes `#variant`, puente de permisos `question`, destino de
desarrollo por directorio, CLI `-m`, requisitos) está en
**[CHANGELOG 0.9.0](CHANGELOG.md#090--opencode-v2-2026-10-01)**; la guía práctica en
[README § De 0.8.x (V1) a 0.9.x (V2)](README.md#de-08x-v1-a-09x-v2).
Este documento queda como **plan/diseño del port** (decisiones y mapeos).

## 1. Resumen

| Bloque | Estado |
| :----- | :----- |
| Provider factory (`createACPModelProvider`) | Compatible tal cual. `sdk-factory.ts` V2 sigue buscando export `create*` y llamándolo con `{name, ...settings, headers, body}` |
| `LanguageModelV3` (`model.ts`) | Compatible (`@ai-sdk/provider` 3.0.8 = peer `^3.0.0`). Requiere 2 ajustes (ver §5) |
| ACP/MCP-host/claude-config/sessions/cache/catalog | Sin API V1 — sin cambios (salvo `buildModels` → `Model.Info`, ver §6) |
| Plugin (`src/plugin/index.ts`) | **Reescritura total** — V1 no corre en V2 |
| Puente de permisos (`ctx.ask`) | **Sin equivalente V2** — rediseño nuevo (ver §4) |
| `package.json` | `@opencode-ai/plugin` → `@opencode/plugin` |

## 2. Mapeo de hooks V1 → V2

| V1 | V2 |
| :-- | :-- |
| `tool: { claude_permission }` | Eliminado (ver §4) |
| `"chat.params"` (inyecta `output.options`) | `ctx.session.hook("context")` mutando `event.options` (`SessionRequestOptions = GenerationOptionsFields & Record<string, unknown>`; no-generation keys → `request.providerOptions` → `providerOptions[<providerID>]`) |
| `event` (`session.updated` + `info.revert` → `clearLink`) | `ctx.event.subscribe()` filtrando `session.revert.committed` y `session.revert.cleared` (`event.data.sessionID`) |
| `config` (auto-registro provider + agentes) | `ctx.provider.transform` (`editor.add({info, models})`) + `ctx.agent.transform` (`editor.update(id, fn)`, upsert) |
| `PluginModule { id, server }` | `export default Plugin.define({ id, setup(ctx) })` — V2 lee `id`+`setup()`, ignora `server()` |
| `dispose` | `setup` retorna cleanup |

### context hook — qué inyecta por turno

```ts
ctx.session.hook("context", (event) => {
  if (event.model.providerID !== providerId) return;
  event.options.ocSession = event.sessionID;
  event.options.ocAgent = event.agent;
  // resumeId/resumeLen/resumeLastUsage/resumeConvKey desde getLink(ocSession)
  // Opciones Claude del agente (mode/effort/nativeBase) desde mapa en memoria
  Object.assign(event.options, agentOptionsOf(event.agent));
});
```

`Agent.Info.request {settings,headers,body}` NO se consume en core V2 → toda inyección
por llamada pasa por este hook (corrige el bug latente de V1 `request`).

## 3. Config V1 → V2

```jsonc
// V1
{ "provider": { "acp": { "npm": "…", "options": {…}, "models": {…} } },
  "plugin": [["opencode-claude-code-acpbridge", { "command": "claude-agent-acp" }]] }

// V2
{ "plugins": [{ "package": "opencode-claude-code-acpbridge",
                "options": { "command": "claude-agent-acp" } }] }
```

- El provider ya NO se declara en config: lo inyecta el plugin vía `ctx.provider.transform`
  (`package: "file://…" | "<npm>"`, `settings: discOpts`, `activation: "enabled"`).
- Modelos: `Model.Info[]` en vez de objeto models.dev. `variants` V1 `{effort:{…}}` →
  `[{ id: "high", settings: { effort: "high" } }]` (variant settings → `defaults.providerOptions`).
- Agentes: config `agent.<name>` → campos V2 `model | request | system | description |
  mode | hidden | color | steps | disabled | permissions` (sin `options` ni `permission`).
  Model ref con variant: `"acp/default#high"`.
- Reglas V1 `permission: { Bash: { "git *": "allow" } }` migra solo a
  `permissions: [{ action: "Bash", resource: "git *", effect: "allow" }]` (normalize.ts).
- `options` de los agentes (mode/effort/nativeTools…) viajan SOLO por el context hook
  (mapa del plugin, configurable con `plugins[].options.agents`).

## 4. Puente de permisos (decisión: tool nativa `question`)

`ctx.ask` no existe en V2. Plugin solo expone `permission: list | get | reply | rules | hook(evaluate)`;
`session.permission.create` (→ `Permission.ask`) no está en el dominio y los tools de plugin
NO pasan por `Permission.assert` (solo nativos y MCP).

Diseño elegido (el provider ya emite tool-calls arbitrarios al history):

1. ACP `requestPermission` → `onRequestPermission` evalúa reglas ANTES de nada:
   - `allow` → resuelve ACP directo (sin diálogo).
   - `deny` → resuelve deny directo.
   - `ask` → emite tool-call **`question`** (deferred, patrón idéntico al actual) con
     `{questions: [{ question: "<tool>: <title>", header: "Permiso", options:
     [{label:"Allow once"},{label:"Always allow"},{label:"Deny"}]}]}`.
2. El tool-result del `question` llega por el mismo mecanismo continuado
   (`detectContinuation` → `pendingPermissions`) → se parsea la respuesta →
   `Allow once`/`Always allow` → approve; `Deny`/error/ambiguo → deny (**fail closed**).
3. `Always allow` persiste una regla en `~/.acp-model-provider/always.json` (nuevo
   `src/plugin/bridge-rules.ts`, módulo compartido plugin↔provider, patrón `sessions.ts`).

### Semántica de reglas del bridge (`bridge-rules.ts`)

Réplica de `Permission.evaluate` V2 pero **filtrando**:

```ts
candidates = agent.permissions.filter(r => r.action !== "*" && wildcard(nativeTool, r.action));
rule       = findLast(candidates, r => wildcard(target, r.resource));
effect     = rule?.effect ?? "ask";        // default ask = comportamiento V1
```

- Las reglas `action:"*"` (defaults V2 `*: allow`) NO aplican al bridge: conserva el
  default V1 de **preguntar** por las tools nativas Claude y evita auto-allow accidental.
- El usuario regula con `agent.claude-code.permissions: [{action:"Bash", resource:"git *", effect:"allow"}]`.
- Reglas + always-rules se publican en el store desde `ctx.agent.transform` (replay en config reload).
- El agente inyectado añade `{ action: "question", resource: "*", effect: "allow" }` para que
  el assert interno del tool `question` no duplique el prompt.

Diferencias vs V1 documentadas: el diálogo del `question` sustituye a la tarjeta de permisos;
"always" vive en el propio store (no en `PermissionSaved`); `session.permissions` (rules por
sesión) no se evalúan en el bridge.

## 5. Ajustes en `src/provider/model.ts`

1. **providerOptions key**: `readonly provider = "acp"` + `providerOptions["acp"]` (líneas 264, 703).
   V2 anida en `{[providerOptionKey(package, providerID)]}` = `providerID` para packages custom →
   correcto SOLO si el provider se registra como `acp`. Fix: fallback — si falta la key `"acp"`,
   tomar la primera key de `providerOptions` (tolera ids custom).
2. **Puente**: `emitPermissionCall` pasa de `claude_permission` → `question` (input `Question.Prompt`);
   `isApprovedOutput` pasa a parsear `output.value.answers` (json) o el contenido de texto;
   añadir rama allow/deny directa en `onRequestPermission` (sin emitir).
3. `convertTools`: eliminar el skip de `claude_permission` (ya no existe); `question` se
   muestra al agente (ya se hacía, con descripción nudgeada).
4. Sin cambios: McpHost, resume, usage, revert detection, watchdogs.

## 6. Cambios por fichero

| Fichero | Cambio |
| :------ | :----- |
| `package.json` | deps/peer: `@opencode/plugin ^2.0`; quitar `@opencode-ai/plugin` |
| `src/plugin/index.ts` | Reescritura: `Plugin.define`, `provider.transform`, `agent.transform`, `session.hook("context")`, `event.subscribe`, sin `tool` |
| `src/plugin/bridge-rules.ts` | **Nuevo**: store reglas agente + always persistente + wildcard + `evaluate()` |
| `src/plugin/catalog.ts` | `buildModelsInfo()` → `Model.Info[]` (capabilities/cost[]/variants[]/limit/status/enabled) |
| `src/index.ts` | default export → `Plugin.define({id, setup})`; mantener exports `create*` |
| `src/provider/model.ts` | §5 |
| `README.md` / `docs` | Bloques config V2 (`plugins` array, sin `provider`/`plugin` V1) |

## 7. Bugs detectados (heredados / latentes)

1. `providerOptions["acp"]` hardcodeado — rompe con `providerId` custom (fix en §5.1).
2. `Agent.Info.request` no consumido por core V2 — las opciones por agente DEBEN viajar por
   el context hook (resuelto en §2).
3. V1 `chat.params` solo existía para el agente loop — en V2 el hook `context` cubre
   title/compaction/generate igualmente (mismo `event.options`).
4. `claudePermissionTool` registrada siempre aunque no hubiera puente — eliminada.

## 8. Verificación

1. `npm i && npx tsc --noEmit` (devDep `@opencode/plugin@2.0.x`).
2. `opencode.json` mínimo con `plugins: [{package: "file://…/acp-model-provider", options:{command:"claude-agent-acp"}}]`.
3. `ACP_DEBUG=1 opencode` → log `[acp-plugin] auto-registered provider 'acp' … models: …`.
4. Turno con tool nativa (Skill/ExitPlanMode) → diálogo `question` → verdict → ACP continúa.
5. Revert en TUI → `[acp-plugin] session … rewound — link dropped`.
