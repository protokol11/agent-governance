// Run: node --test test/explorer-state.test.mjs
// Drives the real state builder and the y/n decision. The v2 goldens hand
// ExplorerState literals to the renderer, so they cannot prove the queue
// filters, sorts or picks its group — this file does.
import assert from "node:assert/strict";
import test from "node:test";
import { nextGroup, openingGroup, toExplorerState } from "../explorer-state.ts";
import { planResolution } from "../core/resolve-plan.ts";
import { filterRows } from "../core/stats.ts";
import { judgeRecord } from "./fixtures.mjs";

const view = (overrides = {}) => ({
  view: "ledger",
  modelFilter: null,
  provenanceFilter: "judge",
  pendingOnly: true,
  questionGroup: null,
  selected: 0,
  message: null,
  help: false,
  height: 24,
  records: [],
  ...overrides,
});

// Mixed on purpose: two groups, pending and resolved rows in both, and the
// newest pending row (scope-lock) is not the oldest group by accident.
const ts = (clock) => `2026-10-27T${clock}:00.000Z`;
const RECORDS = [
  judgeRecord({ judgment_id: "r-1", ts: ts("07:10"), model: "a/a", question_id: "cp-review:CP-01", confidence: 0.9, outcome: true }),
  judgeRecord({ judgment_id: "r-2", ts: ts("08:02"), model: "b/b", question_id: "cp-review:CP-02", confidence: 0.4, outcome: null }),
  judgeRecord({ judgment_id: "r-3", ts: ts("09:14"), model: "a/a", question_id: "scope-lock", confidence: 0.92, outcome: null }),
  judgeRecord({ judgment_id: "r-4", ts: ts("06:45"), model: "b/b", question_id: "scope-lock", confidence: 0.31, outcome: false }),
  judgeRecord({ judgment_id: "r-5", ts: ts("10:30"), model: "a/a", question_id: "scope-lock", confidence: 0.5, outcome: true }),
  judgeRecord({ judgment_id: "r-6", ts: ts("05:00"), model: "a/a", question_id: "scope-lock", confidence: 0.7, outcome: null }),
  judgeRecord({ judgment_id: "r-7", ts: ts("04:00"), model: "c/c", question_id: "scope-lock", confidence: 0.2, outcome: true }),
];

// ── the y/n decision (P0-2) ────────────────────────────────────────────────

test("planResolution: a pending row is writable", () => {
  const rows = [{ ts: ts("09:14"), question_id: "scope-lock", value: "yes", confidence: 0.9, model: "a/a", provenance: "judge", outcome: null }];
  const plan = planResolution(rows, 0);
  assert.equal(plan.kind, "write");
  assert.equal(plan.row.question_id, "scope-lock");
});

test("planResolution: a resolved row says already-resolved and never writes", () => {
  for (const outcome of [true, false]) {
    const rows = [{ ts: ts("09:14"), question_id: "scope-lock", value: "yes", confidence: 0.9, model: "a/a", provenance: "judge", outcome }];
    const plan = planResolution(rows, 0);
    assert.equal(plan.kind, "already-resolved", `outcome ${outcome} must not be writable`);
    assert.equal(plan.row.outcome, outcome);
  }
});

test("planResolution: an empty list (or a stale cursor) is empty, not a write", () => {
  assert.deepEqual(planResolution([], 0), { kind: "empty" });
  const rows = [{ ts: ts("09:14"), question_id: "scope-lock", value: "yes", confidence: 0.9, model: "a/a", provenance: "judge", outcome: null }];
  assert.equal(planResolution(rows, 5).kind, "empty", "a selected past the end has no row to write");
});

// ── the queue (P0-3) ───────────────────────────────────────────────────────

test("queue state lists only pending rows, newest first, all from one group", () => {
  const state = toExplorerState(view({ records: RECORDS }), 24, 100);
  assert.equal(state.questionGroup, "scope-lock", "opens on the group holding the newest pending row");
  assert.deepEqual(
    state.rows.map((r) => r.ts),
    [ts("09:14"), ts("05:00")],
    "newest-first, and only the pending rows (10:30 / 07:10 / 06:45 / 04:00 are resolved)"
  );
  assert.ok(state.rows.every((r) => r.outcome === null), "no resolved row leaks into the queue");
  assert.deepEqual([...new Set(state.rows.map((r) => r.question_id.split(":")[0]))], ["scope-lock"], "one group only");
});

