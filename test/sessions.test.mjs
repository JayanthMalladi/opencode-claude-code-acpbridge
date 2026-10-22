import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import "./helpers.mjs";

const { getLink, setLink } = await import("../dist/plugin/sessions.js");
const FILE = join(process.env.HOME, ".acp-model-provider", "sessions.json");

test("registry: links round-trip with id prefixes; stale entries are pruned on write", () => {
  mkdirSync(join(process.env.HOME, ".acp-model-provider"), { recursive: true });
  const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
  writeFileSync(FILE, JSON.stringify({ ses_old: { acpSessionId: "x", sentHistoryLen: 1, ts: old } }));
  setLink("ses_new", "acp-1", 3, "conv", ["acp_aa_", "acp_bb_"]);
  const link = getLink("ses_new");
  assert.equal(link.acpSessionId, "acp-1");
  assert.deepEqual(link.idPrefixes, ["acp_aa_", "acp_bb_"]);
  const onDisk = JSON.parse(readFileSync(FILE, "utf8"));
  assert.equal(onDisk.ses_old, undefined);
  // another process writes the file: the mtime check picks it up
  writeFileSync(FILE, JSON.stringify({ ...onDisk, ses_ext: { acpSessionId: "y", sentHistoryLen: 2, ts: Date.now() } }));
  assert.equal(getLink("ses_ext").acpSessionId, "y");
});
