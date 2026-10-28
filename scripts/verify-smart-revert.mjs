// Verifica `smartRevert` (experimental) contra el agente real: tras revertir un turno,
// la sesión se bifurca con `resumeSessionAt` justo antes de él — sin replay — y el
// agente NO recuerda lo revertido. Comprueba también la decisión en la grabación.
//   VERIFY_MODEL=haiku node scripts/verify-smart-revert.mjs
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ACP_RECORD = mkdtempSync(join(tmpdir(), "acp-verify-sr-"));
const { createACPModelProvider } = await import("../dist/index.js");
const { streamText } = await import("ai");

const provider = createACPModelProvider({
  command: process.env.ACP_COMMAND || "claude-agent-acp",
  claudeExecutable: process.env.CLAUDE_CODE_EXECUTABLE || "claude",
  claudeCode: { systemPromptMode: "preset", mode: "bypassPermissions", smartRevert: true },
});
const model = provider.languageModel(process.env.VERIFY_MODEL || "sonnet");
const OC = "verify-smart-revert-" + Date.now();

async function run(label, messages) {
  let out = "";
  for await (const p of streamText({ model, messages, providerOptions: { acp: { ocSession: OC } } }).stream) {
    if (p.type === "text-delta") out += p.delta ?? p.text ?? "";
    else if (p.type === "error") throw p.error;
  }
  console.log(`--- ${label} ---\n${out.trim()}`);
  return out.trim();
}

const u = (text) => ({ role: "user", content: text });
const a = (text) => ({ role: "assistant", content: text });

const t1 = await run("t1", [u("Recuerda la fruta MANGO. Responde solo: ok.")]);
const t2 = await run("t2", [u("Recuerda la fruta MANGO. Responde solo: ok."), a(t1), u("Recuerda también la fruta PERA. Responde solo: ok.")]);
void t2;
// revert t2: same history up to t1, different new message
const t3 = await run("t3 (tras revert)", [u("Recuerda la fruta MANGO. Responde solo: ok."), a(t1), u("Sin usar herramientas: ¿qué frutas te he pedido recordar? Responde solo con las frutas.")]);

const rec = readdirSync(process.env.ACP_RECORD).flatMap((f) => readFileSync(join(process.env.ACP_RECORD, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
const decisions = rec.filter((e) => e.kind === "decision").map((e) => e.decision);
const checks = [
  ["t3 recuerda MANGO", /mango/i.test(t3)],
  ["t3 no recuerda PERA (revertida)", !/pera/i.test(t3)],
  ["revert resuelto con fork (smart-revert), sin sesión nueva", decisions.includes("smart-revert") && decisions.filter((d) => d === "new").length === 1],
];
let ok = true;
for (const [n, p] of checks) { console.log(`${p ? "OK  " : "FAIL"} ${n}`); if (!p) ok = false; }
console.log(`decisions: ${decisions.join(", ")}`);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
