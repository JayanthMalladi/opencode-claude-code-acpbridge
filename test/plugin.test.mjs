import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers.mjs";

const { titleFrom } = await import("../dist/plugin/index.js");

test("title: first meaningful line of the first user message, never model output", () => {
  assert.equal(titleFrom([{ role: "user", content: [{ type: "text", text: '"Lee el fichero a.txt y dime su primera línea."' }] }]), "Lee el fichero a.txt y dime su primera línea.");
  assert.equal(titleFrom([{ role: "user", content: "\n\n# Arregla el login\nmás detalle" }]), "Arregla el login");
  const long = titleFrom([{ role: "user", content: "Necesito que revises el plugin que está en acp-model-provider para poder usar claude-code desde opencode" }]);
  assert.ok(long.length <= 61 && long.endsWith("…"), long);
  assert.equal(titleFrom([{ role: "user", content: "<system-reminder>x</system-reminder>\nhola mundo" }]), "hola mundo");
  assert.equal(titleFrom([]), undefined);
});
