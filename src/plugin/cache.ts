// Tiny TTL cache under ~/.acp-model-provider/ for agent discovery and the
// models.dev catalog, so we don't spawn the agent / hit the network every boot.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".acp-model-provider");

export function readCache<T>(name: string, ttlMs: number): T | null {
  try {
    const file = join(DIR, name);
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf8")) as { ts?: number; key?: string; data?: T };
    if (typeof raw?.ts !== "number" || Date.now() - raw.ts > ttlMs) return null;
    return (raw.data ?? null) as T | null;
  } catch {
    return null;
  }
}

/** Read only if the stored key matches (e.g. a hash of the relevant options). */
export function readCacheKeyed<T>(name: string, ttlMs: number, key: string): T | null {
  try {
    const file = join(DIR, name);
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf8")) as { ts?: number; key?: string; data?: T };
    if (typeof raw?.ts !== "number" || Date.now() - raw.ts > ttlMs || raw.key !== key) return null;
    return (raw.data ?? null) as T | null;
  } catch {
    return null;
  }
}

export function writeCache(name: string, data: unknown, key?: string): void {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, name), JSON.stringify({ ts: Date.now(), key, data }));
  } catch {
    /* ignore */
  }
}
