// Verifica los tres fixes de identidad/sincronía de sesión:
//   1) CONTEXTO: el bloque <env> del system prompt de OpenCode llega al agente
//      como contexto de usuario (con systemPromptMode "preset" el system NO viaja).
//   2) CAMBIO DE AGENTE: cambiar el system prompt (= cambiar de agente en OpenCode)
//      NO debe recrear la sesion ACP ni replayar el historial.
//   3) REVERT: truncar el historial SI debe recrear la sesion (el agente no puede
//      "desrecordar"), sin reenviar el historial por duplicado.
import { createACPModelProvider } from "../dist/index.js";
import { streamText } from "ai";

const provider = createACPModelProvider({
  command: process.env.ACP_COMMAND || "claude-agent-acp",
  claudeExecutable: process.env.CLAUDE_CODE_EXECUTABLE || "claude",
  claudeCode: { systemPromptMode: "preset", mode: "bypassPermissions" },
});
const model = provider.languageModel(process.env.VERIFY_MODEL || "sonnet");
const OC = "verify-continuity-" + Date.now();

const CWD = process.cwd();
const sys = (extra) => ({
  role: "system",
  content:
    `You are ${extra}.\nHere is some useful information about the environment you are running in:\n` +
    `<env>\n  Working directory: ${CWD}\n  Is directory a git repo: yes\n  Platform: linux\n  Today's date: Fri Aug 21 2026\n</env>`,
});

async function run(label, messages) {
  let out = "", err = null;
  for await (const p of streamText({ model, messages, providerOptions: { acp: { ocSession: OC } }, allowSystemInMessages: true }).stream) {
    if (p.type === "text-delta") out += p.delta ?? p.text ?? "";
    else if (p.type === "error") { err = p.error; break; }
  }
  console.log(`\n--- ${label} ---\n${err ? "ERROR: " + String(err?.message ?? err) : out.trim()}`);
  return out;
}

// (1) Turno 1: el agente debe conocer el working directory via <env>.
const t1 = await run("t1 · contexto <env> (agente 'build')", [
  sys("the build agent"),
  { role: "user", content: "Responde SOLO con el working directory exacto que te han indicado en el contexto. Nada mas." },
]);

// (2) Turno 2: MISMO ocSession, system DISTINTO (simula cambiar a otro agente).
//     Debe reutilizar la sesion: el agente recuerda el turno 1.
const t2 = await run("t2 · cambio de agente (system distinto)", [
  sys("the plan agent"),
  { role: "user", content: "Responde SOLO con el working directory exacto que te han indicado en el contexto. Nada mas." },
  { role: "assistant", content: t1.trim() },
  { role: "user", content: "Mi fruta favorita es el mango. Responde solo: Anotado." },
]);

// (3) Turno 3: historial TRUNCADO (revert del turno 2) -> sesion nueva.
const t3 = await run("t3 · revert (historial truncado)", [
  sys("the plan agent"),
  { role: "user", content: "Responde SOLO con el working directory exacto que te han indicado en el contexto. Nada mas." },
  { role: "assistant", content: t1.trim() },
  { role: "user", content: "Sin mirar nada mas: ¿he mencionado alguna fruta en esta conversacion? Responde solo SI o NO." },
]);

const checks = [
  ["t1 conoce el working directory (<env> reenviado)", t1.includes(CWD)],
  ["t2 reutiliza la sesion pese al system distinto", /anotado/i.test(t2)],
  ["t3 tras revert no recuerda la fruta", /\bno\b/i.test(t3) && !/mango/i.test(t3)],
];
let ok = true;
console.log("");
for (const [n, p] of checks) { console.log(`${p ? "OK  " : "FAIL"} ${n}`); if (!p) ok = false; }
console.log(`\n${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
