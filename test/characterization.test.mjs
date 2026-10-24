// Characterization suite. Two groups:
//  - KEEP: behaviour the provider already gets right and that past fixes established
//    (CHANGELOG 0.8.0, 9299af9). These must stay green through every change.
//  - BUG #n: confirmed defects from the 2026-10-22 review, written as the behaviour we
//    WANT. They start as `todo` and lose the flag in the commit that fixes them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, opts, run, sys, user, asst, call, result, reasoning, TOOLS, textOf, finishOf, callsOf, sleep, decisions } from "./helpers.mjs";

const SYS = sys("You are the build agent.\n<env>\n  Working directory: /proj\n</env>");

/** First turn of a conversation: returns the run, the ACP session id and the prompt event. */
async function first(agent, model, prompt, o) {
  const r = run(model, opts(prompt, o));
  const ns = await agent.next("newSession");
  const p = await agent.next("prompt", (e) => e.sessionId === ns.sessionId);
  return { r, sid: ns.sessionId, p };
}

/** Plain text reply + end of turn. */
async function reply(agent, sid, r, text) {
  await agent.chunk(sid, text);
  agent.endTurn(sid, { stopReason: "end_turn" });
  return r.done;
}

// ---------------------------------------------------------------- KEEP --------

test("KEEP: second turn reuses the ACP session and sends the new user message", async () => {
  const { agent, model, done } = setup();
  try {
    const t1 = await first(agent, model, [SYS, user("hola")], { session: "ses_k1" });
    await reply(agent, t1.sid, t1.r, "R1");
    const r2 = run(model, opts([SYS, user("hola"), asst("R1"), user("dos")], { session: "ses_k1" }));
    const p2 = await agent.next("prompt");
    assert.equal(p2.sessionId, t1.sid);
    assert.match(p2.text, /dos/);
    assert.equal(await agent.none("newSession"), null);
    await reply(agent, t1.sid, r2, "R2");
  } finally { done(); }
});

test("KEEP: switching agent (different system, ocAgent) keeps the session", async () => {
  const { agent, model, done } = setup();
  try {
    const t1 = await first(agent, model, [SYS, user("hola")], { session: "ses_k2" });
    await reply(agent, t1.sid, t1.r, "R1");
    const r2 = run(model, opts([sys("You are the plan agent."), user("hola"), asst("R1"), user("dos")], { session: "ses_k2", agent: "claude-code-plan" }));
    const p2 = await agent.next("prompt");
    assert.equal(p2.sessionId, t1.sid);
    await reply(agent, t1.sid, r2, "R2");
  } finally { done(); }
});

test("KEEP: a changed tool set is applied in place (tools/list_changed), no new session", async () => {
  const { agent, model, done } = setup();
  try {
    const t1 = await first(agent, model, [SYS, user("hola")], { session: "ses_k3" });
    await reply(agent, t1.sid, t1.r, "R1");
    const r2 = run(model, opts([SYS, user("hola"), asst("R1"), user("dos")], { session: "ses_k3", tools: TOOLS.slice(0, 1) }));
    const p2 = await agent.next("prompt");
    assert.equal(p2.sessionId, t1.sid);
    const n = await agent.next("mcp-notification");
    assert.equal(n.method, "notifications/tools/list_changed");
    await reply(agent, t1.sid, r2, "R2");
  } finally { done(); }
});

test("KEEP: a tool-less call (title/summary) gets its own session and does not evict the conversation", async () => {
  const { agent, model, done } = setup();
  try {
    const t1 = await first(agent, model, [SYS, user("hola")], { session: "ses_k4" });
    await reply(agent, t1.sid, t1.r, "R1");
    const rt = run(model, opts([sys("Generate a title"), user("hola")], { session: "ses_k4", tools: [] }));
    const ns = await agent.next("newSession");
    assert.notEqual(ns.sessionId, t1.sid);
    await agent.next("prompt", (e) => e.sessionId === ns.sessionId);
    await reply(agent, ns.sessionId, rt, "Saludo");
    const r2 = run(model, opts([SYS, user("hola"), asst("R1"), user("dos")], { session: "ses_k4" }));
    const p2 = await agent.next("prompt");
    assert.equal(p2.sessionId, t1.sid);
    await reply(agent, t1.sid, r2, "R2");
  } finally { done(); }
});

test("KEEP: two conversations stay isolated", async () => {
  const { agent, model, done } = setup();
  try {
    const a = await first(agent, model, [SYS, user("chat A")], { session: "ses_a" });
    const b = await first(agent, model, [SYS, user("chat B")], { session: "ses_b" });
    assert.notEqual(a.sid, b.sid);
    await reply(agent, a.sid, a.r, "RA");
    await reply(agent, b.sid, b.r, "RB");
  } finally { done(); }
});

