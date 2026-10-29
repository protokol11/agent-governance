// Run: node --test test/seed.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { buildSeed, readHandoffSessionId, readNextSessionMode } from "../core/seed.ts";

test("implement seed carries an explicit implement trigger", () => {
  const seed = buildSeed(".docs/handoff/handoff-x-2026-10-03.md", "implement");
  assert.match(seed, /\bimplement\b/i);
  assert.match(seed, /\.docs\/handoff\/handoff-x-2026-10-03\.md/);
});

test("missing mode defaults to an implement trigger", () => {
  assert.match(buildSeed("h.md"), /\bimplement\b/i);
});

test("review mode does not claim to implement", () => {
  const seed = buildSeed("h.md", "review");
  assert.doesNotMatch(seed, /\bimplement\b/i);
  assert.match(seed, /review/i);
});

test("drill mode does not claim to implement", () => {
  const seed = buildSeed("h.md", "drill");
  assert.doesNotMatch(seed, /\bimplement\b/i);
  assert.match(seed, /drill/i);
});

test("readNextSessionMode parses frontmatter, tolerates quotes", () => {
  assert.equal(readNextSessionMode('---\nnext_session_mode: "drill"\n---'), "drill");
  assert.equal(readNextSessionMode("next_session_mode: implement"), "implement");
  assert.equal(readNextSessionMode("---\ntitle: x\n---"), undefined);
});

test("readHandoffSessionId parses frontmatter, tolerates quotes", () => {
  assert.equal(readHandoffSessionId('---\nsessionId: "01a11713-abc"\n---'), "01a11713-abc");
  assert.equal(readHandoffSessionId("sessionId: 01a11713-abc"), "01a11713-abc");
  assert.equal(readHandoffSessionId("---\ntitle: x\n---"), undefined);
});
