#!/usr/bin/env node
// Turn ACP_RECORD output into a committable test fixture.
//
//   node scripts/sanitize-recording.mjs <recording.jsonl> <out.jsonl> [<cwd-to-mask>]
//
// - system prompts are reduced to their <env> block (the rest is the user's private
//   OpenCode setup and never reaches the agent under `preset` anyway);
// - the recording cwd is replaced by /proj and the home dir by /home/user, everywhere;
// - header VALUES are dropped (keys kept), except x-opencode-client.
// Text is otherwise kept verbatim: the history fingerprint hashes it, so editing it
// would change what the fixture proves.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const [src, out, cwd] = process.argv.slice(2);
if (!src || !out) {
  console.error("usage: sanitize-recording.mjs <recording.jsonl> <out.jsonl> [<cwd-to-mask>]");
  process.exit(2);
}

const mask = (s) => (cwd ? s.split(cwd).join("/proj") : s).split(homedir()).join("/home/user");

function systemOnlyEnv(text) {
  const env = String(text).match(/<env>[\s\S]*?<\/env>/);
  return `[system prompt elided]${env ? `\n${env[0]}` : ""}`;
}

const lines = readFileSync(src, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const result = lines.map((e) => {
  if (e.kind !== "call") return JSON.parse(mask(JSON.stringify(e)));
  const headers = Object.fromEntries(
    Object.entries(e.headers ?? {}).map(([k, v]) => [k, k.toLowerCase() === "x-opencode-client" ? v : "<redacted>"]),
  );
  const prompt = e.prompt.map((m) => (m.role === "system" ? { ...m, content: systemOnlyEnv(m.content) } : m));
  return JSON.parse(mask(JSON.stringify({ ...e, headers, prompt })));
});
writeFileSync(out, result.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log(`${result.length} entries → ${out}`);