test("KEEP: a deferred tool-call resolves through the continuation and is not replayed later", async () => {
  const { agent, model, done } = setup();
  try {
    const hist = [SYS, user("lee el fichero")];
    const t1 = await first(agent, model, hist, { session: "ses_k6" });
    const tool = agent.callTool(t1.sid, "read", { path: "a.txt" });
    const parts1 = await t1.r.done;
    const [c] = callsOf(parts1);
    assert.equal(c.toolName, "read");
    assert.equal(finishOf(parts1).finishReason.unified, "tool-calls");
    const cont = [...hist, asst(call(c.toolCallId, "read", { path: "a.txt" })), result(c.toolCallId, "read", "CONTENIDO-SECRETO")];
    const r2 = run(model, opts(cont, { session: "ses_k6" }));
    const res = await tool;
    assert.equal(res.content[0].text, "CONTENIDO-SECRETO");
    await reply(agent, t1.sid, r2, "Leído");
    const r3 = run(model, opts([...cont, asst("Leído"), user("y ahora?")], { session: "ses_k6" }));
    const p3 = await agent.next("prompt", (e) => /y ahora/.test(e.text));
    assert.doesNotMatch(p3.text, /CONTENIDO-SECRETO|\[Called tool/);
    await reply(agent, t1.sid, r3, "ok");
  } finally { done(); }
});

test("KEEP: a diverged history (revert/compaction) starts a fresh session with the history", async () => {
  const { agent, model, done } = setup();
  try {
    const t1 = await first(agent, model, [SYS, user("uno")], { session: "ses_k7" });
    await reply(agent, t1.sid, t1.r, "R1");
    const r2 = run(model, opts([SYS, user("uno"), asst("R1"), user("dos")], { session: "ses_k7" }));
    await agent.next("prompt");
    await reply(agent, t1.sid, r2, "R2");
    // revert turn 2 and ask something else
    const r3 = run(model, opts([SYS, user("uno"), asst("R1"), user("tres")], { session: "ses_k7" }));
    const ns = await agent.next("newSession");
    assert.notEqual(ns.sessionId, t1.sid);
    const p3 = await agent.next("prompt", (e) => e.sessionId === ns.sessionId);
    assert.match(p3.text, /uno/);
    assert.match(p3.text, /tres/);
    assert.doesNotMatch(p3.text, /dos/);
    await reply(agent, ns.sessionId, r3, "R3");
  } finally { done(); }
});

test("KEEP: an identical prompt (retry) is not mistaken for a revert", async () => {
  const { agent, model, done } = setup();
  try {
    const t1 = await first(agent, model, [SYS, user("hola")], { session: "ses_k8" });
    await reply(agent, t1.sid, t1.r, "R1");
    const r2 = run(model, opts([SYS, user("hola")], { session: "ses_k8" }));
    const p2 = await agent.next("prompt");
    assert.equal(p2.sessionId, t1.sid);
    assert.equal(await agent.none("newSession"), null);
    await reply(agent, t1.sid, r2, "R1bis");
  } finally { done(); }
});

test("KEEP: text that arrives while the stream is closed for a tool-call is flushed, in order", async () => {
  const { agent, model, done } = setup();
  try {
    const hist = [SYS, user("go")];
    const t1 = await first(agent, model, hist, { session: "ses_k9" });
    await agent.chunk(t1.sid, "antes ");
    const tool = agent.callTool(t1.sid, "read", {});
    const parts1 = await t1.r.done;
    const [c] = callsOf(parts1);
    await agent.chunk(t1.sid, "durante ");
    await sleep(30);
    const r2 = run(model, opts([...hist, asst("antes ", call(c.toolCallId, "read")), result(c.toolCallId, "read", "x")], { session: "ses_k9" }));
    await tool;
    await reply(agent, t1.sid, r2, "después");
    assert.equal(textOf(r2.parts), "durante después");
  } finally { done(); }
});

test("KEEP: turns run by another model in between reach the agent on return", async () => {
  const { agent, model, done } = setup();
  try {
    const t1 = await first(agent, model, [SYS, user("uno")], { session: "ses_k10" });
    await reply(agent, t1.sid, t1.r, "R1");
    const foreign = [
      SYS, user("uno"), asst("R1"),
      user("pregunta a GPT"), asst("respuesta de GPT", call("call_gpt_1", "bash", { command: "ls" })), result("call_gpt_1", "bash", "a b c"),
      asst("listado hecho"), user("vuelvo a Claude"),
    ];
    const r2 = run(model, opts(foreign, { session: "ses_k10" }));
    const p2 = await agent.next("prompt");
    assert.equal(p2.sessionId, t1.sid);
    assert.match(p2.text, /pregunta a GPT/);
    assert.match(p2.text, /respuesta de GPT/);
    assert.match(p2.text, /bash/);
    assert.match(p2.text, /vuelvo a Claude/);
    await reply(agent, t1.sid, r2, "R2");
  } finally { done(); }
});

test("KEEP: a plan exit made by the agent sticks; reselecting plan re-applies it", async () => {
  const { agent, model, done } = setup();
  try {
    const plan = { session: "ses_k11", agent: "claude-code-plan", extra: { mode: "plan" } };
    const t1 = await first(agent, model, [SYS, user("planea")], plan);
    await agent.next("setMode", (e) => e.modeId === "plan");
    await agent.modeUpdate(t1.sid, "default"); // ExitPlanMode approved
    await reply(agent, t1.sid, t1.r, "plan aprobado");
    const h2 = [SYS, user("planea"), asst("plan aprobado"), user("implementa")];
    const r2 = run(model, opts(h2, plan));
    await agent.next("prompt");
    assert.equal(await agent.none("setMode"), null);
    await reply(agent, t1.sid, r2, "hecho");
    const r3 = run(model, opts([...h2, asst("hecho"), user("otro")], { ...plan, agent: "claude-code", extra: { mode: "default" } }));
    await agent.next("prompt");
    await reply(agent, t1.sid, r3, "ok");
    const r4 = run(model, opts([...h2, asst("hecho"), user("otro"), asst("ok"), user("planea más")], plan));
    const sm = await agent.next("setMode");
    assert.equal(sm.modeId, "plan");
    await agent.next("prompt");
    await reply(agent, t1.sid, r4, "ok");
  } finally { done(); }
});

test("KEEP: a native permission becomes a `question` call; 'Allow once' approves", async () => {
  const { agent, model, done } = setup();
  try {
    const hist = [SYS, user("lee /etc/x")];
    const t1 = await first(agent, model, hist, { session: "ses_k12" });
    const options = [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ];
    const perm = agent.requestPermission(t1.sid, { toolCallId: "tu_1", title: "Read /etc/x", kind: "read", rawInput: { file_path: "/etc/x" } }, options);
    const parts1 = await t1.r.done;
    const [q] = callsOf(parts1);
    assert.equal(q.toolName, "question");
    const cont = [...hist, asst(call(q.toolCallId, "question", JSON.parse(q.input))), result(q.toolCallId, "question", { answers: [["Allow once"]] }, "json")];
    const r2 = run(model, opts(cont, { session: "ses_k12" }));
    const outcome = await perm;
    assert.deepEqual(outcome.outcome, { outcome: "selected", optionId: "allow" });
    await reply(agent, t1.sid, r2, "leído");
  } finally { done(); }
});

// ---------------------------------------------------------------- BUGS --------

test("BUG #1: the agent's own previous reply is not sent back to it", async () => {
  const { agent, model, done } = setup();
  try {
    const t1 = await first(agent, model, [SYS, user("hola")], { session: "ses_b1" });
    await reply(agent, t1.sid, t1.r, "RESPUESTA-PROPIA");
    const r2 = run(model, opts([SYS, user("hola"), asst("RESPUESTA-PROPIA"), user("dos")], { session: "ses_b1" }));
    const p2 = await agent.next("prompt");
    assert.doesNotMatch(p2.text, /RESPUESTA-PROPIA/);
    await reply(agent, t1.sid, r2, "R2");
  } finally { done(); }
});

test("BUG #2: a message steered in while a tool runs reaches the agent", async () => {
  const { agent, model, done } = setup();
  try {
    const hist = [SYS, user("tarea larga")];
    const t1 = await first(agent, model, hist, { session: "ses_b2" });
    const tool = agent.callTool(t1.sid, "bash", { command: "make" });
    const [c] = callsOf(await t1.r.done);
    const cont = [...hist, asst(call(c.toolCallId, "bash")), result(c.toolCallId, "bash", "ok"), user("MENSAJE-STEER: usa la rama dev")];
    const r2 = run(model, opts(cont, { session: "ses_b2" }));
    await tool;
    const p = await agent.next("prompt", (e) => /MENSAJE-STEER/.test(e.text), 1000);
    assert.ok(p);
    agent.endTurn(t1.sid);
    await reply(agent, t1.sid, r2, "R");
  } finally { done(); }
});

test("BUG #2 (agent without prompt queueing): the steered message rides on the tool result", async () => {
  const { agent, model, done } = setup({ agent: { promptQueueing: false } });
  try {
    const hist = [SYS, user("tarea larga")];
    const t1 = await first(agent, model, hist, { session: "ses_b2b" });
    const tool = agent.callTool(t1.sid, "bash", { command: "make" });
    const [c] = callsOf(await t1.r.done);
    const cont = [...hist, asst(call(c.toolCallId, "bash")), result(c.toolCallId, "bash", "ok"), user("MENSAJE-STEER-2")];
    const r2 = run(model, opts(cont, { session: "ses_b2b" }));
    const res = await tool;
    const texts = res.content.map((x) => x.text).join("\n");
    assert.match(texts, /^ok/);
    assert.match(texts, /<user_message_during_turn>\nMENSAJE-STEER-2/);
    assert.equal(await agent.none("prompt"), null);
    await reply(agent, t1.sid, r2, "R");
  } finally { done(); }
});

test("BUG #3: after an abort with a pending tool, the new user message reaches the agent", async () => {
  const { agent, model, done } = setup();
  try {
    const hist = [SYS, user("tarea")];
    const t1 = await first(agent, model, hist, { session: "ses_b3" });
    agent.callTool(t1.sid, "bash", { command: "sleep 100" }).catch(() => {});
    const [c] = callsOf(await t1.r.done);
    // the exact shape V2 sends (see fixtures/v2/session-mixed.jsonl)
    const aborted = JSON.stringify({ error: { type: "aborted", message: "Tool execution interrupted" }, content: [] });
    const next = [...hist, asst(call(c.toolCallId, "bash")), result(c.toolCallId, "bash", aborted), user("NUEVO-MENSAJE")];
    const r2 = run(model, opts(next, { session: "ses_b3" }));
    const p = await agent.next("prompt", (e) => /NUEVO-MENSAJE/.test(e.text), 1000);
    assert.ok(agent.log.some((e) => e.type === "cancel"), "the interrupted turn is cancelled agent-side");
    assert.doesNotMatch(p.text, /aborted|interrupted/);
    await reply(agent, p.sessionId, r2, "R");
  } finally { done(); }
});

test("BUG #6: parallel read-only calls reach OpenCode in ONE step and both resolve", async () => {
  const { agent, model, done } = setup();
  try {
    const hist = [SYS, user("investiga en paralelo")];
    const t1 = await first(agent, model, hist, { session: "ses_b6" });
    const listed = await agent.listTools(t1.sid);
    assert.equal(listed.tools.find((x) => x.name === "read").annotations?.readOnlyHint, true);
    assert.equal(listed.tools.find((x) => x.name === "bash").annotations, undefined);
    const a = agent.callTool(t1.sid, "read", { path: "a" });
    const b = agent.callTool(t1.sid, "read", { path: "b" });
    const calls = callsOf(await t1.r.done);
    assert.equal(calls.length, 2, "one step carries both calls");
    const h = [...hist, asst(...calls.map((c) => call(c.toolCallId, "read"))), ...calls.map((c) => result(c.toolCallId, "read", `R-${c.toolCallId}`))];
    const r2 = run(model, opts(h, { session: "ses_b6" }));
    const [ra, rb] = await Promise.all([a, b]);
    assert.match(ra.content[0].text, /^R-/);
    assert.match(rb.content[0].text, /^R-/);
    await reply(agent, t1.sid, r2, "hecho");
  } finally { done(); }
});

test("BUG #6/#25: a call or permission arriving while OpenCode runs a step is queued, not lost", async () => {
  const { agent, model, done } = setup();
  try {
    const hist = [SYS, user("dos subagentes")];
    const t1 = await first(agent, model, hist, { session: "ses_b6b" });
    const a = agent.callTool(t1.sid, "bash", { command: "uno" }); // serial: closes the step at once
    const [ca] = callsOf(await t1.r.done);
    // meanwhile a second subagent calls a tool and a third asks a native permission
    const b = agent.callTool(t1.sid, "bash", { command: "dos" });
    const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }];
    const perm = agent.requestPermission(t1.sid, { toolCallId: "tu_p", title: "Read /x", kind: "read", rawInput: { file_path: "/x" } }, options);
    await sleep(50);
    const h2 = [...hist, asst(call(ca.toolCallId, "bash")), result(ca.toolCallId, "bash", "R1")];
    const r2 = run(model, opts(h2, { session: "ses_b6b" }));
    assert.match((await a).content[0].text, /R1/);
    const queued = callsOf(await r2.done);
    assert.deepEqual(queued.map((c) => c.toolName).sort(), ["bash", "question"]);
    const qb = queued.find((c) => c.toolName === "bash");
    const qq = queued.find((c) => c.toolName === "question");
    const h3 = [...h2, asst(call(qb.toolCallId, "bash"), call(qq.toolCallId, "question")), result(qb.toolCallId, "bash", "R2"), result(qq.toolCallId, "question", { answers: [["Allow once"]] }, "json")];
    const r3 = run(model, opts(h3, { session: "ses_b6b" }));
    assert.match((await b).content[0].text, /R2/);
    assert.deepEqual((await perm).outcome, { outcome: "selected", optionId: "allow" });
    await reply(agent, t1.sid, r3, "hecho");
  } finally { done(); }
});

