#!/usr/bin/env node
// `opencode-claude-code-acpbridge sync [agent-command]` — clear the discovery + models.dev
// caches (so the next OpenCode start re-discovers) and, if given the agent
// command, re-discover now and print the models + metadata that would be
// injected. The plugin auto-discovers on boot; use this to force a refresh
// after the agent adds/removes models or models.dev metadata changes.
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverAgent } from "../plugin/discover.js";
import { loadAnthropicCatalog, buildModels } from "../plugin/catalog.js";
import { detectClaudeExecutable } from "../provider/factory.js";

const DIR = join(homedir(), ".acp-model-provider");

async function sync(command?: string): Promise<void> {
  for (const f of ["discovery.json", "models-dev.json"]) {
    try { rmSync(join(DIR, f)); } catch { /* not present */ }
  }
  process.stdout.write("Cleared discovery + catalog caches (next OpenCode start re-discovers).\n");

  command = command || process.env.ACP_COMMAND;
  if (!command) {
    process.stdout.write("Pass the agent command to preview models, e.g.\n  npx opencode-claude-code-acpbridge sync claude-agent-acp\n");
    return;
  }

  const claudeExecutable = process.env.CLAUDE_CODE_EXECUTABLE || detectClaudeExecutable();
  process.stdout.write(`Discovering from "${command}"…\n`);
  const d = await discoverAgent({ command, claudeExecutable, claudeCode: { configDir: "isolated" } });
  const catalog = await loadAnthropicCatalog();
  const models = buildModels(d.models, d.promptCaps, catalog);

  process.stdout.write(`Agent ${d.agentVersion ?? "?"} — ${d.models.length} models:\n`);
  for (const [id, m] of Object.entries(models)) {
    process.stdout.write(
      `  ${id.padEnd(14)} ctx=${m.limit.context} out=${m.limit.output} cost=${m.cost.input}/${m.cost.output} in=[${m.modalities.input.join(",")}]\n`,
    );
  }
}

const cmd = process.argv[2];
if (cmd === "sync") {
  sync(process.argv[3]).catch((e) => {
    process.stderr.write(`sync failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
} else {
  process.stdout.write("opencode-claude-code-acpbridge — usage:\n  npx opencode-claude-code-acpbridge sync [agent-command]   refresh model caches & preview\n");
  process.exit(cmd ? 1 : 0);
}
