// Run: node --test test/mine.test.mjs
// mineResiduals cluster math and replay accuracy over hand-built fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { mineResiduals, replay } from "../core/mine.ts";
import { record, refusal, refusalMap } from "./fixtures.mjs";

test("mineResiduals clusters residuals by question and reports the disagreement rate", () => {
  const records = [
    record({ judgment_id: "a", question_id: "Q1", value: "no", outcome: true, state_hash: "h1", instructions: "i1" }),
    record({ judgment_id: "b", question_id: "Q1", value: "yes", outcome: true, state_hash: "h2", instructions: "i2" }),
    record({ judgment_id: "c", question_id: "Q1", value: "no", outcome: true, state_hash: "h3", instructions: "i3" }),
    record({ judgment_id: "d", question_id: "Q1", value: "yes", outcome: false, state_hash: "h4", instructions: "i4" }),
    record({ judgment_id: "e", question_id: "Q1", value: "yes", outcome: true, state_hash: "h5", instructions: "i5" }),
  ];
  const clusters = mineResiduals(records, new Map(), { minVolume: 5, minDisagreement: 0.2 });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0], {
    question_id: "Q1",
    n: 5,
    disagreementRate: 0.6,
    sampleHashes: ["h1", "h2", "h3", "h4", "h5"],
    sampleInstructions: ["i1", "i2", "i3", "i4", "i5"],
  });
});

test("mineResiduals drops clusters below the volume or disagreement threshold", () => {
  const records = [
    record({ judgment_id: "a", question_id: "Q1", value: "no", outcome: true }),
    record({ judgment_id: "b", question_id: "Q1", value: "yes", outcome: true }),
  ];
  assert.deepEqual(mineResiduals(records, new Map(), { minVolume: 5, minDisagreement: 0.2 }), []);
  const five = Array.from({ length: 5 }, (_, i) =>
    record({ judgment_id: `q${i}`, question_id: "Q2", value: "yes", outcome: true })
  );
  assert.deepEqual(mineResiduals(five, new Map(), { minVolume: 5, minDisagreement: 0.2 }), []);
});

test("mineResiduals ranks clusters by volume × disagreement rate", () => {
  const records = [];
  for (let i = 0; i < 5; i++) {
    records.push(record({ judgment_id: `low-${i}`, question_id: "LOW", value: "no", outcome: true }));
  }
  records.push(record({ judgment_id: "low-ok", question_id: "LOW", value: "yes", outcome: true }));
  for (let i = 0; i < 6; i++) {
    records.push(record({ judgment_id: `high-${i}`, question_id: "HIGH", value: "no", outcome: true }));
  }
  const clusters = mineResiduals(records, new Map(), { minVolume: 5, minDisagreement: 0.5 });
  assert.deepEqual(clusters.map((c) => c.question_id), ["HIGH", "LOW"]);
});

test("a refusal-linked record counts as a residual even with non-judge provenance", () => {
  const records = [
    record({ judgment_id: "code-1", question_id: "Q9", provenance: "code", value: "no", outcome: true }),
  ];
  const refusals = refusalMap([refusal({ judgment_id: "code-1", rule_id: "CP-50" })]);
  const clusters = mineResiduals(records, refusals, { minVolume: 1, minDisagreement: 0.5 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].question_id, "Q9");
});

test("unresolved records are not residuals", () => {
  const records = [record({ judgment_id: "u", question_id: "Q1", outcome: null, value: "no" })];
  assert.deepEqual(mineResiduals(records, new Map(), { minVolume: 1, minDisagreement: 0 }), []);
});

test("replay returns accuracy and the mismatching judgment_ids", () => {
  const predicate = (r) => r.instructions.includes("bad");
  const records = [
    record({ judgment_id: "m1", instructions: "bad code", outcome: true }),
    record({ judgment_id: "m2", instructions: "bad code", outcome: true }),
    record({ judgment_id: "m3", instructions: "clean code", outcome: false }),
    record({ judgment_id: "m4", instructions: "bad code", outcome: false }),
    record({ judgment_id: "unresolved", instructions: "bad code", outcome: null }),
  ];
  const report = replay(predicate, records);
  assert.equal(report.n, 4, "unresolved records are excluded");
  assert.equal(report.accuracy, 0.75);
  assert.deepEqual(report.mismatches, ["m4"]);
});

test("replay over no resolved records reports zero accuracy", () => {
  assert.deepEqual(replay(() => true, [record({ outcome: null })]), { accuracy: 0, n: 0, mismatches: [] });
});