test("BUG #7: a stale prompt completion does not close the next turn's stream", async () => {
  const { agent, model, done } = setup({ agent: { cancelDelayMs: 150 } });
  try {
    const { stream } = await model.doStream(opts([SYS, user("uno")], { session: "ses_b7" }));
    const reader = stream.getReader();
    const ns = await agent.next("newSession");
    await agent.next("prompt");
    await reader.cancel(); // user aborts turn 1; its prompt resolves 150 ms later
    await agent.next("cancel");
    const r2 = run(model, opts([SYS, user("uno"), user("dos")], { session: "ses_b7" }));
    await agent.next("prompt", (e) => /dos/.test(e.text));
    await sleep(250); // the stale `cancelled` completion of turn 1 lands here
    await agent.chunk(ns.sessionId, "R2");
    agent.endTurn(ns.sessionId);
    const parts = await r2.done;
    assert.equal(textOf(parts), "R2");
  } finally { done(); }
});

test("BUG #10: a stale `perm_N` answer from an earlier process never approves a new request", async () => {
  const { agent, model, done } = setup();
  try {
    // history from a previous process: perm_1 was answered "Always allow"
    const old = [
      SYS, user("antes"), asst(call("perm_1", "question", { questions: [] })),
      result("perm_1", "question", { answers: [["Always allow"]] }, "json"), asst("hecho"), user("lee otra cosa"),
    ];
    const t1 = await first(agent, model, old, { session: "ses_b10" });
    const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }];
    const perm = agent.requestPermission(t1.sid, { toolCallId: "tu_9", title: "Read /secret", kind: "read", rawInput: { file_path: "/secret" } }, options);
    const [q] = callsOf(await t1.r.done);
    const cont = [...old, asst(call(q.toolCallId, "question", {})), result(q.toolCallId, "question", { answers: [["Deny"]] }, "json")];
    const r2 = run(model, opts(cont, { session: "ses_b10" }));
    const outcome = await perm;
    assert.deepEqual(outcome.outcome, { outcome: "selected", optionId: "reject" });
    await reply(agent, t1.sid, r2, "ok");
  } finally { done(); }
});

