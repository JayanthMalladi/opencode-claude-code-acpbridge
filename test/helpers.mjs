// Test helpers: isolated HOME (the provider writes ~/.acp-model-provider/*), V2-shaped
// prompt builders, and a stream collector. The provider modules are imported
// dynamically AFTER the env is set, because their paths are computed at load time.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAgent } from "./fake-agent.mjs";

process.env.HOME = mkdtempSync(join(tmpdir(), "acp-test-home-"));
process.env.ACP_LOG = "0";
process.env.ACP_RECORD = mkdtempSync(join(tmpdir(), "acp-test-rec-"));
delete process.env.ACP_HISTORY_MODE;

const { ACPOrchestratorModel, ACPModelView } = await import("../dist/provider/model.js");
export { ACPModelView };

export { createFakeAgent };

/** Model wired to a fresh fake agent. */
export function setup({ modelId = "claude-code", claudeCode = {}, agent: agentOpts } = {}) {
  const agent = createFakeAgent(agentOpts);
  const model = new ACPOrchestratorModel({ command: "fake", modelId, claudeCode, transport: agent.transport, cwd: process.cwd() });
  return { agent, model, done: () => { model.cleanup(); agent.close(); } };
}

// ---- V2-shaped prompt parts (LanguageModelV3Prompt, as aisdk.ts builds it) ----------
export const sys = (text) => ({ role: "system", content: text });
export const user = (...texts) => ({ role: "user", content: texts.map((t) => (typeof t === "string" ? { type: "text", text: t } : t)) });
export const asst = (...parts) => ({ role: "assistant", content: parts.map((p) => (typeof p === "string" ? { type: "text", text: p } : p)) });
export const reasoning = (text) => ({ type: "reasoning", text });
export const call = (toolCallId, toolName, input = {}) => ({ type: "tool-call", toolCallId, toolName, input });
export const result = (toolCallId, toolName, value, type = "text") => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId, toolName, output: { type, value } }],
});

export const TOOLS = [
  { type: "function", name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { type: "function", name: "bash", description: "Run a command", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
  { type: "function", name: "question", description: "Ask the user", inputSchema: { type: "object", properties: {} } },
];

/** doStream options as OpenCode V2 sends them for a primary call. */
export function opts(prompt, { session = "ses_test", agent = "claude-code", tools = TOOLS, extra = {} } = {}) {
  return { prompt, tools, providerOptions: { acp: { ocSession: session, ocAgent: agent, ...extra } } };
}

/** Start a doStream and collect every part until the stream closes. */
export function run(model, options) {
  const parts = [];
  const done = (async () => {
    const { stream } = await model.doStream(options);
    const reader = stream.getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      parts.push(value);
    }
    return parts;
  })();
  return { parts, done };
}

export const textOf = (parts) => parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("");
export const finishOf = (parts) => parts.find((p) => p.type === "finish");
export const callsOf = (parts) => parts.filter((p) => p.type === "tool-call");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decisions the provider recorded for one conversation (ACP_RECORD). */
export async function decisions(conv) {
  await sleep(30); // recording is fire-and-forget
  const f = join(process.env.ACP_RECORD, `${conv}.jsonl`);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === "decision");
}
