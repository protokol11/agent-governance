// Run: node --test test/instruction.test.mjs
// ADR-0036: the transfer instruction is a consume-once system guideline, and
// the turn marker is language-neutral (never English user-role prose).
import assert from "node:assert/strict";
import test from "node:test";
import { TRANSFER_MARKER, buildGuidelines, packagingPrompt } from "../core/instruction.ts";

const usage = (tokens) => ({ tokens, contextWindow: 262144, percent: null });

test("consumes the pending instruction exactly once and clears it", () => {
  const first = buildGuidelines("ok", usage(1000), "DO THE TRANSFER");
  assert.deepEqual(first.guidelines, ["DO THE TRANSFER"]);
  assert.equal(first.pending, null, "pending is always cleared");
});

test("hot bands prepend the wrap-up guideline before the transfer instruction", () => {
  const out = buildGuidelines("warn", usage(150_000), "DO THE TRANSFER");
  assert.equal(out.guidelines.length, 2);
  assert.match(out.guidelines[0], /begin_transfer/);
  assert.equal(out.guidelines[1], "DO THE TRANSFER");
});

test("no pending instruction and ok band yields no guidelines", () => {
  assert.deepEqual(buildGuidelines("ok", usage(1), null), { guidelines: [], pending: null });
});

test("unknown usage still consumes the pending instruction (fail-silent band)", () => {
  const out = buildGuidelines("ok", undefined, "DO THE TRANSFER");
  assert.deepEqual(out.guidelines, ["DO THE TRANSFER"]);
  assert.equal(out.pending, null);
});

test("the marker is language-neutral: a single bracketed token, no prose", () => {
  assert.equal(TRANSFER_MARKER, "[session-transfer]");
  assert.equal(TRANSFER_MARKER.trim(), TRANSFER_MARKER);
  assert.doesNotMatch(TRANSFER_MARKER, /\s/);
});

test("packagingPrompt names the three steps and forbids rotation (ADR-0037)", () => {
  const p = packagingPrompt("01a11713-abc");
  assert.match(p, /hands-off/);
  assert.match(p, /update-docs/);
  assert.match(p, /name_session/);
  assert.match(p, /sessionId: 01a11713-abc/);
  assert.match(p, /Do not rotate or create a new session/);
});