// ---------------------------------------------------------------- FORMAT ------

test("FORMAT: another model's turn reaches the agent labelled as such, not as its own", async () => {
  const { agent, model, done } = setup();
  try {
    const t1 = await first(agent, model, [SYS, user("uno")], { session: "ses_f1" });
    await reply(agent, t1.sid, t1.r, "R1");
    const h = [SYS, user("uno"), asst("R1"), user("lista"), asst(call("call-gpt", "shell", { command: "ls" })), result("call-gpt", "shell", "a.txt"), asst("hay a.txt"), user("¿quién listó?")];
    const r2 = run(model, opts(h, { session: "ses_f1" }));
    const p = await agent.next("prompt");
    assert.doesNotMatch(p.text, /Assistant:|R1/);
    assert.match(p.text, /<other_model_turn>[\s\S]*<tool_call name="shell">[\s\S]*<tool_result name="shell">a\.txt<\/tool_result>[\s\S]*hay a\.txt[\s\S]*<\/other_model_turn>/);
    assert.match(p.text, /lista[\s\S]*<other_model_turn>[\s\S]*¿quién listó\?$/);
    await reply(agent, t1.sid, r2, "otro modelo");
  } finally { done(); }
});

test("FORMAT: a full replay is a bounded <conversation_history> followed by the current request", async () => {
  const { agent, model, done } = setup();
  try {
    const big = "x".repeat(150_000);
    const h = [SYS, user("TAREA-INICIAL"), asst(`A1 ${big}`), user("m2"), asst(`A2 ${big}`), user("m3"), asst(`A3 ${big}`), user("PETICION-ACTUAL")];
    const r = run(model, opts(h, { session: "ses_f2" }));
    const ns = await agent.next("newSession");
    const p = await agent.next("prompt");
    assert.match(p.text, /^<opencode_context>|^<conversation_history>/);
    assert.match(p.text, /<conversation_history>[\s\S]*TAREA-INICIAL[\s\S]*<omitted messages="\d+"[\s\S]*<\/conversation_history>\nPETICION-ACTUAL$/);
    assert.ok(p.text.length < 450_000, `replay bounded (${p.text.length})`);
    await reply(agent, ns.sessionId, r, "ok");
  } finally { done(); }
});

// ------------------------------------------------- HISTORY MODE (anchors) -----
// V2 re-renders OLD messages in ways that don't change the conversation. Under the
// legacy keys each one forced a new session + cold replay; anchors must keep the session.

const v2 = { claudeCode: { historyMode: "v2" } };

/** Turns 1-2 as V2 first renders them; turn 3 re-renders turn 1's answer. Only an
 *  answer that already travelled in a prompt (turn 2) is part of what the agent knows,
 *  so that's where a re-render can look like a divergence. */
async function rerender(conf, session, rerendered) {
  const { agent, model, done } = setup(conf);
  try {
    const t1 = await first(agent, model, [SYS, user("hola")], { session });
    await agent.thought(t1.sid, "pienso");
    await reply(agent, t1.sid, t1.r, "R1");
    const orig = [user("hola"), asst(reasoning("pienso"), "R1")];
    const r2 = run(model, opts([SYS, ...orig, user("dos")], { session }));
    await agent.next("prompt", (e) => /dos/.test(e.text));
    await reply(agent, t1.sid, r2, "R2");
    const r3 = run(model, opts([SYS, ...rerendered, user("dos"), asst("R2"), user("tres")], { session }));
    const p3 = await agent.next("prompt", (e) => /tres/.test(e.text));
    const fresh = agent.log.filter((e) => e.type === "newSession").length > 1;
    await reply(agent, p3.sessionId, r3, "R3");
    return { fresh, p2: p3 };
  } finally { done(); }
}

test("V2: reasoning turned into text (errored message) does not reset the session", async () => {
  const { fresh, p2 } = await rerender(v2, "ses_h1", [user("hola"), asst("pienso", "R1")]);
  assert.equal(fresh, false);
  assert.doesNotMatch(p2.text, /R1|R2|pienso/);
});

test("V2: reasoning dropped after a model switch does not reset the session", async () => {
  const { fresh } = await rerender(v2, "ses_h2", [user("hola"), asst("R1")]);
  assert.equal(fresh, false);
});

test("V2: tags injected by DCP into an old message do not reset the session", async () => {
  const { fresh, p2 } = await rerender(v2, "ses_h3", [
    user("hola\n<dcp-message-id>m0001</dcp-message-id>"), asst(reasoning("pienso"), "R1\n<dcp-message-id>m0002</dcp-message-id>"),
  ]);
  assert.equal(fresh, false);
  assert.doesNotMatch(p2.text, /dcp-message-id/);
});

test("V2: a transient plan reminder is forwarded once and does not reset the session", async () => {
  const { agent, model, done } = setup(v2);
  try {
    const REM = "<system-reminder>Plan mode is active.</system-reminder>";
    const t1 = await first(agent, model, [SYS, user("hola")], { session: "ses_h4" });
    await reply(agent, t1.sid, t1.r, "R1");
    // request 2: V2 inserts the reminder (transient) right before the new user message
    const r2 = run(model, opts([SYS, user("hola"), asst("R1"), user(REM), user("dos")], { session: "ses_h4" }));
    const p2 = await agent.next("prompt");
    assert.match(p2.text, /Plan mode is active[\s\S]*dos/);
    await reply(agent, t1.sid, r2, "R2");
    // request 3: the transient copy is gone; the persisted one lands after turn 2
    const r3 = run(model, opts([SYS, user("hola"), asst("R1"), user("dos"), asst("R2"), user(REM), user("tres")], { session: "ses_h4" }));
    const p3 = await agent.next("prompt");
    assert.equal(p3.sessionId, t1.sid);
    assert.doesNotMatch(p3.text, /Plan mode is active/);
    assert.match(p3.text, /tres/);
    await reply(agent, t1.sid, r3, "R3");
  } finally { done(); }
});

