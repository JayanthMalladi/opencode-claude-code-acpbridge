// Verifica el fix de "cambiar de agente a mitad de sesión pierde el progreso":
// simula un turno intercalado de OTRO agente/modelo (mensajes que Claude Code
// nunca vio) y comprueba que, al volver a esta misma sesión ACP, el catch-up
// (no solo el último mensaje) le llega y puede responder sobre AMBOS datos.
import { createACPModelProvider } from "../dist/index.js";
import { streamText } from "ai";

const model = createACPModelProvider({
  command: "claude-agent-acp",
  claudeExecutable: process.env.CLAUDE_CODE_EXECUTABLE || "claude",
  claudeCode: { systemPromptMode: "preset", mode: "bypassPermissions" },
}).languageModel(process.env.VERIFY_MODEL || "claude-code");

const OC_SESSION = "verify-interleave-" + Date.now();
const acp = { acp: { ocSession: OC_SESSION } };

async function run(label, messages) {
  let out = "", err = null;
  for await (const p of streamText({ model, messages, providerOptions: acp }).fullStream) {
    if (p.type === "text-delta") out += (p.delta ?? p.text ?? "");
    else if (p.type === "error") { err = p.error; break; }
  }
  console.log(`\n--- ${label} ---`);
  if (err) console.log("ERROR:", String(err?.message ?? err));
  else console.log(out.trim());
  return out;
}

// Turno 1: SOLO esto realmente le llega a Claude Code.
await run("turno 1 (claude-code)", [
  { role: "user", content: "Mi color favorito es el turquesa. Responde solo: Anotado color." },
]);

// Turno 2, MISMA sesión de OpenCode (mismo ocSession, mismo primer mensaje →
// mismo convKey → dispara la rama de reutilización en caliente), pero el
// historial que OpenCode reenvía ahora incluye un turno "de otro agente"
// (paella) que Claude Code JAMÁS procesó. Antes del fix, solo se enviaba el
// último mensaje y Claude no podía saber lo de la paella.
const out2 = await run("turno 2 (tras 'otro agente' intercalado)", [
  { role: "user", content: "Mi color favorito es el turquesa. Responde solo: Anotado color." },
  { role: "assistant", content: "Anotado color." },
  { role: "user", content: "Mi plato favorito es la paella. Responde solo: Anotado plato." },
  { role: "assistant", content: "Anotado plato." },
  { role: "user", content: "¿Cuáles son los DOS datos (color y plato) que mencioné en esta conversación? Respóndelos en una sola línea, formato 'color=X, plato=Y'." },
]);

const ok = /turquesa/i.test(out2) && /paella/i.test(out2);
console.log(`\n${ok ? "✅ PASS" : "❌ FAIL"} — ${ok ? "recuerda ambos datos (catch-up funcionó)" : "falta algún dato (catch-up NO funcionó)"}`);
process.exit(ok ? 0 : 1);
