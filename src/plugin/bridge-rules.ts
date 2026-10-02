// Permission-bridge rules, shared by the plugin half and the provider half
// (same module-sharing pattern as sessions.ts — both halves run inside the
// OpenCode process: the plugin registers them, the provider consults them).
//
// Why this exists: the Claude agent asks (over ACP `requestPermission`) for
// permission to run one of ITS OWN native tools. OpenCode's permission engine
// can't be asked from inside the provider, so the bridge evaluates the agent's
// rules here first and only falls back to an interactive `question` tool-call
// when they say "ask".
//
// Evaluation mirrors V2 `Permission.evaluate` with ONE deliberate difference:
// rules whose `action` is the wildcard are IGNORED. V2's defaults start with
// `*: allow`, which would silently auto-approve every native Claude tool; the V1
// behaviour (and the safe one for a bridged agent) is to ask.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".acp-model-provider");
const FILE = join(DIR, "always.json");

export interface BridgeRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

export type Verdict = BridgeRule["effect"];

/** Per-agent rules, published by the plugin's `agent.transform` (replayed on config reload). */
const agents = new Map<string, BridgeRule[]>();

/** "Always allow" decisions persisted across restarts, per agent. Loaded lazily and cached. */
let always: Record<string, BridgeRule[]> | undefined;

function loadAlways(): Record<string, BridgeRule[]> {
  if (always) return always;
  always = readAlwaysDisk();
  return always;
}

/** Lectura directa desde disco (sin caché) — base del merge-on-read. */
function readAlwaysDisk(): Record<string, BridgeRule[]> {
  try {
    return existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as Record<string, BridgeRule[]>) : {};
  } catch {
    return {};
  }
}

/** Escritura atómica (tmp + rename en el mismo filesystem): nunca deja FILE a medias. */
function atomicWriteJson(data: unknown): void {
  mkdirSync(DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, FILE);
}

/** Publish an agent's rules (replaces the previous snapshot for that agent). */
export function publishAgentRules(agentID: string, rules: readonly BridgeRule[]): void {
  agents.set(agentID, [...rules]);
}

/** Rules an agent has published (empty when the plugin hasn't seen it). */
export function agentRules(agentID: string): readonly BridgeRule[] {
  return agents.get(agentID) ?? [];
}

/** Persist an "always allow" decision for one (agent, tool, target). Idempotent. */
export function addAlwaysRule(agentID: string, action: string, resource: string): void {
  try {
    // Merge-on-read: se relee el fichero en cada escritura para no perder las
    // reglas que otro proceso OpenCode haya guardado tras cargar la caché.
    const all = readAlwaysDisk();
    const list = (all[agentID] ??= []);
    if (list.some((r) => r.action === action && r.resource === resource)) {
      always = all;
      return;
    }
    list.push({ action, resource, effect: "allow" });
    atomicWriteJson(all);
    always = all;
  } catch {
    /* best-effort: a lost rule only means asking one more time next run */
  }
}

/**
 * Evaluate one bridged request: `action` is the native tool (Bash, Skill, …),
 * `resource` the target (command / skill / path). Always-rules win over the
 * agent's configured rules (they are the user's latest decision); `*`-action
 * rules are skipped and the default is `ask`, so nothing auto-approves.
 */
export function evaluate(agentID: string | undefined, action: string, resource: string): Verdict {
  const rules: BridgeRule[] = [
    ...(agentID ? agents.get(agentID) ?? [] : []),
    ...(agentID ? loadAlways()[agentID] ?? [] : []),
  ];
  const candidates = rules.filter((r) => r.action !== "*" && wildcard(action, r.action));
  let verdict: Verdict = "ask";
  for (const r of candidates) {
    if (wildcard(resource, r.resource)) verdict = r.effect;
  }
  return verdict;
}

/** V2 `util/wildcard.ts`, copied: `*`/`?` globs, `\` normalized, trailing space tolerated. */
export function wildcard(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";

  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized);
}