test("SHADOW (default): legacy decides, the disagreement is recorded", async () => {
  const { fresh } = await rerender({}, "ses_h5", [user("hola"), asst("pienso", "R1")]);
  assert.equal(fresh, true, "legacy still resets in shadow mode");
  const d = (await decisions("ses_h5")).find((e) => e.decision === "shadow-diff");
  assert.ok(d, "shadow-diff recorded");
  assert.match(d.legacy, /^diverged/);
  assert.match(d.anchors, /^append/);
});

test("CONTEXT: the Code Mode catalog in the system prompt reaches the agent once", async () => {
  const { agent, model, done } = setup();
  try {
    const sysCM = sys("You are build.\n<env>\n  Working directory: /proj\n</env>\n# Code Mode\n\nUse the `execute` tool.\n\n## Available tools\n- tools.x.y()\n# Other\nnot this");
    const t1 = await first(agent, model, [sysCM, user("hola")], { session: "ses_c1" });
    assert.match(t1.p.text, /<code_mode_catalog>\n# Code Mode[\s\S]*tools\.x\.y\(\)\n<\/code_mode_catalog>/);
    assert.doesNotMatch(t1.p.text, /not this/);
    await reply(agent, t1.sid, t1.r, "R1");
    const r2 = run(model, opts([sysCM, user("hola"), asst("R1"), user("dos")], { session: "ses_c1" }));
    const p2 = await agent.next("prompt");
    assert.doesNotMatch(p2.text, /Code Mode/);
    await reply(agent, t1.sid, r2, "R2");
  } finally { done(); }
});

test("RESUME: after a restart the agent's own output and tool traffic are not replayed", async () => {
  const { agent, model, done } = setup();
  try {
    const PREFIX = "acp_deadbeef00_";
    const h = [
      SYS, user("lee a"), asst(call(`${PREFIX}1`, "read")), result(`${PREFIX}1`, "read", "CONTENIDO-A"),
      asst("RESPUESTA-PROPIA"), user("y ahora b"),
    ];
    // registry: the process died right after sending "lee a" (resumeLen = 1)
    const r = run(model, opts(h, { session: "ses_r1", extra: { resumeId: "s-old", resumeLen: 1, resumeIdPrefixes: [PREFIX] } }));
    const rs = await agent.next("resumeSession");
    assert.equal(rs.sessionId, "s-old");
    const p = await agent.next("prompt");
    assert.doesNotMatch(p.text, /CONTENIDO-A|RESPUESTA-PROPIA|tool_call/);
    assert.match(p.text, /y ahora b/);
    await reply(agent, "s-old", r, "ok");
  } finally { done(); }
});

test("RESUME: a registry entry for another conversation is not resumed", async () => {
  const { agent, model, done } = setup();
  try {
    const r = run(model, opts([SYS, user("conversación nueva")], { session: "ses_r2", extra: { resumeId: "s-other", resumeLen: 1, resumeConvKey: "zzz" } }));
    const ns = await agent.next("newSession");
    assert.equal(agent.log.some((e) => e.type === "resumeSession"), false);
    await agent.next("prompt");
    await reply(agent, ns.sessionId, r, "ok");
  } finally { done(); }
});

test("BUG #8: two calls racing on one conversation never create an orphan session", async () => {
  const { agent, model, done } = setup();
  try {
    // programmatic use (no OpenCode sessionID): the title call and the first turn share
    // the conversation key and arrive together
    const main = { prompt: [SYS, user("hola")], tools: TOOLS, providerOptions: {} };
    const title = { prompt: [sys("Generate a title"), user("hola")], tools: [], providerOptions: {} };
    const rm = run(model, main);
    const rt = run(model, title);
    const s1 = await agent.next("newSession");
    const s2 = await agent.next("newSession");
    assert.notEqual(s1.sessionId, s2.sessionId);
    for (const sid of [s1.sessionId, s2.sessionId]) { await agent.next("prompt", (e) => e.sessionId === sid); }
    for (const sid of [s1.sessionId, s2.sessionId]) { await agent.chunk(sid, "x"); agent.endTurn(sid); }
    await Promise.all([rm.done, rt.done]);
    await sleep(30);
    // no orphan: every session still open agent-side is tracked by the provider
    // (the one-shot tool-less session is closed once answered)
    const tracked = new Set([...model["sessions"].values()].map((x) => x.sessionId));
    assert.deepEqual([...agent.sessions.keys()].filter((id) => !tracked.has(id)), []);
    assert.equal(model["sessions"].size, 1);
    // the conversation keeps its tool-enabled session
    const r2 = run(model, { prompt: [SYS, user("hola"), asst("x"), user("dos")], tools: TOOLS, providerOptions: {} });
    const p2 = await agent.next("prompt", (e) => /dos/.test(e.text));
    const mainSid = model["sessions"].get([...model["sessions"].keys()].find((k) => !k.endsWith(":notools"))).sessionId;
    assert.equal(p2.sessionId, mainSid);
    await reply(agent, mainSid, r2, "ok");
  } finally { done(); }
});

test("MCP: a queued call the agent cancels is never sent to OpenCode", async () => {
  const { agent, model, done } = setup();
  try {
    const hist = [SYS, user("go")];
    const t1 = await first(agent, model, hist, { session: "ses_m1" });
    const a = agent.callTool(t1.sid, "bash", { command: "uno" });
    const [ca] = callsOf(await t1.r.done);
    agent.callTool(t1.sid, "bash", { command: "cancelada" }).catch(() => {}); // queued (stream closed)
    const reqId = agent.lastRequestId(t1.sid);
    await sleep(30);
    agent.cancelCall(t1.sid, reqId);
    await sleep(30);
    const r2 = run(model, opts([...hist, asst(call(ca.toolCallId, "bash")), result(ca.toolCallId, "bash", "R1")], { session: "ses_m1" }));
    await a;
    await reply(agent, t1.sid, r2, "fin");
    assert.equal(callsOf(r2.parts).length, 0, "the cancelled call was dropped");
    assert.equal(textOf(r2.parts), "fin");
  } finally { done(); }
});

// ------------------------------------------------- AGENTS & SUBAGENTS ---------

const PLAN_OPTIONS = [
  { kind: "allow_always", name: 'Yes, and use "auto" mode', optionId: "auto" },
  { kind: "allow_always", name: "Yes, and auto-accept edits", optionId: "acceptEdits" },
  { kind: "allow_once", name: "Yes, and manually approve edits", optionId: "default" },
  { kind: "reject_once", name: "No, keep planning", optionId: "plan" },
];

test("#19: every agent auto-allows OpenCode's tools; one without `question` gets a denial, not a dead dialog", async () => {
  const { agent, model, done } = setup();
  try {
    const sub = { session: "ses_g1", agent: "general", extra: { hasQuestion: false } };
    const t1 = await first(agent, model, [SYS, user("investiga")], sub);
    const ns = agent.log.find((e) => e.type === "newSession");
    assert.deepEqual(ns.meta.claudeCode.options.allowedTools, ["mcp__opencode"]);
    const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }];
    const outcome = await agent.requestPermission(t1.sid, { toolCallId: "tu", title: "Read /x", kind: "read", rawInput: { file_path: "/x" } }, options);
    assert.deepEqual(outcome.outcome, { outcome: "selected", optionId: "reject" });
    await reply(agent, t1.sid, t1.r, "sin permiso");
    assert.equal(callsOf(t1.r.parts).length, 0, "no question emitted");
  } finally { done(); }
});

