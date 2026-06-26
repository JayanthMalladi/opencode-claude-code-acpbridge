// Spike Fase 1 — valida el PUENTE DE PERMISOS aislado (streamText hace de OpenCode).
// El agente tiene la tool NATIVA Write + modo "default" (pide permiso). Cuando pide
// permiso, el provider lo camufla como un tool-call de `claude_permission`; aquí su
// `execute` simula el veredicto de OpenCode (approved / reject). Verificamos que el
// agente SOLO crea el archivo cuando se aprueba.
import { createACPModelProvider } from "../dist/index.js";
import { streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { existsSync, rmSync, readFileSync } from "node:fs";

const FILE = "/tmp/spike-bridge.txt";

async function run(label, verdict) {
  if (existsSync(FILE)) rmSync(FILE);
  let permCalls = 0;
  const model = createACPModelProvider({
    command: "claude-agent-acp",
    claudeExecutable: "/home/antonio/.local/bin/claude",
    claudeCode: { tools: ["Write"], mode: "default" }, // Write nativo + pide permiso
  }).languageModel("default");

  const res = streamText({
    model,
    stopWhen: stepCountIs(6),
    tools: {
      claude_permission: tool({
        description: "Permission bridge meta-tool",
        inputSchema: z.object({
          tool: z.string().optional(), kind: z.string().optional(),
          title: z.string().optional(), input: z.any().optional(),
        }),
        execute: async (args) => {
          permCalls++;
          console.log(`  [${label}] claude_permission ←`, JSON.stringify(args).slice(0, 160));
          if (verdict === "approved") return "approved";
          throw new Error("The user rejected permission to use this tool call."); // simula RejectedError
        },
      }),
    },
    prompt: `Crea el archivo ${FILE} con exactamente el texto: HOLA. Usa tu herramienta Write nativa.`,
  });

  let text = "";
  for await (const p of res.fullStream) {
    if (p.type === "text-delta") text += (p.delta ?? p.text ?? "");
    else if (p.type === "tool-call") console.log(`  [${label}] tool-call →`, p.toolName);
    else if (p.type === "error") console.log(`  [${label}] error:`, String(p.error).slice(0, 120));
  }
  await res.text.catch(() => {});
  const created = existsSync(FILE);
  console.log(`=== [${label}] permCalls=${permCalls} archivoCreado=${created}` +
    (created ? ` contenido="${readFileSync(FILE, "utf8").trim()}"` : "") + ` ===`);
  console.log(`  respuesta: ${text.trim().slice(0, 160)}\n`);
  return { permCalls, created };
}

const a = await run("APPROVED", "approved");
const b = await run("DENIED", "denied");
console.log("RESULTADO:",
  a.permCalls > 0 && a.created && b.permCalls > 0 && !b.created
    ? "✅ PUENTE OK (approved crea, denied no crea, ambos piden permiso)"
    : "❌ revisar (a=" + JSON.stringify(a) + " b=" + JSON.stringify(b) + ")");
process.exit(0);
