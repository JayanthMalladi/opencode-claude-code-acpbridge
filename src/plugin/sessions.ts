// Persistent registry linking an OpenCode sessionID to a Claude Code (ACP)
// sessionId. The two IDs do NOT coincide, so we map one to the other and keep it
// synced: when OpenCode resumes a session (new process), the provider can call
// `resumeSession(acpSessionId)` instead of replaying the whole history → saves
// tokens. The OpenCode id is only a KEY here; the agent id is what gets resumed.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".acp-model-provider");
const FILE = join(DIR, "sessions.json");

/** Cumulative ACP usage snapshot — same shape the agent emits and the model
 *  already stores in `TurnState.lastUsage`. All fields optional: not every
 *  agent reports every counter. */
export interface AcpUsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  totalTokens?: number;
}

export interface SessionLink {
  /** Claude Code (ACP) session id to resume — NEVER the OpenCode id. */
  acpSessionId: string;
  /** Message count we last sent, to detect divergence (compaction/rollback). */
  sentHistoryLen: number;
  ts: number;
  /** Cumulative ACP usage at the end of the last turn. Lets a new process seed
   *  the in-memory snapshot on resume so per-turn deltas stay correct from the
   *  first post-resume turn. Optional for backward compatibility with old
   *  registry entries. */
  lastUsage?: AcpUsageSnapshot;
  /** Hash of the conversation's first user message (same as the model's
   *  `convKey`). Identity check for resume: if the OpenCode sessionID were ever
   *  reused for an unrelated conversation, this lets the caller notice. Optional
   *  for backward compatibility with old registry entries. */
  convKey?: string;
}

function readAll(): Record<string, SessionLink> {
  try {
    return existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as Record<string, SessionLink>) : {};
  } catch {
    return {};
  }
}

/** Lookup the agent session linked to an OpenCode sessionID (undefined if none). */
export function getLink(ocSession: string): SessionLink | undefined {
  return readAll()[ocSession];
}

/** Upsert the link (keeps the registry synchronized after create/recreate). */
export function setLink(ocSession: string, acpSessionId: string, sentHistoryLen: number, convKey?: string): void {
  try {
    mkdirSync(DIR, { recursive: true });
    const all = readAll();
    // Preserve `lastUsage` from any prior entry: it's updated on a separate
    // event (end-of-turn) and would otherwise be clobbered by every setLink.
    const prev = all[ocSession];
    all[ocSession] = {
      acpSessionId,
      sentHistoryLen,
      ts: Date.now(),
      ...(prev?.lastUsage ? { lastUsage: prev.lastUsage } : {}),
      ...(convKey ? { convKey } : {}),
    };
    writeFileSync(FILE, JSON.stringify(all));
  } catch {
    /* best-effort: a missing registry just means resume won't kick in */
  }
}

/** Forget the link for an OpenCode session. Used when the conversation is rewound
 *  (revert/unrevert): the agent-side session still remembers everything that was
 *  undone, so resuming it would resurrect the reverted turns. Dropping the link
 *  makes the next turn start a clean agent session from the truncated history. */
export function clearLink(ocSession: string): boolean {
  try {
    const all = readAll();
    if (!all[ocSession]) return false;
    delete all[ocSession];
    mkdirSync(DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

/** Patch the cumulative usage snapshot of an existing link. No-op if the link
 *  isn't registered yet (setLink runs first at session create/reuse time). */
export function updateUsage(ocSession: string, lastUsage: AcpUsageSnapshot): void {
  try {
    mkdirSync(DIR, { recursive: true });
    const all = readAll();
    const entry = all[ocSession];
    if (!entry) return;
    all[ocSession] = { ...entry, lastUsage, ts: Date.now() };
    writeFileSync(FILE, JSON.stringify(all));
  } catch {
    /* best-effort, same policy as setLink */
  }
}
