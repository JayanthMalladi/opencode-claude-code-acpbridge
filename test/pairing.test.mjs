import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, opts, user, run, textOf } from "./helpers.mjs";

const { modeAgentDefs, modeAgentId, pairTarget, subagentDecision, FALLBACK_MODES } = await import("../dist/plugin/pairing.js");
const { agentDefs } = await import("../dist/plugin/index.js");

const DISCOVERED = [
  { id: "auto", name: "Auto" },
  { id: "default", name: "Default" },
  { id: "acceptEdits", name: "Accept Edits" },
  { id: "plan", name: "Plan Mode" },
  { id: "dontAsk", name: "Don't Ask" },
  { id: "bypassPermissions", name: "Bypass Permissions" },
];

const acp = (id = "default", variant) => ({ providerID: "acp", id, ...(variant ? { variant } : {}) });
const zen = (id = "big-pickle") => ({ providerID: "opencode", id });

function state(models = {}) {
  const agentModels = new Map(Object.entries({ "claude-default": acp(), "claude-plan": acp("default", "high"), build: undefined, ...models }));
  return { providerID: "acp", agentModels, acpAgents: new Set(["claude-default", "claude-plan"]) };
}

test("agents: one per discovered mode, default first, mode is the only difference", () => {
  const defs = agentDefs({}, DISCOVERED);
  assert.deepEqual(Object.keys(defs), [
    "claude-default", "claude-auto", "claude-acceptedits", "claude-plan", "claude-dontask", "claude-bypasspermissions",
  ]);
  for (const [id, def] of Object.entries(defs)) {
    assert.equal(modeAgentId(def.options.mode), id);
    assert.equal(def.model, "default");
    const { mode: _m, ...rest } = def.options;
    assert.deepEqual(rest, (({ mode: _x, ...r }) => r)(defs["claude-default"].options));
  }
  assert.equal(defs["claude-plan"].variant, "high");
  assert.equal(defs["claude-default"].variant, undefined);
  assert.equal(defs["claude-bypasspermissions"].name, "Claude Code (Bypass Permissions)");
});

test("agents: no discovered modes → the known six; agentModel and options.agents still apply", () => {
  assert.equal(Object.keys(agentDefs({}, [])).length, FALLBACK_MODES.length);
  assert.equal(agentDefs({ agentModel: "sonnet" }, DISCOVERED)["claude-plan"].model, "sonnet");
  const custom = { mine: { model: "opus", options: { mode: "plan" } } };
  assert.equal(agentDefs({ agents: custom }, DISCOVERED), custom);
  assert.deepEqual(Object.keys(modeAgentDefs([{ id: "default" }], "default", {})), ["claude-default"]);
});

test("pairing: Claude Code agent on another provider's model → its own acp model", () => {
  const s = state();
  assert.deepEqual(pairTarget(s, { agent: "claude-plan", model: zen() }, zen()), acp("default", "high"));
  assert.equal(pairTarget(s, { agent: "claude-plan", model: acp("opus") }, zen()), undefined);
  // An agent whose own model was overridden to another provider still lands on acp.
  assert.deepEqual(pairTarget(state({ "claude-default": zen() }), { agent: "claude-default", model: zen() }, undefined), acp());
});

test("pairing: any other agent on an acp model → its own model, else the fallback", () => {
  const s = state({ explore: zen("fast") });
  assert.deepEqual(pairTarget(s, { agent: "explore", model: acp("opus") }, zen()), zen("fast"));
  assert.deepEqual(pairTarget(s, { agent: "build", model: acp("opus") }, zen("last")), zen("last"));
  assert.equal(pairTarget(s, { agent: "build", model: acp("opus") }, undefined), undefined);
  assert.equal(pairTarget(s, { agent: "build", model: acp("opus") }, acp()), undefined);
  assert.equal(pairTarget(s, { agent: "build", model: zen() }, zen("last")), undefined);
  assert.equal(pairTarget(s, { agent: undefined, model: acp() }, zen()), undefined);
});

