// Model metadata (cost, limits, modalities, …) for the discovered agent models,
// sourced from the authoritative models.dev catalog — the same one OpenCode uses
// and caches in ~/.cache/opencode/models.json. We reuse that cache when present
// and only fetch as a fallback. Agent aliases (sonnet/haiku/opus) map to the
// latest model of that family; capabilities are refined with the agent's
// promptCapabilities.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCache, writeCache } from "./cache.js";
import type { DiscoveredModel } from "./discover.js";

const MODELS_DEV_URL = process.env.OPENCODE_MODELS_URL
  ? `${process.env.OPENCODE_MODELS_URL}/api.json`
  : "https://models.dev/api.json";
const OPENCODE_CACHE = join(homedir(), ".cache", "opencode", "models.json");
const TTL = 24 * 60 * 60 * 1000;

const DEBUG = !!process.env.ACP_DEBUG;
const dbg = (m: string) => { if (DEBUG) process.stderr.write(`[acp-catalog] ${m}\n`); };

export interface CatalogModel {
  id: string;
  name?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  release_date?: string;
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number };
  limit?: { context: number; output: number };
  modalities?: { input: string[]; output: string[] };
}

/** Anthropic models from models.dev (OpenCode's cache first, then fetch, then {}). */
export async function loadAnthropicCatalog(): Promise<Record<string, CatalogModel>> {
  try {
    if (existsSync(OPENCODE_CACHE)) {
      const all = JSON.parse(readFileSync(OPENCODE_CACHE, "utf8"));
      const anth = all?.anthropic?.models;
      if (anth && Object.keys(anth).length) { dbg(`metadata from OpenCode cache (${Object.keys(anth).length} models)`); return anth; }
    }
  } catch { /* ignore */ }

  const cached = readCache<Record<string, CatalogModel>>("models-dev.json", TTL);
  if (cached && Object.keys(cached).length) { dbg("metadata from own cache"); return cached; }

  try {
    const res = await fetch(MODELS_DEV_URL);
    const all: any = await res.json();
    const anth: Record<string, CatalogModel> = all?.anthropic?.models ?? {};
    writeCache("models-dev.json", anth);
    dbg(`metadata fetched from models.dev (${Object.keys(anth).length} models)`);
    return anth;
  } catch (e) {
    dbg(`models.dev unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
}

function matchCatalog(id: string, catalog: Record<string, CatalogModel>): CatalogModel | null {
  if (catalog[id]) return catalog[id];
  const lower = id.toLowerCase();
  let family: string | null = null;
  if (lower.includes("opus") || lower === "default") family = "claude-opus"; // the agent's "default" = Opus 4.7
  else if (lower.includes("sonnet")) family = "claude-sonnet";
  else if (lower.includes("haiku")) family = "claude-haiku";
  if (!family) return null;
  const inFamily = Object.values(catalog).filter((m) => m.family === family);
  if (!inFamily.length) return null;
  inFamily.sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""));
  return inFamily[0];
}

/** Build OpenCode model config objects (models.dev style) for the discovered models. */
export function buildModels(
  agentModels: DiscoveredModel[],
  promptCaps: Record<string, boolean>,
  catalog: Record<string, CatalogModel>,
): Record<string, any> {
  const input = ["text"];
  if (promptCaps.image) input.push("image");
  if (promptCaps.embeddedContext) input.push("pdf");
  if (promptCaps.audio) input.push("audio");

  // Effort levels (Claude Code's `configOptions.effort`) exposed as model variants;
  // selecting one adds `{effort}` to the options → `providerOptions.acp.effort`.
  const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

  const out: Record<string, any> = {};
  for (const am of agentModels) {
    const cat = matchCatalog(am.id, catalog);
    const is1m = /\[1m\]|1m/i.test(am.id);
    const isDefault = am.id.toLowerCase() === "default"; // "default" = Opus 4.7 w/ 1M ctx
    const reasoning = cat?.reasoning ?? true;
    const variants: Record<string, { effort: string }> = {};
    if (reasoning) for (const e of EFFORTS) variants[e] = { effort: e };
    out[am.id] = {
      id: am.id,
      name: (am.name || cat?.name || am.id) + (is1m ? " · extra usage" : ""),
      attachment: !!(promptCaps.image || cat?.attachment),
      reasoning,
      tool_call: true, // OpenCode orquesta
      cost: cat?.cost
        ? { input: cat.cost.input, output: cat.cost.output, cache_read: cat.cost.cache_read ?? 0, cache_write: cat.cost.cache_write ?? 0 }
        : { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      limit: {
        context: is1m || isDefault ? Math.max(cat?.limit?.context ?? 0, 1_000_000) : cat?.limit?.context ?? 200_000,
        output: cat?.limit?.output ?? 8192,
      },
      modalities: { input: [...input], output: ["text"] },
      ...(Object.keys(variants).length ? { variants } : {}),
    };
  }
  return out;
}
