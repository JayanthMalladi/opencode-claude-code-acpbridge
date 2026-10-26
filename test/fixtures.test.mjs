// Replays REAL OpenCode V2 prompts (recorded with ACP_RECORD, sanitized with
// scripts/sanitize-recording.mjs) through the history functions.
//
// session-mixed.jsonl — one OpenCode session, acp/haiku + opencode-go/beam-free:
//   tool loop, reuse, failed foreign turns, foreign turn with a tool, agent switch to
//   claude-code-plan (pre-0.11 name of claude-plan) with a bridged permission, a steered message, an interrupt + new
//   message, an OpenCode compaction and the first post-compaction turn.
// aux-title-compaction.jsonl — the title and compaction calls of that session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./helpers.mjs";

const { anchorsOf, classifyAnchors, classifyHistory, historyOf, msgKey } = await import("../dist/provider/history.js");

const load = (name) =>
  readFileSync(new URL(`./fixtures/v2/${name}`, import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** Pairs every recorded call with the decision the provider logged for it. */
function steps(entries) {
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].kind !== "call") continue;
    const decision = entries.slice(i + 1).find((e) => e.kind === "decision");
    out.push({ call: entries[i], decision });
  }
  return out;
}

const keysOf = (prompt) => historyOf(prompt).map(msgKey);
const texts = (m) => (typeof m.content === "string" ? [m.content] : m.content.filter((p) => p.type === "text").map((p) => p.text));

const mixed = steps(load("session-mixed.jsonl"));
const aux = steps(load("aux-title-compaction.jsonl"));

test("fixture: legacy classification reproduces every recorded reuse decision", () => {
  let sent = null;
  let session = null;
  for (const { call, decision } of mixed) {
    const keys = keysOf(call.prompt);
    if (decision.decision === "reuse") {
      assert.equal(decision.session, session, "reuse must stay on the same ACP session");
      const cls = classifyHistory(sent, keys);
      assert.equal(cls.kind, "append");
      assert.equal(cls.fromIndex, decision.from);
    }
    if (decision.decision === "new") session = decision.session;
    sent = keys; // legacy: what the provider records after reuse / continuation / new
  }
});

test("fixture facts: the shapes V2 really sends (inputs for the history redesign)", () => {
  // 1) turn 2: the tail starts with the agent's OWN previous answer (reasoning + text) → bug #1
  const reuse2 = mixed.find((s) => s.decision.decision === "reuse");
  const tail2 = historyOf(reuse2.call.prompt).slice(reuse2.decision.from);
  assert.equal(tail2[0].role, "assistant");
  assert.deepEqual(tail2[0].content.map((p) => p.type), ["reasoning", "text"]);

  // 2) V2 appends instruction updates as USER messages wrapped in <system-update>
  const all = mixed.flatMap((s) => historyOf(s.call.prompt));
  assert.ok(all.some((m) => m.role === "user" && texts(m).some((t) => t.startsWith("<system-update>"))));

  // 3) a steered message lands AFTER the tool-result of a continuation → bug #2
  const steer = mixed.find((s) => s.decision.decision === "continuation" && texts(s.call.prompt.at(-1)).some((t) => t.includes("MENSAJE-STEER")));
  assert.ok(steer, "steer recorded as a continuation");
  assert.equal(steer.call.prompt.at(-2).role, "tool");

  // 4) an interrupted tool comes back as a TEXT output holding an `aborted` error JSON,
  //    followed by the user's next message → bug #3
  const abort = mixed.find((s) => texts(s.call.prompt.at(-1)).some((t) => t.includes("NUEVO-MENSAJE")));
  assert.equal(abort.decision.decision, "continuation");
  const out = abort.call.prompt.at(-2).content[0].output;
  assert.equal(out.type, "text");
  assert.equal(JSON.parse(out.value).error.type, "aborted");

  // 5) foreign turns carry foreign tool ids (not acp_*), and the provider's own ids
  //    for the permission bridge are the bare `perm_N` → bug #10
  const ids = all.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === "tool-call").map((p) => p.toolCallId);
  assert.ok(ids.some((id) => id.startsWith("call-")));
  assert.ok(ids.some((id) => /^perm_\d+$/.test(id)));

  // 6) after an OpenCode compaction the history restarts at a <conversation-checkpoint>
  const post = mixed.find((s) => texts(historyOf(s.call.prompt)[0])[0].startsWith("<conversation-checkpoint>"));
  assert.ok(post, "post-compaction turn recorded");
  assert.equal(post.decision.decision, "new");
});

test("fixture facts: auxiliary calls reach the provider without the `context` hook", () => {
  const [title, compaction] = aux;
  // title: no tools, no ocAgent/ocSession, the title instructions live ONLY in the system
  // prompt (which `preset` never forwards) → bug #26 (session titled "<invoke name=Read>")
  assert.equal(title.call.tools.length, 0);
  assert.equal(title.call.ocAgent, undefined);
  assert.ok(!title.call.poKeys.includes("ocSession"));
  assert.ok("x-opencode-session" in title.call.headers);
  // compaction: full tool list, no context hook, whole history + the summary request,
  // served today by a cold throwaway session → bug #15
  assert.ok(compaction.call.tools.length > 0);
  assert.equal(compaction.call.ocAgent, undefined);
  assert.match(texts(compaction.call.prompt.at(-1)).join(""), /summar/i);
  assert.equal(compaction.decision.decision, "new");
  assert.ok(compaction.decision.chars > 10000);
});

test("fixture: the anchor fingerprint agrees on every recorded reuse (no new divergences)", () => {
  let sent = null;
  for (const { call, decision } of mixed) {
    const hist = historyOf(call.prompt);
    if (decision.decision === "reuse") {
      const cls = classifyAnchors(sent, anchorsOf(hist));
      assert.equal(cls.kind, "append");
      assert.ok(cls.fromIndex <= decision.from + 1, `tail starts no later than legacy (${cls.fromIndex} vs ${decision.from})`);
    }
    sent = anchorsOf(hist).map((a) => a.key);
  }
});
