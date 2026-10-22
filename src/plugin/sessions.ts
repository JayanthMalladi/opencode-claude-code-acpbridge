// Persistent registry linking an OpenCode sessionID to a Claude Code (ACP)
// sessionId. The two IDs do NOT coincide, so we map one to the other and keep it
// synced: when OpenCode resumes a session (new process), the provider can call
// `resumeSession(acpSessionId)` instead of replaying the whole history → saves
// tokens. The OpenCode id is only a KEY here; the agent id is what gets resumed.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".acp-model-provider");
const FILE = join(DIR, "sessions.json");

/** Usage snapshot for the agent's last request — same shape the agent emits and
 *  the model already stores in `TurnState.lastUsage`. All fields optional: not
 *  every agent reports every counter. */
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
  /** Usage reported at the end of the last turn. Carried over on resume so a new
   *  process starts with a value instead of nothing. Optional for backward
   *  compatibility with old registry entries. */
  lastUsage?: AcpUsageSnapshot;
  /** Hash of the conversation's first user message (same as the model's
   *  `convKey`). Identity check for resume: if the OpenCode sessionID were ever
   *  reused for an unrelated conversation, this lets the caller notice. Optional
   *  for backward compatibility with old registry entries. */
  convKey?: string;
  /** Id prefixes the session minted (one per process that served it). After a restart
   *  they mark which tool-calls in the history are the agent's own — already in its
   *  session, so never replayed. Optional for backward compatibility. */
  idPrefixes?: string[];
}

/** Entries older than this are dropped on write (sessions nobody resumed in a month;
 *  most of their transcripts are gone anyway). */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

/** Parsed registry, reused while the file's mtime is unchanged: the plugin reads it on
 *  EVERY model call (V2's `context` hook fires per step). */
let cache: { sig: string; data: Record<string, SessionLink> } | null = null;

/** mtime alone is too coarse on some filesystems (two writes in one tick). */
function signature(): string {
  const st = statSync(FILE);
  return `${st.mtimeMs}:${st.size}`;
}

function readAll(): Record<string, SessionLink> {
  try {
    if (!existsSync(FILE)) return {};
    const sig = signature();
    if (cache && cache.sig === sig) return { ...cache.data };
    const data = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, SessionLink>;
    cache = { sig, data };
    return { ...data };
  } catch {
    return {};
  }
}

function prune(all: Record<string, SessionLink>): Record<string, SessionLink> {
  const now = Date.now();
  const fresh = Object.entries(all).filter(([, l]) => typeof l?.ts === "number" && now - l.ts < MAX_AGE_MS);
  fresh.sort((a, b) => b[1].ts - a[1].ts);
  return Object.fromEntries(fresh.slice(0, MAX_ENTRIES));
}

/** Escritura atómica (tmp + rename en el mismo filesystem): el fichero nunca
 *  queda truncado a medias aunque varios procesos OpenCode escriban a la vez. */
function atomicWriteJson(data: Record<string, SessionLink>): void {
  mkdirSync(DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.${Date.now()}.tmp`;
  const pruned = prune(data);
  writeFileSync(tmp, JSON.stringify(pruned));
  renameSync(tmp, FILE);
  try { cache = { sig: signature(), data: pruned }; } catch { cache = null; }
}

/** Lookup the agent session linked to an OpenCode sessionID (undefined if none). */
export function getLink(ocSession: string): SessionLink | undefined {
  return readAll()[ocSession];
}

/** Upsert the link (keeps the registry synchronized after create/recreate). */
export function setLink(
  ocSession: string,
  acpSessionId: string,
  sentHistoryLen: number,
  convKey?: string,
  idPrefixes?: string[],
): void {
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
      ...(idPrefixes?.length ? { idPrefixes: idPrefixes.slice(-8) } : {}),
    };
    atomicWriteJson(all);
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
    atomicWriteJson(all);
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
    atomicWriteJson(all);
  } catch {
    /* best-effort, same policy as setLink */
  }
}
