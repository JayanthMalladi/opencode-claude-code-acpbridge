// Verifica el fix del BUFFER de chunks: texto completo + razonamiento visible.
//
// El agente habla por dos canales asíncronos independientes (texto/thinking por
// stdio ACP, tool-calls por el socket del McpHost). Antes, cuando una tool-call
// cerraba el stream, todo lo que seguía llegando por stdio se descartaba en
// silencio — de ahí las frases cortadas y la ausencia del bloque de razonamiento.
//
// Comprueba que: (1) llegan partes `reasoning-*` con effort máximo, (2) el texto
// no queda cortado a mitad de frase, (3) las tool-calls se resuelven.
import { createACPModelProvider } from "../dist/index.js";
import { streamText, tool } from "ai";
import { z } from "zod";

const model = createACPModelProvider({
  command: process.env.ACP_COMMAND || "claude-agent-acp",
  claudeExecutable: process.env.CLAUDE_CODE_EXECUTABLE || "claude",
  claudeCode: { systemPromptMode: "preset", mode: "bypassPermissions", effort: "max" },
}).languageModel("sonnet");

// Dos "ficheros" sintéticos: obligan a dos tool-calls con texto entre medias.
const FILES = {
  "alpha.txt": "El proyecto alpha calcula rutas minimas sobre grafos dispersos.",
  "beta.txt": "El proyecto beta comprime series temporales con codificacion delta.",
};

const tools = {
  read_file: tool({
    description: "Lee un fichero del proyecto y devuelve su contenido.",
    inputSchema: z.object({ path: z.string().describe("ruta del fichero") }),
    execute: async ({ path }) => FILES[path] ?? `ERROR: no existe ${path}`,
  }),
};

const parts = [];
let text = "";
let reasoning = "";
let toolCalls = 0;
let error = null;

const res = streamText({
  model,
  tools,
  stopWhen: (s) => s.steps.length >= 6,
  providerOptions: { acp: { ocSession: "verify-stream-" + Date.now(), effort: "max" } },
  prompt:
    "Tengo dos ficheros: alpha.txt y beta.txt. Leelos UNO A UNO con read_file. " +
    "Antes de cada lectura escribe una frase completa diciendo que vas a leer y por que. " +
    "Al final escribe un parrafo comparando ambos proyectos.",
});

for await (const p of res.fullStream) {
  parts.push(p.type);
  if (p.type === "text-delta") text += p.delta ?? p.text ?? "";
  else if (p.type === "reasoning-delta") reasoning += p.delta ?? p.text ?? "";
  else if (p.type === "tool-call") toolCalls++;
  else if (p.type === "error") { error = p.error; break; }
}

console.log("--- TEXTO ---\n" + text.trim());
console.log("\n--- RAZONAMIENTO (" + reasoning.length + " chars) ---");
console.log(reasoning.trim().slice(0, 600) || "(vacio)");
console.log("\n--- PARTES ---");
console.log([...new Set(parts)].join(", "));

if (error) {
  console.log("\nFAIL - error: " + String(error?.message ?? error));
  process.exit(1);
}

const checks = [
  ["tool-calls ejecutadas (>=2)", toolCalls >= 2],
  ["bloque de razonamiento presente", reasoning.trim().length > 0],
  ["menciona alpha", /alpha|grafo|rutas/i.test(text)],
  ["menciona beta", /beta|series|comprim/i.test(text)],
  ["texto no cortado a mitad de frase", /[.!?:)\]"'`\n]\s*$/.test(text.trim())],
];

let ok = true;
console.log("");
for (const [name, pass] of checks) {
  console.log(`${pass ? "OK  " : "FAIL"} ${name}`);
  if (!pass) ok = false;
}
console.log(`\n${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
