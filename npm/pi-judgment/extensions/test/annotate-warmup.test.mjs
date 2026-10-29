// Run: node --test test/annotate-warmup.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  WarmupAssertionError,
  existingRelabelIds,
  groupRows,
  planRelabels,
  selectWarmupRows,
} from "../tools/annotate-warmup.mjs";

// 2 items x 2 rows: the real batch is 22 x 18, so the test states its own shape.
const SHAPE = { expectedGroups: 2, expectedGroupSize: 2 };

function row(overrides = {}) {
  return {
    judgment_id: "j-1",
    ts: "2026-10-02T01:41:15.713Z",
    state_hash: "hash-w01",
    question_id: "cp-review:CP-01",
    type: "noul",
    instructions: "does this diff violate the principle?",
    criteria: ["yes", "no"],
    value: "no",
    confidence: 0.9,
    model: "mock/mock",
    provenance: "judge",
    // The bug: the resolution stored the violation flag, not judge correctness.
    outcome: false,
    ...overrides,
  };
}

// W01: CP-01 is a violation, CP-04 is not. W02: CP-05 is, CP-08 is not.
const ITEMS = [
  { item_id: "W01", known_outcomes: { "CP-01": true, "CP-04": false } },
  { item_id: "W02", known_outcomes: { "CP-05": true, "CP-08": false } },
];

function batch() {
  const rows = [
    // judge "yes" on a real violation: already right, no relabel.
    row({ judgment_id: "w01-cp01", state_hash: "hash-w01", question_id: "cp-review:CP-01", value: "yes", outcome: true }),
    // judge "no" on a clean diff: the claim is true, the row says false.
    row({ judgment_id: "w01-cp04", state_hash: "hash-w01", question_id: "cp-review:CP-04", value: "no", outcome: false }),
    // judge "no" on a real violation: the claim is false, the row says true.
    row({ judgment_id: "w02-cp05", state_hash: "hash-w02", question_id: "cp-review:CP-05", value: "no", outcome: true }),
    // judge "yes" on a clean diff: the claim is false, the row says false.
    row({ judgment_id: "w02-cp08", state_hash: "hash-w02", question_id: "cp-review:CP-08", value: "yes", outcome: false }),
  ];
  return rows;
}

function plan({ existing = new Set(), items = ITEMS, rows = batch() } = {}) {
  return planRelabels({
    groups: groupRows(rows),
    items,
    existing,
    folded: rows,
    ...SHAPE,
    ts: "t",
  });
}

test("groupRows keeps first-seen state_hash order", () => {
  const groups = groupRows(batch());
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((group) => group.map((entry) => entry.judgment_id)),
    [
      ["w01-cp01", "w01-cp04"],
      ["w02-cp05", "w02-cp08"],
    ]
  );
});

test("selectWarmupRows takes only the 2026-10-02 judge cp-review rows", () => {
  const rows = [
    ...batch(),
    row({ judgment_id: "other-day", ts: "2026-10-03T00:00:00.000Z" }),
    row({ judgment_id: "other-q", question_id: "scope-lock" }),
    row({ judgment_id: "code-row", provenance: "code" }),
    row({ judgment_id: "pending", outcome: null }),
  ];
  assert.deepEqual(
    selectWarmupRows(rows).map((entry) => entry.judgment_id),
    ["w01-cp01", "w01-cp04", "w02-cp05", "w02-cp08"]
  );
});

test("corrected outcome is judge correctness for judge-yes and judge-no", () => {
  const { relabels, perItem } = plan();
  const byId = new Map(relabels.map((entry) => [entry.judgment_id, entry]));

  // judge "yes" + violation true: correct true, row already true -> no relabel.
  assert.equal(byId.has("w01-cp01"), false);
  // judge "no" + violation false: correct true, row false -> relabel to true.
  assert.equal(byId.get("w01-cp04").outcome, true);
  // judge "no" + violation true: correct false, row true -> relabel to false.
  assert.equal(byId.get("w02-cp05").outcome, false);
  // judge "yes" + violation false: correct false, row already false -> no relabel.
  assert.equal(byId.has("w02-cp08"), false);

  assert.equal(relabels.length, 2);
  assert.deepEqual(
    perItem.map((entry) => [entry.item_id, entry.rows, entry.relabels, entry.skipped]),
    [
      ["W01", 2, 1, 0],
      ["W02", 2, 1, 0],
    ]
  );
});

test("a relabel carries source, reason and op so a re-run can skip it", () => {
  const [first] = plan().relabels;
  assert.equal(first.op, "relabel");
  assert.equal(first.source, "corpus:.scratch/calibration-warmup");
  assert.match(first.reason, /known_outcomes was stored as outcome/);
  assert.equal(first.ts, "t");
});

test("an already-annotated row is skipped, not relabeled twice", () => {
  const { relabels, perItem, skipped } = plan({ existing: new Set(["w01-cp04", "w02-cp05"]) });
  assert.equal(relabels.length, 0, "a second run appends nothing");
  assert.equal(skipped, 2);
  assert.deepEqual(
    perItem.map((entry) => [entry.item_id, entry.relabels, entry.skipped]),
    [
      ["W01", 0, 1],
      ["W02", 0, 1],
    ]
  );
});

test("existingRelabelIds reads only relabel lines from this corpus", () => {
  const lines = [
    JSON.stringify({ kind: "annotation", judgment_id: "a", op: "relabel", source: "corpus:.scratch/calibration-warmup", outcome: true, reason: "r", ts: "t" }),
    JSON.stringify({ kind: "annotation", judgment_id: "b", op: "relabel", source: "owner", outcome: true, reason: "r", ts: "t" }),
    JSON.stringify({ kind: "annotation", judgment_id: "c", op: "exclude", source: "corpus:.scratch/calibration-warmup", reason: "r", ts: "t" }),
    JSON.stringify({ kind: "judgment", judgment_id: "d", outcome: false }),
    "{ torn line",
    "",
  ];
  assert.deepEqual([...existingRelabelIds(lines)], ["a"]);
});

test("a CP-set mismatch aborts before any relabel is planned", () => {
  const items = [
    { item_id: "W01", known_outcomes: { "CP-01": true, "CP-04": false } },
    // W02 claims CP-99, the ledger group answers CP-08.
    { item_id: "W02", known_outcomes: { "CP-05": true, "CP-99": false } },
  ];
  assert.throws(() => plan({ items }), (error) => {
    assert.ok(error instanceof WarmupAssertionError);
    assert.match(error.message, /W02: CP set mismatch/);
    assert.match(error.message, /extra: CP-08/);
    assert.match(error.message, /missing: CP-99/);
    return true;
  });
});

test("a wrong group size aborts", () => {
  const rows = [...batch(), row({ judgment_id: "w02-extra", state_hash: "hash-w02", question_id: "cp-review:CP-09" })];
  assert.throws(() => plan({ rows }), (error) => {
    assert.match(error.message, /W02: expected 2 rows, found 3/);
    return true;
  });
});

test("a wrong group count aborts", () => {
  const rows = batch().filter((entry) => entry.state_hash === "hash-w01");
  assert.throws(() => plan({ rows }), (error) => {
    assert.match(error.message, /expected 2 state_hash groups, found 1/);
    return true;
  });
});
