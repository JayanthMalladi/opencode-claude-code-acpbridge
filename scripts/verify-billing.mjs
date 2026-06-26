// Verifica qué features mantienen la SUSCRIPCIÓN (0 extra usage). Manda un prompt
// trivial con cada config y detecta el clasificador de Anthropic (error 400 /
// "extra usage"). mode=bypassPermissions para no colgar pidiendo permisos (aquí
// solo importa el system prompt, que es lo que decide el billing).
import { createACPModelProvider } from "../dist/index.js";
import { streamText } from "ai";

const FEATURES = {
  "baseline (clean brain)": {},
  "resourceSearch":         { resourceSearch: true },
  "nativeSubagents":        { nativeSubagents: true },
  "nativeTools[Notebook]":  { nativeTools: ["NotebookEdit"] },
  "projectMemory":          { projectMemory: true },
  "nativeSkills (preload)": { nativeSkills: ["pdf"] },
  "nativeSkills (true=all)":{ nativeSkills: true },
};

const EXTRA = /extra usage|overage|third-party|not.*your plan|draw from/i;

for (const [name, feat] of Object.entries(FEATURES)) {
  const model = createACPModelProvider({
    command: "claude-agent-acp",
    claudeExecutable: "/home/antonio/.local/bin/claude",
    claudeCode: { configDir: "isolated", systemPromptMode: "preset", mode: "bypassPermissions", ...feat },
  }).languageModel("sonnet");
  try {
    let out = "", err = null;
    for await (const p of streamText({ model, prompt: "Responde solo: OK" }).fullStream) {
      if (p.type === "text-delta") out += (p.delta ?? p.text ?? "");
      else if (p.type === "error") { err = p.error; break; }
    }
    if (err) throw err;
    console.log(`✅ SUSCRIPCIÓN  ${name.padEnd(24)} → "${out.trim().slice(0, 30)}"`);
  } catch (e) {
    const m = String(e?.message ?? e);
    console.log(`${EXTRA.test(m) ? "💸 EXTRA USAGE" : "❌ ERROR      "} ${name.padEnd(24)} → ${m.slice(0, 90)}`);
  }
}
process.exit(0);
