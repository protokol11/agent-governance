// Run: node --test test/fsm.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_DOCS_TURN_BUDGET, INITIAL_MEMORY, reduce, shouldRotate } from "../core/fsm.ts";

const trigger = (channel = "implicit") => ({ type: "trigger", channel });

test("starts idle", () => {
  assert.equal(INITIAL_MEMORY.state, "idle");
  assert.equal(shouldRotate(INITIAL_MEMORY), false);
});

test("trigger from idle enters pending_docs with the channel", () => {
  const m = reduce(INITIAL_MEMORY, trigger("explicit"));
  assert.equal(m.state, "pending_docs");
  assert.equal(m.channel, "explicit");
  assert.equal(m.turnsInPending, 0);
});

test("the agent channel starts pending_docs like the other entries", () => {
  const m = reduce(INITIAL_MEMORY, trigger("agent"));
  assert.equal(m.state, "pending_docs");
  assert.equal(m.channel, "agent");
});

test("the explicit_resume channel enters the same tail (/transfer-resume)", () => {
  const m = reduce(INITIAL_MEMORY, trigger("explicit_resume"));
  assert.equal(m.state, "pending_docs");
  assert.equal(m.channel, "explicit_resume");
});

test("a second trigger while in flight is ignored", () => {
  const m = reduce(reduce(INITIAL_MEMORY, trigger("explicit")), trigger("implicit"));
  assert.equal(m.channel, "explicit");
});

test("docs_ready arms from pending_docs and stores the path", () => {
  const m = reduce(reduce(INITIAL_MEMORY, trigger()), { type: "docs_ready", path: "/h.md" });
  assert.equal(m.state, "armed");
  assert.equal(m.handoffPath, "/h.md");
  assert.equal(shouldRotate(m), true);
});

test("docs_ready from idle is ignored (no pending transfer)", () => {
  const m = reduce(INITIAL_MEMORY, { type: "docs_ready", path: "/h.md" });
  assert.equal(m.state, "idle");
});

test("a user message cancels pending_docs and armed", () => {
  const pending = reduce(INITIAL_MEMORY, trigger());
  assert.equal(reduce(pending, { type: "user_message" }).state, "idle");

  const armed = reduce(pending, { type: "docs_ready", path: "/h.md" });
  assert.equal(reduce(armed, { type: "user_message" }).state, "idle");
});

test("agent_settled counts turns and aborts past the budget", () => {
  let m = reduce(INITIAL_MEMORY, trigger());
  for (let i = 1; i < DEFAULT_DOCS_TURN_BUDGET; i++) {
    m = reduce(m, { type: "agent_settled" });
    assert.equal(m.state, "pending_docs", `still pending after ${i} settle(s)`);
    assert.equal(m.turnsInPending, i);
  }
  m = reduce(m, { type: "agent_settled" });
  assert.equal(m.state, "idle", "aborted after the budget");
});

test("agent_settled does not touch the turn counter while armed", () => {
  const armed = reduce(reduce(INITIAL_MEMORY, trigger()), { type: "docs_ready", path: "/h.md" });
  const after = reduce(armed, { type: "agent_settled" });
  assert.equal(after.state, "armed");
  assert.equal(after.handoffPath, "/h.md");
});

test("rotation_dispatched resets a fully armed transfer", () => {
  const armed = reduce(reduce(INITIAL_MEMORY, trigger()), { type: "docs_ready", path: "/h.md" });
  const after = reduce(armed, { type: "rotation_dispatched" });
  assert.deepEqual(after, INITIAL_MEMORY);
});

test("custom budget is honored", () => {
  let m = reduce(INITIAL_MEMORY, trigger(), 2);
  m = reduce(m, { type: "agent_settled" }, 2);
  assert.equal(m.state, "pending_docs");
  m = reduce(m, { type: "agent_settled" }, 2);
  assert.equal(m.state, "idle");
});