test("#21: switching to an agent with another native profile forks the session (context kept, no replay)", async () => {
  const { agent, model, done } = setup();
  try {
    const t1 = await first(agent, model, [SYS, user("uno")], { session: "ses_g2" });
    await reply(agent, t1.sid, t1.r, "R1");
    const r2 = run(model, opts([SYS, user("uno"), asst("R1"), user("revisa")], { session: "ses_g2", agent: "reviewer", extra: { nativeTools: [], disallowedTools: ["Write"] } }));
    const fk = await agent.next("forked");
    assert.equal(fk.from, t1.sid);
    const p2 = await agent.next("prompt");
    assert.equal(p2.sessionId, fk.sessionId);
    assert.equal(p2.text.trim(), "revisa");
    assert.equal(agent.log.filter((e) => e.type === "newSession").length, 1);
    assert.ok(agent.log.some((e) => e.type === "ext" && e.method === "session/close" && e.params.sessionId === t1.sid));
    await reply(agent, fk.sessionId, r2, "ok");
  } finally { done(); }
});

test("#22: ExitPlanMode offers the agent's own choices; the picked one is honoured", async () => {
  const { agent, model, done } = setup();
  try {
    const plan = { session: "ses_g3", agent: "claude-code-plan", extra: { mode: "plan" } };
    const hist = [SYS, user("planea")];
    const t1 = await first(agent, model, hist, plan);
    const perm = agent.requestPermission(t1.sid, { toolCallId: "tu_x", kind: "switch_mode", title: "Ready to code?", rawInput: { plan: "1. hacer A\n2. hacer B" } }, PLAN_OPTIONS);
    const parts = await t1.r.done;
    assert.match(textOf(parts), /1\. hacer A/);
    const [q] = callsOf(parts);
    const labels = JSON.parse(q.input).questions[0].options.map((o) => o.label);
    assert.deepEqual(labels, PLAN_OPTIONS.map((o) => o.name));
    const cont = [...hist, asst(call(q.toolCallId, "question", {})), result(q.toolCallId, "question", { answers: [["Yes, and auto-accept edits"]] }, "json")];
    const r2 = run(model, opts(cont, plan));
    assert.deepEqual((await perm).outcome, { outcome: "selected", optionId: "acceptEdits" });
    await reply(agent, t1.sid, r2, "implementando");
  } finally { done(); }
});

test("#22: a typed answer keeps planning and reaches the agent as feedback", async () => {
  const { agent, model, done } = setup();
  try {
    const plan = { session: "ses_g4", agent: "claude-code-plan", extra: { mode: "plan" } };
    const hist = [SYS, user("planea")];
    const t1 = await first(agent, model, hist, plan);
    const perm = agent.requestPermission(t1.sid, { toolCallId: "tu_y", kind: "switch_mode", title: "Ready?", rawInput: { plan: "plan v1" } }, PLAN_OPTIONS);
    const [q] = callsOf(await t1.r.done);
    const cont = [...hist, asst(call(q.toolCallId, "question", {})), result(q.toolCallId, "question", { answers: [["usa Postgres en vez de SQLite"]] }, "json")];
    const r2 = run(model, opts(cont, plan));
    assert.deepEqual((await perm).outcome, { outcome: "selected", optionId: "plan" });
    const p = await agent.next("prompt", (e) => /usa Postgres/.test(e.text));
    assert.match(p.text, /keep planning/);
    await reply(agent, t1.sid, r2, "plan v2");
  } finally { done(); }
});

test("#23: leaving the plan agent after approving with acceptEdits keeps acceptEdits", async () => {
  const { agent, model, done } = setup();
  try {
    const plan = { session: "ses_g5", agent: "claude-code-plan", extra: { mode: "plan" } };
    const t1 = await first(agent, model, [SYS, user("planea")], plan);
    await agent.modeUpdate(t1.sid, "acceptEdits"); // ExitPlanMode approved with acceptEdits
    await reply(agent, t1.sid, t1.r, "aprobado");
    const r2 = run(model, opts([SYS, user("planea"), asst("aprobado"), user("sigue")], { session: "ses_g5", agent: "claude-code", extra: { mode: "default" } }));
    await agent.next("prompt", (e) => /sigue/.test(e.text));
    assert.equal(agent.log.filter((e) => e.type === "setMode" && e.modeId === "default").length, 0);
    await reply(agent, t1.sid, r2, "ok");
  } finally { done(); }
});

test("2c: a usage-limit failure becomes a clear, non-retryable error", async () => {
  const { limitError } = await import("../dist/provider/model.js");
  const e = limitError(new Error("Claude AI usage limit reached|1792700000"));
  assert.match(e.message, /usage limit reached.*Switch to another model/);
  // OpenCode >= 2.1 retries unclassified errors; 402 + x-should-retry:false → QuotaExceeded, no retry.
  const { APICallError } = await import("@ai-sdk/provider");
  assert.ok(APICallError.isInstance(e));
  assert.equal(e.statusCode, 402);
  assert.equal(e.isRetryable, false);
  assert.equal(e.responseHeaders["x-should-retry"], "false");
  assert.doesNotMatch(e.message, /try again|retry|overloaded|exhausted|unavailable/i);
  assert.equal(limitError(new Error("Overloaded")), undefined);
});

