// Run: node --test test/promote.test.mjs
// Promotion gates and the symmetric demotion valve, over hand-built fixtures.
// CP-50 is backed by the example synthesized lint in lints/.
import assert from "node:assert/strict";
import test from "node:test";
import { demotionCandidates, promotionCandidates } from "../core/promote.ts";
import { record, refusal, refusalMap } from "./fixtures.mjs";

const GATES = { minSample: 4, maxFalseRefusalRate: 0.5, minHumanResolved: 3, replayThreshold: 0.7 };

function witness(id, { outcome, value, provenance = "human", instructions = "clean code" }) {
  return record({
    judgment_id: id,
    question_id: "cp-review:CP-50",
    provenance,
    value,
    outcome,
    instructions,
  });
}

function refusalsFor(ruleId, ids) {
  return refusalMap(ids.map((id) => refusal({ judgment_id: id, rule_id: ruleId })));
}

test("promotion fires when every gate passes and records the held-out replay report", () => {
  const records = [
    witness("w1", { outcome: true, value: "no", instructions: "uses any" }),
    witness("w2", { outcome: true, value: "no", instructions: "uses any" }),
    witness("w3", { outcome: false, value: "yes", instructions: "clean code" }),
    witness("w4", { outcome: false, value: "yes", instructions: "uses unknown" }),
  ];
  const events = promotionCandidates(records, refusalsFor("CP-50", ["w1", "w2", "w3", "w4"]), GATES);
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.kind, "promotion");
  assert.equal(event.rule_id, "CP-50");
  assert.equal(event.from, "should");
  assert.equal(event.to, "must");
  assert.equal(event.sample, 4);
  assert.equal(event.falseRefusalRate, 0);
  assert.equal(event.humanResolved, 4);
  assert.deepEqual(event.provenance.sort(), ["w1", "w2", "w3", "w4"]);
  assert.ok(event.replay.heldOutAccuracy >= GATES.replayThreshold, "heldOutAccuracy must meet the threshold");
  assert.deepEqual(event.replay, { heldOutAccuracy: 0.75, n: 4 });
});

test("promotion is blocked when humanResolved < minHumanResolved", () => {
  const records = [
    witness("w1", { outcome: true, value: "no", provenance: "judge", instructions: "uses any" }),
    witness("w2", { outcome: true, value: "no", provenance: "judge", instructions: "uses any" }),
    witness("w3", { outcome: false, value: "yes", instructions: "clean code" }),
    witness("w4", { outcome: false, value: "yes", instructions: "uses unknown" }),
  ];
  assert.deepEqual(promotionCandidates(records, refusalsFor("CP-50", ["w1", "w2", "w3", "w4"]), GATES), []);
});

test("promotion is blocked when held-out replay accuracy is under the threshold", () => {
  const records = [
    witness("w1", { outcome: true, value: "no", instructions: "clean code" }),
    witness("w2", { outcome: false, value: "yes", instructions: "uses any" }),
    witness("w3", { outcome: false, value: "yes", instructions: "clean code" }),
    witness("w4", { outcome: false, value: "yes", instructions: "uses unknown" }),
  ];
  const events = promotionCandidates(records, refusalsFor("CP-50", ["w1", "w2", "w3", "w4"]), GATES);
  assert.deepEqual(events, [], "accuracy 0.25 must not promote at threshold 0.7");
});

test("promotion is blocked when the false-refusal rate is over tolerance", () => {
  const records = [
    witness("w1", { outcome: true, value: "yes", instructions: "uses any" }),
    witness("w2", { outcome: true, value: "yes", instructions: "uses any" }),
    witness("w3", { outcome: false, value: "no", instructions: "clean code" }),
    witness("w4", { outcome: false, value: "no", instructions: "uses unknown" }),
  ];
  assert.deepEqual(promotionCandidates(records, refusalsFor("CP-50", ["w1", "w2", "w3", "w4"]), GATES), []);
});

test("promotion is blocked when the refusal sample is under minSample", () => {
  const records = [
    witness("w1", { outcome: true, value: "no", instructions: "uses any" }),
    witness("w2", { outcome: true, value: "no", instructions: "uses any" }),
    witness("w3", { outcome: false, value: "yes", instructions: "clean code" }),
  ];
  assert.deepEqual(promotionCandidates(records, refusalsFor("CP-50", ["w1", "w2", "w3"]), GATES), []);
});

test("promotion requires a synthesized lint: an unregistered rule never promotes", () => {
  const records = [
    witness("w1", { outcome: true, value: "no", instructions: "uses any" }),
    witness("w2", { outcome: true, value: "no", instructions: "uses any" }),
    witness("w3", { outcome: false, value: "yes", instructions: "clean code" }),
    witness("w4", { outcome: false, value: "yes", instructions: "uses unknown" }),
  ];
  assert.deepEqual(promotionCandidates(records, refusalsFor("CP-99", ["w1", "w2", "w3", "w4"]), GATES), []);
});

test("demotionCandidates flags lint false-positive rates over tolerance", () => {
  const stats = [
    { rule_id: "CP-09", n: 20, falsePositiveRate: 0.2 },
    { rule_id: "CP-03", n: 10, falsePositiveRate: 0.05 },
    { rule_id: "CP-07", n: 0, falsePositiveRate: 1 },
  ];
  const events = demotionCandidates(stats, { maxFalsePositiveRate: 0.1 });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    kind: "demotion",
    rule_id: "CP-09",
    from: "must",
    to: "should",
    probation: true,
    falsePositiveRate: 0.2,
    n: 20,
  });
});

test("demotionCandidates is empty when every lint is within tolerance", () => {
  assert.deepEqual(demotionCandidates([{ rule_id: "CP-03", n: 10, falsePositiveRate: 0.1 }], { maxFalsePositiveRate: 0.1 }), []);
});
