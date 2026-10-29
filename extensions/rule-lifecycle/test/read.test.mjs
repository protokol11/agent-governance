// Run: node --test test/read.test.mjs
// Read-only boundary: rule-lifecycle reuses the judgment fold-on-read path.
// Hand-built JSONL fixtures, no live ledger.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJudgments, readRefusals } from "../../judgment/core/ledger.ts";

function writeLedger(lines) {
  const dir = mkdtempSync(join(tmpdir(), "rule-lifecycle-"));
  const path = join(dir, "judgments.jsonl");
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return { dir, path };
}

test("refusal rows fold through readJudgments/readRefusals without duplicating records", () => {
  const { dir, path } = writeLedger([
    {
      kind: "judgment",
      judgment_id: "j1",
      ts: "t1",
      state_hash: "h1",
      question_id: "cp-review:CP-50",
      type: "noul",
      instructions: "uses any",
      criteria: null,
      value: "no",
      confidence: 0.6,
      model: "mock/mock",
      provenance: "judge",
      outcome: null,
    },
    { kind: "resolution", judgment_id: "j1", outcome: true, ts: "t2" },
    { kind: "refusal", judgment_id: "j1", rule_id: "CP-50", witness: "w1", price: 2, ts: "t3" },
  ]);
  try {
    const records = readJudgments(path);
    assert.equal(records.length, 1, "refusal must not duplicate the record");
    assert.equal(records[0].outcome, true);
    const refusals = readRefusals(path);
    assert.equal(refusals.size, 1);
    assert.deepEqual(refusals.get("j1"), {
      judgment_id: "j1",
      rule_id: "CP-50",
      witness: "w1",
      price: 2,
      ts: "t3",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refusal referencing an unknown judgment_id throws (crash early)", () => {
  const { dir, path } = writeLedger([
    { kind: "refusal", judgment_id: "ghost", rule_id: "CP-50", witness: "w", price: 1, ts: "t" },
  ]);
  try {
    assert.throws(() => readJudgments(path), /unknown judgment_id/);
    assert.throws(() => readRefusals(path), /unknown judgment_id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
