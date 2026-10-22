// Prompt recorder (ACP_RECORD=<dir>): dumps every doStream input exactly as OpenCode
// built it, plus the decision the orchestrator took. Real V2 prompts are the only
// trustworthy fixtures for the history fingerprint — the delta logic broke more than
// once on shapes nobody had anticipated (see CHANGELOG 0.8.0).
//
// One JSONL file per conversation. Large payloads are truncated deterministically so
// the same text always yields the same fingerprint; binary data is replaced by its size.
import { appendFile, mkdirSync } from "node:fs";
import { join } from "node:path";

const DIR = process.env.ACP_RECORD || "";
const TEXT_CAP = 4000;
const OUTPUT_CAP = 300;

let dirReady = false;

export const recording = (): boolean => !!DIR;

function cap(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…[+${s.length - n}]`;
}

function sanitizePart(p: any): any {
  if (!p || typeof p !== "object") return p;
  switch (p.type) {
    case "text":
    case "reasoning":
      return { ...p, text: cap(String(p.text ?? ""), TEXT_CAP) };
    case "file": {
      const d = p.data;
      const size = d instanceof Uint8Array ? d.byteLength : typeof d === "string" ? d.length : 0;
      return { ...p, data: `<${size} bytes>` };
    }
    case "tool-call":
      return { ...p, input: cap(typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {}), OUTPUT_CAP) };
    case "tool-result": {
      const o = p.output;
      const out = o && typeof o === "object" && "value" in o
        ? { ...o, value: cap(typeof o.value === "string" ? o.value : JSON.stringify(o.value), OUTPUT_CAP) }
        : o;
      return { ...p, output: out };
    }
    default:
      return p;
  }
}

/** Prompt with payloads capped — keeps roles, part types, ids and providerOptions. */
export function sanitizePrompt(prompt: readonly any[]): any[] {
  return prompt.map((m) => ({
    ...m,
    content: typeof m.content === "string" ? cap(m.content, TEXT_CAP) : (m.content as any[]).map(sanitizePart),
  }));
}

export function record(conv: string, entry: Record<string, unknown>): void {
  if (!DIR) return;
  try {
    if (!dirReady) { mkdirSync(DIR, { recursive: true }); dirReady = true; }
    const file = join(DIR, `${conv.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
    appendFile(file, JSON.stringify({ ts: Date.now(), ...entry }) + "\n", () => {});
  } catch { /* recording is best-effort */ }
}