test("2c: a limit reported as an ACP error kind is recognised too", async () => {
  const { limitError } = await import("../dist/provider/model.js");
  const err = Object.assign(new Error("Internal error"), { data: { errorKind: "rate_limit" } });
  assert.ok(limitError(err));
});

// ------------------------------------------------- RESOURCES ------------------

test("#13: switching opus ↔ sonnet keeps the session (set_model), no second agent", async () => {
  const { ACPModelView } = await import("./helpers.mjs");
  const { agent, model: core, done } = setup();
  try {
    const sonnet = new ACPModelView(core, "sonnet");
    const opus = new ACPModelView(core, "opus");
    const t1 = await first(agent, sonnet, [SYS, user("uno")], { session: "ses_m13" });
    assert.equal((await agent.next("setModel")).modelId, "sonnet");
    await reply(agent, t1.sid, t1.r, "R1");
    const r2 = run(opus, opts([SYS, user("uno"), asst("R1"), user("dos")], { session: "ses_m13" }));
    const sm = await agent.next("setModel");
    assert.equal(sm.modelId, "opus");
    assert.equal(sm.sessionId, t1.sid);
    const p2 = await agent.next("prompt", (e) => /dos/.test(e.text));
    assert.equal(p2.sessionId, t1.sid);
    assert.equal(agent.log.filter((e) => e.type === "newSession").length, 1);
    await reply(agent, t1.sid, r2, "R2");
  } finally { done(); }
});

test("#14: an idle resumable session is closed agent-side after its TTL", async () => {
  const { agent, model, done } = setup({ claudeCode: { idleSessionTtlMs: 80, childSessionTtlMs: 80 } });
  try {
    const t1 = await first(agent, model, [SYS, user("hola")], { session: "ses_ttl" });
    await reply(agent, t1.sid, t1.r, "R1");
    const closed = await agent.next("ext", (e) => e.method === "session/close" && e.params.sessionId === t1.sid, 2000);
    assert.ok(closed);
    assert.equal(model["sessions"].size, 0);
  } finally { done(); }
});

test("#16: reported usage is the live context size, not the turn's sum of requests", async () => {
  const { agent, model, done } = setup();
  try {
    const hist = [SYS, user("go")];
    const t1 = await first(agent, model, hist, { session: "ses_u1" });
    await agent.usage(t1.sid, 40_000);
    const tool = agent.callTool(t1.sid, "bash", { command: "x" });
    const parts1 = await t1.r.done;
    assert.equal(finishOf(parts1).usage.inputTokens.total, 40_000, "tool-call steps report usage too");
    const [c] = callsOf(parts1);
    const r2 = run(model, opts([...hist, asst(call(c.toolCallId, "bash")), result(c.toolCallId, "bash", "ok")], { session: "ses_u1" }));
    await tool;
    await agent.usage(t1.sid, 42_000);
    await agent.chunk(t1.sid, "fin");
    // the turn made 2 requests: the SUM double-counts the shared prefix
    agent.endTurn(t1.sid, { stopReason: "end_turn", usage: { inputTokens: 2_000, cachedReadTokens: 78_000, cachedWriteTokens: 2_000, outputTokens: 1_000 } });
    const u = finishOf(await r2.done).usage;
    assert.equal(u.inputTokens.total + u.outputTokens.total, 42_000);
    assert.ok(u.inputTokens.cacheRead > u.inputTokens.noCache, "cache ratio kept");
  } finally { done(); }
});

// ------------------------------------------------- COMPACTION -----------------

const CKPT = "<conversation-checkpoint>\nResumen: el usuario pidió A y B.\n</conversation-checkpoint>";
const SUMMARY_REQ = "You MUST summarize the conversation above into a structured summary.";

async function convoThenCompact(conf, session) {
  const env = setup(conf);
  const { agent, model } = env;
  const t1 = await first(agent, model, [SYS, user("pide A")], { session });
  await reply(agent, t1.sid, t1.r, "hecho A");
  // OpenCode compaction request: older history + the summary instruction, no ocAgent
  const rc = run(model, opts([SYS, user("pide A"), asst("hecho A"), user(SUMMARY_REQ)], { session, extra: { requestKind: "compaction" } }));
  const pc = await agent.next("prompt", (e) => e.text.includes("summarize"));
  return { ...env, t1, rc, pc };
}

test("#15: an OpenCode compaction is answered by the live session (warm), not a cold replay", async () => {
  const { agent, model, done, t1, rc, pc } = await convoThenCompact({}, "ses_k1c");
  try {
    assert.equal(pc.sessionId, t1.sid);
    assert.equal(pc.text.trim(), SUMMARY_REQ, "only the instruction travels");
    assert.equal(agent.log.filter((e) => e.type === "newSession").length, 1);
    await reply(agent, t1.sid, rc, "RESUMEN");
    assert.equal(textOf(rc.parts), "RESUMEN");
    // shadow (default): the post-compaction history still starts a new session, as legacy
    const r2 = run(model, opts([SYS, user(CKPT), user("sigue")], { session: "ses_k1c" }));
    const ns = await agent.next("newSession");
    assert.notEqual(ns.sessionId, t1.sid);
    await agent.next("prompt", (e) => e.sessionId === ns.sessionId);
    await reply(agent, ns.sessionId, r2, "ok");
    assert.ok((await decisions("ses_k1c")).some((d) => d.decision === "shadow-checkpoint"));
  } finally { done(); }
});

test("#15 v2: after the summary the session compacts natively and adopts the checkpoint", async () => {
  const { agent, model, done, t1, rc } = await convoThenCompact(v2, "ses_k2c");
  try {
    await reply(agent, t1.sid, rc, "RESUMEN");
    const pcompact = await agent.next("prompt", (e) => e.text === "/compact");
    await agent.chunk(t1.sid, "Compacting...");
    agent.endTurn(t1.sid);
    await sleep(20);
    const r2 = run(model, opts([SYS, user(CKPT), user("sigue con B")], { session: "ses_k2c" }));
    const p2 = await agent.next("prompt", (e) => /sigue con B/.test(e.text));
    assert.equal(p2.sessionId, t1.sid, "same session");
    assert.doesNotMatch(p2.text, /conversation-checkpoint|Compacting/);
    await reply(agent, t1.sid, r2, "B hecho");
    assert.doesNotMatch(textOf(r2.parts), /Compacting/);
    assert.equal(agent.log.filter((e) => e.type === "newSession").length, 1);
    void pcompact;
  } finally { done(); }
});

