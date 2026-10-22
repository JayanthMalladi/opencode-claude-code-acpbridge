// Shared logging. OpenCode's own log does NOT capture a plugin's stderr, so every
// line also goes to a daily file under ~/.acp-model-provider/logs/ — the only way
// to diagnose a session after the fact.
//
//   ACP_DEBUG=1        → debug lines too (stderr + file)
//   ACP_LOG=0          → no file at all
//   ACP_LOG_DIR=<dir>  → file location override
import { appendFile, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEBUG = !!process.env.ACP_DEBUG;
const FILE_ON = process.env.ACP_LOG !== "0";
const DIR = process.env.ACP_LOG_DIR || join(homedir(), ".acp-model-provider", "logs");

let dirReady = false;

function day(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

/** Append one line to today's file. Fire-and-forget: logging never breaks a turn. */
export function toFile(line: string): void {
  if (!FILE_ON) return;
  try {
    if (!dirReady) { mkdirSync(DIR, { recursive: true }); dirReady = true; }
    appendFile(join(DIR, `acp-${day()}.log`), `${new Date().toISOString()} ${line}\n`, () => {});
  } catch { /* ignore */ }
}

/** Logger for one component: `dbg` only under ACP_DEBUG, `note` always (stderr + file),
 *  `trace` always but file-only (per-turn decisions — too chatty for the TUI). */
export function logger(tag: string) {
  return {
    dbg(m: string) {
      if (!DEBUG) return;
      process.stderr.write(`[${tag}] ${m}\n`);
      toFile(`[${tag}] ${m}`);
    },
    note(m: string) {
      process.stderr.write(`[acp] ${m}\n`);
      toFile(`[${tag}] ${m}`);
    },
    trace(m: string) {
      toFile(`[${tag}] ${m}`);
    },
  };
}
