#!/usr/bin/env node
// Pre-publish check: install the packed tarball the way OpenCode does (npm, no scripts),
// add what the OpenCode host provides to every plugin at runtime (`@opencode/plugin`),
// then make sure the plugin and the provider load. Fails on duplicate AI SDK copies,
// which would make the provider and @mcpc-tech/acp-ai-provider disagree on types.
//   node scripts/check-install.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "acpbridge-install-"));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
let ok = true;
const fail = (msg) => {
  ok = false;
  console.error(`✗ ${msg}`);
};

/** Every installed copy of `name` (any depth), as "path@version". */
function copies(app, name) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (path.endsWith(join("node_modules", name)) && existsSync(join(path, "package.json"))) {
        found.push(`${path.slice(app.length + 1)}@${JSON.parse(readFileSync(join(path, "package.json"), "utf8")).version}`);
      }
      if (entry.name === "node_modules" || entry.name.startsWith("@") || dir.endsWith("node_modules")) walk(path);
    }
  };
  walk(join(app, "node_modules"));
  return found;
}

try {
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work], root))[0];
  const app = join(work, "app");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), "{}");
  run("npm", ["install", join(work, packed.filename), "--ignore-scripts", "--no-audit", "--no-fund"], app);

  for (const name of ["@ai-sdk/provider", "ai"]) {
    const list = copies(app, name);
    console.log(`${name}: ${list.join(", ") || "(none)"}`);
    if (list.length !== 1) fail(`expected exactly one copy of ${name}, found ${list.length}`);
  }

  // What the OpenCode host injects at runtime (OpenCode >= 2.1 serves `@opencode/plugin`
  // and `effect` to plugins from its own copy).
  run("npm", ["install", `@opencode/plugin@${pkg.peerDependencies["@opencode/plugin"]}`, "--ignore-scripts", "--no-audit", "--no-fund"], app);

  const probe = `
    const m = await import(${JSON.stringify(pkg.name)});
    const plugin = m.default;
    if (!plugin || typeof plugin.id !== "string" || typeof plugin.setup !== "function") throw new Error("default export is not a V2 plugin");
    if (typeof m.createACPModelProvider !== "function") throw new Error("createACPModelProvider missing");
    const model = m.createACPModelProvider({ command: "claude-agent-acp" }).languageModel("sonnet");
    console.log("plugin " + plugin.id + " · provider spec " + model.specificationVersion);
    if (model.specificationVersion !== "v3") throw new Error("unexpected AI SDK spec " + model.specificationVersion);
  `;
  try {
    console.log(run("node", ["--input-type=module", "-e", probe], app).trim());
    console.log("✓ the plugin and the provider load from the npm install");
  } catch (error) {
    fail(`load failed: ${String(error.stderr || error.message).trim().split("\n").slice(-3).join(" | ")}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(ok ? "✅ install is compatible" : "❌ install is NOT compatible");
process.exit(ok ? 0 : 1);
