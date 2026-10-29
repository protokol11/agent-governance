// Run: node --test test/refusal.test.mjs
// Slice 0 of rule-lifecycle: refusal records fold on read; the rule-predicate
// call site emits a priced refusal on escalate. Fixture ledgers only.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendJudgment,
  appendRefusal,
  readJudgments,
  readRefusals,
  refusalForEscalation,
} from "../core/ledger.ts";
import { decide } from "../core/policy.ts";
import { SCOPE_COSTS } from "../core/scope.ts";
import { judgeRecord } from "./fixtures.mjs";

test("refusal rows fold into a sidecar map keyed by judgment_id", () => {
  const dir = mkdtempSync(join(tmpdir(), "judgment-"));
  try {
    const path = join(dir, "judgments.jsonl");
    appendJudgment(path, judgeRecord({ judgment_id: "a" }));
    appendRefusal(path, { judgment_id: "a", rule_id: "CP-01", witness: "witness-a", price: 1, ts: "t1" });
    const records = readJudgments(path);
    assert.equal(records.length, 1, "refusal must not duplicate the record");
    assert.equal(records[0].judgment_id, "a");
    const refusals = readRefusals(path);
    assert.equal(refusals.size, 1);
    assert.deepEqual(refusals.get("a"), {
      judgment_id: "a",
      rule_id: "CP-01",
      witness: "witness-a",
      price: 1,
      ts: "t1",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRefusals is empty when the ledger has no refusals", () => {
  const dir = mkdtempSync(join(tmpdir(), "judgment-"));
  try {
    const path = join(dir, "judgments.jsonl");
    appendJudgment(path, judgeRecord({ judgment_id: "a" }));
    assert.equal(readRefusals(path).size, 0);
    assert.equal(readRefusals(join(dir, "missing.jsonl")).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refusal referencing an unknown judgment_id is skipped, not fatal (incident 2026-10-12)", () => {
  const dir = mkdtempSync(join(tmpdir(), "judgment-"));
  try {
    const path = join(dir, "judgments.jsonl");
    appendJudgment(path, judgeRecord({ judgment_id: "a" }));
    appendRefusal(path, { judgment_id: "ghost", rule_id: "CP-01", witness: "w", price: 1, ts: "t" });
    // One corrupt refusal must not brick the whole read path: every readLedger
    // caller (scope lock, gate, judge) would block all writes session-wide.
    assert.equal(readJudgments(path).length, 1);
    assert.equal(readRefusals(path).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("escalate at the rule-predicate call site appends a refusal row with correct fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "judgment-"));
  try {
    const path = join(dir, "judgments.jsonl");
    // Cold start (0 resolved) forces the rule-judge branch to escalate at p=0.95.
    const decision = decide(0.95, { ...SCOPE_COSTS, resolvedCount: 0 });
    assert.equal(decision.action, "escalate");
    const judgmentId = "scope-lock-rule-test";
    appendJudgment(
      path,
      judgeRecord({ judgment_id: judgmentId, provenance: "code", model: "rule:trigger-predicate" })
    );
    const refusal = refusalForEscalation(decision, {
      judgment_id: judgmentId,
      rule_id: "scope-lock:trigger-predicate",
      witness: "declared scope",
      ts: "2026-10-02T00:00:00.000Z",
    });
    assert.ok(refusal, "escalate must produce a refusal");
    appendRefusal(path, refusal);
    const folded = readRefusals(path).get(judgmentId);
    assert.equal(folded.rule_id, "scope-lock:trigger-predicate");
    assert.equal(folded.witness, "declared scope");
    assert.equal(folded.price, decision.costs.escalate);
    assert.equal(folded.ts, "2026-10-02T00:00:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an act decision emits no refusal", () => {
  const decision = decide(0.95, { costFalseYes: 10, costFalseNo: 1, costEscalate: 1, resolvedCount: 3 });
  assert.equal(decision.action, "act");
  assert.equal(
    refusalForEscalation(decision, { judgment_id: "x", rule_id: "r", witness: "w", ts: "t" }),
    null
  );
});