test("2c.4 v2: another model's checkpoint is caught up into the live session", async () => {
  const { agent, model, done } = setup(v2);
  try {
    const t1 = await first(agent, model, [SYS, user("pide A")], { session: "ses_k3c" });
    await reply(agent, t1.sid, t1.r, "hecho A");
    // the user switched models; that model's session got compacted by OpenCode
    const r2 = run(model, opts([SYS, user(CKPT), asst("otro modelo hizo B"), user("vuelvo a Claude")], { session: "ses_k3c" }));
    const p2 = await agent.next("prompt", (e) => /vuelvo a Claude/.test(e.text));
    assert.equal(p2.sessionId, t1.sid);
    assert.match(p2.text, /<context_update>[\s\S]*conversation-checkpoint[\s\S]*Resumen[\s\S]*<other_model_turn>[\s\S]*otro modelo hizo B[\s\S]*vuelvo a Claude$/);
    await reply(agent, t1.sid, r2, "ok");
  } finally { done(); }
});

// ------------------------------------------------- NATIVE ACTIVITY ------------

test("4.1: a native Task/WebSearch leaves a portable trace in the answer; OpenCode tools don't", async () => {
  const { agent, model, done } = setup();
  try {
    const t1 = await first(agent, model, [SYS, user("investiga")], { session: "ses_n1" });
    const tc = (id, toolName, title, extra = {}) =>
      agent.toolUpdate(t1.sid, { sessionUpdate: "tool_call", toolCallId: id, title, kind: "think", status: "pending", _meta: { claudeCode: { toolName, ...extra } } });
    const done1 = (id, text, status = "completed") =>
      agent.toolUpdate(t1.sid, { sessionUpdate: "tool_call_update", toolCallId: id, status, content: [{ type: "content", content: { type: "text", text } }] });
    await agent.chunk(t1.sid, "Voy a delegar. ");
    await tc("tu_task", "Agent", "Buscar el bug de login");
    await tc("tu_ws", "WebSearch", '"acp protocol"', { parentToolUseId: "tu_task" });
    await done1("tu_ws", "resultado web");
    await tc("tu_mcp", "mcp__opencode__read", "mcp__opencode__read");
    await done1("tu_mcp", "contenido");
    await done1("tu_task", "El bug está en auth.ts:42");
    await reply(agent, t1.sid, t1.r, "Listo.");
    const text = textOf(t1.r.parts);
    assert.match(text, /↳ ⚙ WebSearch: "acp protocol"\n\n```text\nresultado web\n```/);
    assert.match(text, /⚙ Agent: Buscar el bug de login\n\n```text\nEl bug está en auth\.ts:42\n```/);
    assert.doesNotMatch(text, /mcp__opencode__read/);
    // the trace is the agent's own output: not sent back to it next turn — whether V2
    // stores one part per block (what it does) or the step's text as a single part
    const parts = [];
    let cur = null;
    for (const p of t1.r.parts) {
      if (p.type === "text-start") cur = "";
      else if (p.type === "text-delta") cur += p.delta;
      else if (p.type === "text-end") { parts.push(cur); cur = null; }
    }
    assert.ok(parts.length >= 3);
    const r2 = run(model, opts([SYS, user("investiga"), asst(...parts), user("¿y?")], { session: "ses_n1" }));
    const p2 = await agent.next("prompt", (e) => /¿y\?/.test(e.text));
    assert.doesNotMatch(p2.text, /auth\.ts/);
    await reply(agent, t1.sid, r2, "ok");
    const r3 = run(model, opts([SYS, user("investiga"), asst(...parts), user("¿y?"), asst("ok"), user("¿y ahora?")], { session: "ses_n1" }));
    const p3 = await agent.next("prompt", (e) => /¿y ahora\?/.test(e.text));
    assert.doesNotMatch(p3.text, /other_model_turn/);
    await reply(agent, t1.sid, r3, "ok2");
  } finally { done(); }
});

test("4.1: own text stored by OpenCode as ONE part is still recognised", async () => {
  const { agent, model, done } = setup();
  try {
    const t1 = await first(agent, model, [SYS, user("hola")], { session: "ses_n2" });
    await agent.chunk(t1.sid, "parte uno. ");
    await agent.toolUpdate(t1.sid, { sessionUpdate: "tool_call", toolCallId: "w", title: "q", status: "pending", _meta: { claudeCode: { toolName: "WebSearch" } } });
    await agent.toolUpdate(t1.sid, { sessionUpdate: "tool_call_update", toolCallId: "w", status: "completed", content: [] });
    await reply(agent, t1.sid, t1.r, "parte dos");
    const whole = textOf(t1.r.parts);
    const r2 = run(model, opts([SYS, user("hola"), asst(whole), user("sigue")], { session: "ses_n2" }));
    const p2 = await agent.next("prompt", (e) => /sigue/.test(e.text));
    assert.doesNotMatch(p2.text, /parte uno|other_model_turn/);
    await reply(agent, t1.sid, r2, "ok");
  } finally { done(); }
});

// ------------------------------------------------- SMART REVERT ---------------

test("4.2 smartRevert: a revert forks the session back to Claude's state before it", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const configDir = mkdtempSync(join(tmpdir(), "acp-cfg-"));
  const { agent, model, done } = setup({ claudeCode: { configDir, smartRevert: true } });
  try {
    const t1 = await first(agent, model, [SYS, user("uno")], { session: "ses_sr" });
    await reply(agent, t1.sid, t1.r, "R1");
    // the agent's transcript after turn 1
    const dir = join(configDir, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${t1.sid}.jsonl`), [
      JSON.stringify({ type: "user", uuid: "u-0" }),
      JSON.stringify({ type: "assistant", uuid: "a-1" }),
      JSON.stringify({ type: "assistant", uuid: "side", isSidechain: true }),
    ].join("\n") + "\n");
    const r2 = run(model, opts([SYS, user("uno"), asst("R1"), user("dos")], { session: "ses_sr" }));
    await agent.next("prompt", (e) => /dos/.test(e.text));
    await reply(agent, t1.sid, r2, "R2");
    // the user reverts "dos" and asks something else
    const r3 = run(model, opts([SYS, user("uno"), asst("R1"), user("tres")], { session: "ses_sr" }));
    const fk = await agent.next("forked");
    const fs = agent.log.find((e) => e.type === "forkSession");
    assert.equal(fs.meta.claudeCode.options.resumeSessionAt, "a-1");
    const p3 = await agent.next("prompt", (e) => e.sessionId === fk.sessionId);
    assert.equal(p3.text.trim(), "tres", "nothing replayed");
    assert.equal(agent.log.filter((e) => e.type === "newSession").length, 1);
    await reply(agent, fk.sessionId, r3, "R3");
  } finally { done(); }
});
