// Run: node --test test/observer.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { OBSERVER_SYSTEM, buildObserverUser, parseVerdict } from "../core/observer.ts";

test("parses a plain JSON verdict", () => {
  const v = parseVerdict('{"candidate": true, "reason": "chunk done", "focus": "ship it"}');
  assert.deepEqual(v, { candidate: true, reason: "chunk done", focus: "ship it" });
});

test("tolerates code fences", () => {
  const v = parseVerdict('```json\n{"candidate": false, "reason": "mid-edit", "focus": ""}\n```');
  assert.equal(v.candidate, false);
});

test("tolerates surrounding prose", () => {
  const v = parseVerdict('Sure: {"candidate": true, "reason": "ok", "focus": "next"} — done.');
  assert.equal(v.candidate, true);
});

test("missing or non-boolean candidate is invalid", () => {
  assert.equal(parseVerdict('{"reason": "x"}'), null);
  assert.equal(parseVerdict('{"candidate": "yes"}'), null);
});

test("garbage and empty input are invalid", () => {
  assert.equal(parseVerdict("not json"), null);
  assert.equal(parseVerdict(""), null);
  assert.equal(parseVerdict("[]"), null);
});

test("missing reason/focus default to empty strings", () => {
  const v = parseVerdict('{"candidate": true}');
  assert.deepEqual(v, { candidate: true, reason: "", focus: "" });
});

test("the user prompt carries the transcript", () => {
  const u = buildObserverUser("user: hi\nassistant: hello");
  assert.ok(u.includes("user: hi"));
  assert.ok(u.includes("JSON only"));
});

test("system prompt demands JSON-only output", () => {
  assert.match(OBSERVER_SYSTEM, /JSON/);
});
