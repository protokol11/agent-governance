// Run: node --test test/begin-guard.test.mjs
// Pure guard for the agent-owned `begin_transfer` tool. Idle is NOT part of the
// contract: the agent acts while the user is present. The single key is the band.
import assert from "node:assert/strict";
import test from "node:test";
import { beginGuard } from "../core/gate.ts";

test("hot + idle + enabled → allowed", () => {
  assert.deepEqual(beginGuard("idle", false, "warn"), { ok: true });
  assert.deepEqual(beginGuard("idle", false, "critical"), { ok: true });
});

test("not hot → rejected (the only reason is the band)", () => {
  assert.deepEqual(beginGuard("idle", false, "ok"), { ok: false, reason: "not_hot" });
});

test("busy → rejected regardless of band", () => {
  assert.deepEqual(beginGuard("pending_docs", false, "critical"), { ok: false, reason: "busy" });
  assert.deepEqual(beginGuard("armed", false, "warn"), { ok: false, reason: "busy" });
});

test("disabled → rejected first, regardless of state or band", () => {
  assert.deepEqual(beginGuard("idle", true, "critical"), { ok: false, reason: "disabled" });
  assert.deepEqual(beginGuard("pending_docs", true, "warn"), { ok: false, reason: "disabled" });
});

test("idle is not required: a hot idle state is the only allowed combination", () => {
  assert.deepEqual(beginGuard("idle", false, "warn"), { ok: true });
  assert.notDeepEqual(beginGuard("pending_docs", false, "warn"), { ok: true });
});