test("openingGroup follows the model filter, and the newest pending row wins", () => {
  // b/b's only pending row is cp-review:CP-02, so the opening group must follow
  // the filter rather than stay on the unfiltered newest group.
  assert.equal(openingGroup(RECORDS, "b/b", "judge"), "cp-review");
  assert.equal(openingGroup(RECORDS, null, "judge"), "scope-lock");
  assert.equal(openingGroup(RECORDS, "a/a", "judge"), "scope-lock");
  // A provenance with no rows at all still opens somewhere rather than nowhere.
  assert.equal(openingGroup(RECORDS, null, "code"), "scope-lock");
  assert.equal(openingGroup([], null, "judge"), null);
});

test("a group with zero pending rows falls back to its resolved rows (pendingFallback, intended)", () => {
  // Dropping both pending scope-lock rows leaves the group resolved-only: the
  // queue falls back to all its rows on purpose — an empty screen teaches nothing.
  const noPendingRows = RECORDS.filter((r) => typeof r.outcome === "boolean");
  const state = toExplorerState(view({ records: noPendingRows, questionGroup: "scope-lock" }), 24, 100);
  assert.ok(state.rows.length > 0, "the fallback fills the pane instead of showing nothing");
  assert.ok(state.rows.every((r) => r.outcome !== null), "the fallback rows are the resolved ones");
  assert.equal(state.pendingFallback, true, "and the header says so [all — no pending]");

  const pendingRecord = RECORDS.find((r) => r.judgment_id === "r-3");
  assert.ok(pendingRecord, "fixture sanity: scope-lock has a pending row before the filter");
  const onePending = toExplorerState(
    view({ records: RECORDS.filter((r) => r.judgment_id !== "r-3"), questionGroup: "scope-lock" }),
    24,
    100
  );
  assert.equal(onePending.pendingFallback, false, "a group that still has a pending row stays a queue");
  assert.ok(onePending.rows.every((r) => r.outcome === null), "and shows only pending rows");
});

test("g cycles only the groups present under the current model + provenance filter", () => {
  assert.equal(nextGroup(RECORDS, "scope-lock", "c/c", "judge"), "scope-lock", "one group under c/c: the cycle stays on it");
  assert.equal(nextGroup(RECORDS, "scope-lock", null, "judge"), "cp-review", "both groups present: wrap to the other");
  assert.equal(nextGroup(RECORDS, "cp-review", null, "judge"), "scope-lock", "and back round");
  assert.equal(nextGroup(RECORDS, "scope-lock", "rule", "judge"), null, "a model with no rows cycles nowhere");
  // Provenance narrows the cycle the same way: `code` holds nothing here.
  assert.equal(nextGroup(RECORDS, null, "a/a", "code"), null);
});

// ── filter parity through the state builder (P1-7) ─────────────────────────

test("state bins sum to the resolved rows of the same filter (parity through the builder)", () => {
  const state = toExplorerState(view({ records: RECORDS }), 24, 100);
  const resolved = filterRows(RECORDS, {
    pendingOnly: false,
    model: state.modelFilter,
    provenance: state.provenanceFilter,
    questionGroup: state.questionGroup,
  }).filter((r) => typeof r.outcome === "boolean").length;
  const binned = state.bins.reduce((sum, b) => sum + b.n, 0);
  assert.equal(binned, resolved, "the panes describe the same rows for the same filter");
  assert.equal(binned, 3, "fixture sanity: three resolved scope-lock judge rows behind the cursor's group");

  // The model filter narrows both sides together, not just the list.
  const filtered = toExplorerState(view({ records: RECORDS, modelFilter: "a/a" }), 24, 100);
  const resolvedA = filterRows(RECORDS, {
    pendingOnly: false,
    model: "a/a",
    provenance: filtered.provenanceFilter,
    questionGroup: filtered.questionGroup,
  }).filter((r) => typeof r.outcome === "boolean").length;
  assert.equal(filtered.bins.reduce((sum, b) => sum + b.n, 0), resolvedA);
});

test("toExplorerState clamps the cursor into the rows it just built", () => {
  const state = toExplorerState(view({ records: RECORDS, selected: 99 }), 24, 100);
  assert.equal(state.selected, state.rows.length - 1, "a stale cursor lands on the last row, not off the end");
  assert.equal(state.detail?.ts, state.rows[state.rows.length - 1].ts, "the detail pane follows the clamped cursor");
});
