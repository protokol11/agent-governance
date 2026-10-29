// Run: node --test test/lint-cp50.test.mjs
// Replay test for the example synthesized lint: the pattern every promoted
// rule must follow — a pure predicate scored against resolved fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { predicate, ruleId } from "../lints/cp50-types-carry-invariant.ts";
import { replay } from "../core/mine.ts";
import { record } from "./fixtures.mjs";

test("example lint CP-50 flags type escape hatches and replays at its accuracy", () => {
  assert.equal(ruleId, "CP-50");
  const records = [
    record({ judgment_id: "v1", instructions: "returns any here", outcome: true }),
    record({ judgment_id: "v2", instructions: "typed enum, no escape hatch", outcome: false }),
    record({ judgment_id: "v3", instructions: "uses @ts-ignore", outcome: true }),
    record({ judgment_id: "v4", instructions: "unknown escape hatch", outcome: false }),
  ];
  const report = replay(predicate, records);
  assert.equal(report.n, 4);
  assert.equal(report.accuracy, 0.75);
  assert.deepEqual(report.mismatches, ["v4"]);
});
