// Run: node --test test/policy.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { calibration, decide, decisionOf } from "../core/policy.ts";
import { judgeRecord } from "./fixtures.mjs";

test("calibration excludes non-judge provenance and unresolved records", () => {
  const records = [
    judgeRecord({ provenance: "judge", confidence: 0.9, outcome: true }),
    judgeRecord({ provenance: "prose", confidence: 0.1, outcome: true }),
    judgeRecord({ provenance: "judge", confidence: 0.2, outcome: null }),
  ];
  const bins = calibration(records, 2);
  assert.equal(bins.reduce((s, b) => s + b.n, 0), 1, "only the resolved judge record counts");
  assert.equal(calibration(records, 2, { provenance: "prose" }).reduce((s, b) => s + b.n, 0), 1);
});

test("decide picks the cheapest of three priced actions", () => {
  assert.deepEqual(decide(0.1, { costFalseYes: 1, costFalseNo: 1 }), {
    action: "act",
    value: "no",
    costs: { yes: 0.9, no: 0.1, escalate: null },
  });
  assert.equal(decide(0.99, { costEscalate: 2 }).action, "act");
  assert.equal(decide(0.5, { costFalseYes: 10, costFalseNo: 10, costEscalate: 2 }).action, "escalate");
  // matched table from the prototype scenarios.mjs, widened by the tie-break:
  // at these costs p=0.2 and p=0.8 land exactly on the escalation price, and a
  // tie now goes to the human instead of to sort order.
  const esc = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95].filter(
    (p) => decide(p, { costFalseYes: 10, costFalseNo: 10, costEscalate: 2 }).action === "escalate"
  );
  assert.deepEqual(esc, [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
});

test("decide reproduces the pre-change 2026-10-25 ledger table (10/1/1, resolvedCount 100)", () => {
  // The scope-lock costs used to be 10/1/1 before the deny price moved to 2.
  // This table is the reproduced behavior the spec asks to keep as evidence:
  // the middle band never escalates and only p=0.95 clears act-yes.
  const costs = { costFalseYes: 10, costFalseNo: 1, costEscalate: 1, resolvedCount: 100 };
  for (const p of [0.8, 0.78, 0.85, 0.9]) {
    const d = decide(p, costs);
    assert.equal(d.action, "act", `p=${p} acts`);
    assert.equal(d.value, "no", `p=${p} acts no`);
    assert.notEqual(d.action, "escalate", `p=${p} must not escalate at 10/1/1`);
  }
  const high = decide(0.95, costs);
  assert.equal(high.action, "act", "p=0.95 acts");
  assert.equal(high.value, "yes", "p=0.95 acts yes");
  assert.deepEqual(high.costs, { yes: 0.5, no: 0.95, escalate: 1 });
});

test("decide tie-breaks toward escalate at the scope-lock costs 10/2/1", () => {
  const costs = { costFalseYes: 10, costFalseNo: 2, costEscalate: 1 };
  // p=0.5: act-no costs 1 and escalate costs 1. p=0.9: act-yes costs 1 and
  // escalate costs 1. Equal price → the human is the safer oracle.
  for (const p of [0.5, 0.9]) {
    const d = decide(p, costs);
    assert.equal(d.action, "escalate", `p=${p} is an exact tie and must reach the owner`);
    assert.equal(d.reason, "tie: escalate is not more expensive");
    assert.equal(d.costs.escalate, 1, "the priced costs stay visible on the result");
  }
  assert.deepEqual(decide(0.5, costs).costs, { yes: 5, no: 1, escalate: 1 });
  assert.deepEqual(decide(0.9, costs).costs, { yes: 1, no: 1.8, escalate: 1 });

  // Strictly cheaper acts still act: the tie-break only fires on equal price.
  assert.equal(decide(0.49, costs).action, "act");
  assert.equal(decide(0.49, costs).value, "no");
  assert.equal(decide(0.91, costs).action, "act");
  assert.equal(decide(0.91, costs).value, "yes");
  assert.equal(decide(0.95, costs).value, "yes");
  assert.equal(decide(0.8, costs).action, "escalate", "inside the band even without a tie");
});

test("decide with a default (Infinity) escalate price never escalates on a tie", () => {
  assert.deepEqual(decide(0.4, { costFalseYes: 1, costFalseNo: 1 }), {
    action: "act",
    value: "no",
    costs: { yes: 0.6, no: 0.4, escalate: null },
  });
  assert.equal(decide(0.9, { costFalseYes: 10, costFalseNo: 2 }).action, "act");
  assert.equal(decide(0.1, { costFalseYes: 1e9, costFalseNo: 1e9 }).action, "act", "no finite act ties Infinity");
});

test("calibration skips excluded rows so a corrected batch leaves the curve", () => {
  const records = [
    judgeRecord({ judgment_id: "a", confidence: 0.9, outcome: true }),
    judgeRecord({ judgment_id: "b", confidence: 0.9, outcome: false, excluded: true }),
  ];
  const bins = calibration(records, 5);
  assert.equal(bins.reduce((s, b) => s + b.n, 0), 1, "the excluded row leaves the bin");
  assert.equal(bins[0].observed, 1, "the surviving row is the one that was right");
  const kept = calibration([records[0]], 5);
  assert.deepEqual(bins, kept);
});

test("decisionOf returns the recorded sidecar or null", () => {
  assert.equal(decisionOf(judgeRecord()), null);
  const decided = judgeRecord({ decision: { action: "act", value: "no", pricedBy: "scope-lock" } });
  assert.deepEqual(decisionOf(decided), { action: "act", value: "no", pricedBy: "scope-lock" });
});

test("below minSample decide escalates even at p=0.9", () => {
  const d = decide(0.9, { costFalseYes: 10, costFalseNo: 10, costEscalate: 2, resolvedCount: 1, minSample: 5 });
  assert.equal(d.action, "escalate");
  assert.match(d.reason, /min-sample/);
  assert.equal(decide(0.9, { resolvedCount: 5, minSample: 5 }).action, "act");
});