test("pairing: subagents never inherit an acp model", () => {
  const s = state({ explore: zen("fast"), general: undefined });
  // Inherits the Claude Code parent's model → the default model is injected.
  assert.deepEqual(subagentDecision(s, { agent: "general" }, acp("opus"), zen()), { kind: "inject", model: "opencode/big-pickle" });
  // Its own non-acp model wins in OpenCode already.
  assert.equal(subagentDecision(s, { agent: "explore" }, acp("opus"), zen()), undefined);
  // A parent on another provider: nothing to do.
  assert.equal(subagentDecision(s, { agent: "general" }, zen(), zen()), undefined);
  // Explicit models: acp refused, others left alone.
  assert.deepEqual(subagentDecision(s, { agent: "general", model: "acp/sonnet" }, zen(), zen()), { kind: "reject", model: "acp/sonnet" });
  assert.equal(subagentDecision(s, { agent: "general", model: "opencode/x" }, acp(), zen()), undefined);
  // Continuing a child: the session watcher already paired it.
  assert.equal(subagentDecision(s, { agent: "general", sessionID: "ses_c" }, acp(), zen()), undefined);
  // No non-acp model anywhere.
  assert.deepEqual(subagentDecision(s, { agent: "general" }, acp(), undefined), { kind: "missing" });
  assert.deepEqual(subagentDecision(s, { agent: "general" }, acp(), acp("haiku")), { kind: "missing" });
  // A subagent the plugin counts as ours (configured with an acp model) keeps it.
  const own = state({ general: acp("haiku") });
  own.acpAgents.add("general");
  assert.equal(subagentDecision(own, { agent: "general" }, zen(), zen()), undefined);
});

test("provider: a call flagged pairedAgent:false fails at once, non-retryable", async () => {
  const { agent, model, done } = setup();
  try {
    await assert.rejects(
      model.doStream(opts([user("hola")], { agent: "build", extra: { pairedAgent: false } })),
      (e) => e.statusCode === 400 && e.isRetryable === false && e.responseHeaders["x-should-retry"] === "false" && /reserved for the Claude Code agents/.test(e.message) && /"build"/.test(e.message),
    );
    // Flag absent (programmatic use) or true → served as usual.
    const r = run(model, opts([user("hola")], { agent: "claude-default", extra: { pairedAgent: true } }));
    const ns = await agent.next("newSession");
    await agent.next("prompt", (e) => e.sessionId === ns.sessionId);
    await agent.chunk(ns.sessionId, "ok");
    agent.endTurn(ns.sessionId, { stopReason: "end_turn" });
    assert.equal(textOf(await r.done), "ok");
  } finally {
    done();
  }
});

test("factory: effort variants share one orchestrator (one agent process)", async () => {
  const { createACPModelProvider } = await import("../dist/provider/factory.js");
  const settings = { command: "claude-agent-acp", claudeExecutable: "/bin/true", claudeCode: { historyMode: "v2" } };
  const plain = createACPModelProvider({ name: "acp", ...settings });
  const high = createACPModelProvider({ name: "acp", ...settings, effort: "high" });
  const low = createACPModelProvider({ name: "acp", ...settings, effort: "low" });
  assert.equal(high.languageModel("haiku").core, plain.languageModel("haiku").core);
  assert.equal(low.languageModel("claude-code"), plain.languageModel("claude-code"));
  // A different agent config is a different agent process.
  const other = createACPModelProvider({ name: "acp", ...settings, claudeCode: { historyMode: "shadow" } });
  assert.notEqual(other.languageModel("haiku").core, plain.languageModel("haiku").core);
});

test("effort: variants switch live on one session; no variant restores the session's own effort", async () => {
  const { agent, model, done } = setup({ agent: { effort: "medium" } });
  const turn = async (prompt, extra, sid) => {
    const r = run(model, opts(prompt, { session: "ses_eff", agent: "claude-default", extra }));
    if (!sid) sid = (await agent.next("newSession")).sessionId;
    await agent.next("prompt", (e) => e.sessionId === sid);
    await agent.chunk(sid, "ok");
    agent.endTurn(sid, { stopReason: "end_turn" });
    await r.done;
    return sid;
  };
  try {
    const sid = await turn([user("uno")], {});
    assert.equal(await agent.none("setConfig"), null, "no variant on a fresh session: nothing to apply");
    await turn([user("uno"), { role: "assistant", content: [{ type: "text", text: "ok" }] }, user("dos")], { effort: "high" }, sid);
    assert.equal((await agent.next("setConfig")).value, "high");
    await turn([user("uno"), { role: "assistant", content: [{ type: "text", text: "ok" }] }, user("dos"), { role: "assistant", content: [{ type: "text", text: "ok" }] }, user("tres")], {}, sid);
    assert.equal((await agent.next("setConfig")).value, "medium");
    assert.equal(await agent.none("newSession"), null);
  } finally {
    done();
  }
});
