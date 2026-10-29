// Run: node --test test/lint.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { lintQuestion, lintQuestions } from "../core/lint.ts";

test("lint rejects each authoring violation before any model call", () => {
  const cases = [
    ["empty instructions", { type: "noul", instructions: "  " }, /empty instructions/],
    ["unknown type", { type: "foo", instructions: "x" }, /bad type/],
    ["not an object", null, /not an object/],
    ["score 1 level", { type: "score", instructions: "r?", criteria: ["only"] }, /2\.\.10/],
    ["score 12 levels", { type: "score", instructions: "r?", criteria: Array.from({ length: 12 }, (_, i) => i) }, /2\.\.10/],
    ["choice 1 option", { type: "choice", instructions: "r?", criteria: { a: "x" } }, />=2/],
  ];
  for (const [name, q, pattern] of cases) {
    assert.match(lintQuestion("q", q).join(" "), pattern, name);
  }
  assert.deepEqual(lintQuestion("q", { type: "noul", instructions: "ok" }), []);
});

test("lintQuestions collects errors per question id", () => {
  const errors = lintQuestions({ bad: { type: "noul", instructions: "" }, ok: { type: "noul", instructions: "x" } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^bad:/);
});
