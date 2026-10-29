// Run: node --test test/stats.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { binsFor, filterRows, judgmentStats, nextProvenance, pendingRecords, questionGroup, questionGroups } from "../core/stats.ts";
import { judgeRecord } from "./fixtures.mjs";

// The real ExplorerFilter shape: `provenance` is a concrete family (the curve is
// one provenance at a time), judge by default. Tests that care about another
// family pass it explicitly.
const filter = (overrides = {}) => ({
  pendingOnly: false,
  model: null,
  provenance: "judge",
  questionGroup: null,
  ...overrides,
});

const LEDGER = [
  judgeRecord({ model: "a/a", question_id: "scope-lock", confidence: 0.9, outcome: true }),
  judgeRecord({ model: "a/a", question_id: "scope-lock", confidence: 0.95, outcome: false }),
  judgeRecord({ model: "b/b", question_id: "verify", confidence: 0.7, outcome: null }),
  judgeRecord({ model: "b/b", question_id: "verify", confidence: 0.1, outcome: true, provenance: "code" }),
];

test("judgmentStats counts resolved/pending, models, per-question", () => {
  const s = judgmentStats(LEDGER);
  assert.deepEqual(
    { total: s.total, resolved: s.resolved, pending: s.pending },
    { total: 4, resolved: 3, pending: 1 }
  );
  assert.deepEqual(s.models, ["a/a", "b/b"]);
  assert.equal(s.byQuestion[0].question_id, "scope-lock");
  assert.equal(s.byQuestion[0].resolved, 2);
});

test("binsFor scopes to one model and delegates binning to policy", () => {
  const bins = binsFor(LEDGER, filter({ model: "a/a" }), 2);
  assert.equal(bins.reduce((s, b) => s + b.n, 0), 2, "only model a/a resolved judge records");
  assert.equal(binsFor(LEDGER, filter(), 2).reduce((s, b) => s + b.n, 0), 2, "code records stay out of the model curve");
});

test("binsFor selects one provenance so the classifier curve stays separate", () => {
  const ledger = [
    judgeRecord({ model: "rlcd-local/cell-coder-1.5b", question_id: "cp-review:CP-22", confidence: 0.9, outcome: true, provenance: "classifier" }),
    judgeRecord({ model: "rlcd-local/cell-coder-1.5b", question_id: "cp-review:CP-22", confidence: 0.1, outcome: false, provenance: "judge" }),
  ];
  const model = "rlcd-local/cell-coder-1.5b";
  assert.equal(binsFor(ledger, filter({ model, provenance: "classifier" }), 2).reduce((s, b) => s + b.n, 0), 1);
  assert.equal(binsFor(ledger, filter({ model, provenance: "judge" }), 2).reduce((s, b) => s + b.n, 0), 1);
  assert.equal(binsFor(ledger, filter({ model }), 2).reduce((s, b) => s + b.n, 0), 1, "default stays judge");
});

test("pendingRecords and filterRows", () => {
  assert.equal(pendingRecords(LEDGER).length, 1);
  assert.equal(filterRows(LEDGER, filter({ pendingOnly: true })).length, 1);
  assert.equal(filterRows(LEDGER, filter({ model: "b/b" })).length, 1, "b/b holds one judge row; its code row is another family");
  assert.equal(filterRows(LEDGER, filter({ model: "b/b", provenance: "code" })).length, 1, "the code row is reachable, one family at a time");
  assert.equal(filterRows(LEDGER, filter({ pendingOnly: true, model: "a/a" })).length, 0);
});

test("judgmentStats reports excluded and drops it from pending", () => {
  const ledger = [
    ...LEDGER,
    judgeRecord({ question_id: "verify", confidence: 0.8, outcome: null, excluded: true }),
  ];
  const s = judgmentStats(ledger);
  assert.equal(s.total, 5, "total stays the ledger row count");
  assert.equal(s.excluded, 1);
  assert.equal(s.pending, 1, "an excluded row needs no review");
  assert.equal(judgmentStats(LEDGER).excluded, 0);
});

test("judgmentStats keeps total === resolved + pending + excluded with an excluded resolved row", () => {
  const ledger = [
    ...LEDGER,
    judgeRecord({ question_id: "verify", confidence: 0.8, outcome: null, excluded: true }),
    judgeRecord({ question_id: "verify", confidence: 0.6, outcome: true, excluded: true }),
  ];
  const s = judgmentStats(ledger);
  assert.equal(s.total, 6, "total stays the ledger row count");
  assert.equal(s.excluded, 2, "every excluded row counts, whatever its outcome");
  assert.equal(s.resolved, 3, "an excluded RESOLVED row leaves resolved");
  assert.equal(s.pending, 1, "an excluded PENDING row leaves pending");
  assert.equal(
    s.total,
    s.resolved + s.pending + s.excluded,
    "the header must reconcile: total === resolved + pending + excluded"
  );
  const verify = s.byQuestion.find((q) => q.question_id === "verify");
  assert.equal(verify.total, 2, "per-question totals skip excluded rows so they match the header");
  assert.equal(verify.resolved, 1);
  assert.equal(verify.pending, 1);
  assert.equal(
    s.byQuestion.reduce((sum, q) => sum + q.total, 0),
    s.resolved + s.pending,
    "per-question totals add up to the header's non-excluded rows"
  );
});

test("filterRows hides excluded rows unless asked", () => {
  const ledger = [
    ...LEDGER,
    judgeRecord({ model: "a/a", confidence: 0.8, outcome: true, excluded: true }),
  ];
  assert.equal(filterRows(ledger, filter()).length, 3, "default hides the excluded row (code row is out: judge provenance)");
  assert.equal(filterRows(ledger, filter({ includeExcluded: true })).length, 4);
  assert.equal(filterRows(ledger, filter({ model: "a/a" })).length, 2);
  assert.equal(filterRows(ledger, filter({ model: "a/a", includeExcluded: true })).length, 3);
});

test("filterRows: pendingOnly filters on the outcome, includeExcluded is the only excluded gate", () => {
  const ledger = [
    judgeRecord({ model: "a/a", question_id: "verify", outcome: null }),
    judgeRecord({ model: "a/a", question_id: "verify", outcome: null, excluded: true }),
    judgeRecord({ model: "a/a", question_id: "verify", outcome: true, excluded: true }),
  ];
  assert.deepEqual(
    filterRows(ledger, filter({ pendingOnly: true })).map((r) => r.excluded),
    [undefined],
    "default hides excluded rows from the pending view"
  );
  assert.deepEqual(
    filterRows(ledger, filter({ pendingOnly: true, includeExcluded: true })).map((r) => r.excluded),
    [undefined, true],
    "includeExcluded opts the pending row back in; a resolved excluded row stays out"
  );
  assert.equal(
    filterRows(ledger, filter({ includeExcluded: true })).length,
    3,
    "includeExcluded shows every excluded row when pendingOnly is off"
  );
});

test("questionGroup is the text before the first colon", () => {
  assert.equal(questionGroup("cp-review:CP-22"), "cp-review");
  assert.equal(questionGroup("scope-lock"), "scope-lock");
  assert.equal(questionGroup("a:b:c"), "a");
});

test("questionGroups counts pending and total, skipping excluded rows", () => {
  const ledger = [
    judgeRecord({ question_id: "cp-review:CP-01", outcome: null }),
    judgeRecord({ question_id: "cp-review:CP-02", outcome: true }),
    judgeRecord({ question_id: "cp-review:CP-03", outcome: null, excluded: true }),
    judgeRecord({ question_id: "scope-lock", outcome: null }),
  ];
  assert.deepEqual(questionGroups(ledger), [
    { group: "cp-review", pending: 1, total: 2 },
    { group: "scope-lock", pending: 1, total: 1 },
  ]);
});

// One fixture, mixed on purpose: three judge rows and two classifier rows (both
// fully resolved, different counts so the parity check cannot pass trivially),
// plus code rows that are part resolved / part pending.
const MIXED = [
  judgeRecord({ model: "a/a", question_id: "cp-review:CP-01", confidence: 0.9, outcome: true }),
  judgeRecord({ model: "a/a", question_id: "cp-review:CP-02", confidence: 0.4, outcome: false }),
  judgeRecord({ model: "b/b", question_id: "cp-review:CP-03", confidence: 0.7, outcome: true }),
  judgeRecord({ model: "c/c", question_id: "cp-review:CP-04", confidence: 0.8, outcome: true, provenance: "classifier" }),
  judgeRecord({ model: "c/c", question_id: "cp-review:CP-05", confidence: 0.2, outcome: false, provenance: "classifier" }),
  judgeRecord({ model: "rule", question_id: "scope-lock", confidence: 0.5, outcome: true, provenance: "code" }),
  judgeRecord({ model: "rule", question_id: "scope-lock", confidence: 0.5, outcome: null, provenance: "code" }),
  judgeRecord({ model: "a/a", question_id: "verify", confidence: 0.6, outcome: null, provenance: "code" }),
];

const binned = (records, f) => binsFor(records, f, 5).reduce((s, b) => s + b.n, 0);

test("filter parity: rows behind the bins equal filterRows with pendingOnly off", () => {
  // Same filter object on both sides; only pendingOnly differs, which bins must
  // ignore. Asserted per provenance so a wrong provenance gate cannot hide.
  for (const provenance of ["judge", "classifier"]) {
    const f = filter({ provenance });
    assert.equal(
      filterRows(MIXED, { ...f, pendingOnly: false }).length,
      binned(MIXED, f),
      `one predicate keeps the list and the bins in step for ${provenance}`
    );
  }
  // ...and the two provenances really do bin different counts.
  assert.equal(binned(MIXED, filter({ provenance: "judge" })), 3);
  assert.equal(binned(MIXED, filter({ provenance: "classifier" })), 2);
});

test("the provenance gate is real: a code row never lands in the judge curve", () => {
  // The code rows are listed (rows keep pending rows) but the bins drop them.
  assert.equal(filterRows(MIXED, filter({ provenance: "code" })).length, 3, "1 resolved + 2 pending code rows");
  assert.equal(binned(MIXED, filter({ provenance: "code" })), 1, "bins take resolved rows only");
  assert.ok(
    filterRows(MIXED, filter({ provenance: "code", pendingOnly: true })).length <
      filterRows(MIXED, filter({ provenance: "code", pendingOnly: false })).length,
    "pendingOnly narrows the code rows"
  );
  assert.ok(
    filterRows(MIXED, filter({ provenance: "judge", pendingOnly: true })).length <
      filterRows(MIXED, filter({ provenance: "judge", pendingOnly: false })).length,
    "pendingOnly narrows the judge rows too (no judge row is pending here, so 0 < 3)"
  );
});

test("p cycles every provenance present in the ledger, judge included", () => {
  // The ledger holds three of the five families; `p` must reach each of them
  // and come back round, so `code` / `classifier` rows are not stranded.
  const present = MIXED.map((r) => r.provenance);
  const walk = [];
  let current = "judge";
  for (let i = 0; i < 3; i++) {
    current = nextProvenance(present, current);
    walk.push(current);
  }
  assert.deepEqual(walk, ["classifier", "code", "judge"], "sorted, wrapping cycle over the present families");
  assert.deepEqual([...new Set(walk)].sort(), ["classifier", "code", "judge"], "every present provenance is reachable");
  assert.equal(nextProvenance([], "judge"), "judge", "an empty ledger keeps the current family");
  assert.equal(nextProvenance(["code", "human", "code"], "prose"), "code", "an absent current value lands on the first present one");
  assert.equal(
    nextProvenance(["judge", "human", "classifier", "code", "prose"], "prose"),
    "classifier",
    "all five families are in the cycle, so `human` rows are reachable"
  );
});

test("questionGroup filter narrows rows to one family", () => {
  const ledger = [
    judgeRecord({ question_id: "cp-review:CP-01", outcome: null }),
    judgeRecord({ question_id: "scope-lock", outcome: null }),
  ];
  assert.deepEqual(
    filterRows(ledger, filter({ questionGroup: "cp-review" })).map((r) => r.question_id),
    ["cp-review:CP-01"]
  );
  assert.equal(filterRows(ledger, filter({ questionGroup: "missing" })).length, 0);
});

// The queue applies model, provenance and group at once, so parity has to hold for
// the combination, not just one key at a time. If binsFor ever grew its own
// predicate, these counts would drift apart.
test("filter parity across model, provenance and group: the bins see the list's rows", () => {
  const cases = [
    filter({ model: "a/a", questionGroup: "cp-review" }),
    filter({ model: "rule", questionGroup: "scope-lock", provenance: "code" }),
    filter({ questionGroup: "cp-review", provenance: "classifier" }),
  ];
  for (const f of cases) {
    const listed = filterRows(MIXED, f);
    const resolved = listed.filter((r) => typeof r.outcome === "boolean").length;
    assert.equal(binned(MIXED, f), resolved, `bins count the resolved rows of ${JSON.stringify(f)}`);
    assert.equal(
      listed.length,
      filterRows(MIXED, { ...f, pendingOnly: false }).length,
      "pendingOnly off lists the same set"
    );
  }
  assert.equal(filterRows(MIXED, filter({ model: "rule", questionGroup: "scope-lock", provenance: "code" })).length, 2);
  assert.equal(filterRows(MIXED, filter({ questionGroup: "scope-lock", provenance: "code", pendingOnly: true })).length, 1, "the group filter keeps the pending row in the queue");
  // The subset is real, so the parity above is not passing on the whole ledger.
  assert.ok(binned(MIXED, filter({ model: "b/b" })) < binned(MIXED, filter()));
  assert.ok(
    filterRows(MIXED, filter({ questionGroup: "scope-lock", provenance: "code" })).length <
      filterRows(MIXED, filter({ provenance: "code" })).length,
    "the group filter narrows the listed rows, not only the model does"
  );
});

// The renderer is pure over the ledger: a filter or a bin must never rewrite the
// `outcome` field it is reading (that field is the human verdict, ADR-0045).
// Before/after compare AND a deep freeze, so a write throws instead of drifting.
test("stats never mutates a record's outcome: filterRows + binsFor + questionGroups are read-only", () => {
  const build = () => [
    judgeRecord({ judgment_id: "m-1", model: "a/a", question_id: "cp-review:CP-01", confidence: 0.9, outcome: true }),
    judgeRecord({ judgment_id: "m-2", model: "a/a", question_id: "cp-review:CP-02", confidence: 0.4, outcome: false }),
    judgeRecord({ judgment_id: "m-3", model: "b/b", question_id: "verify", confidence: 0.7, outcome: null }),
    judgeRecord({ judgment_id: "m-4", model: "b/b", question_id: "verify", confidence: 0.2, outcome: true, provenance: "code" }),
    judgeRecord({ judgment_id: "m-5", model: "b/b", question_id: "verify", confidence: 0.6, outcome: null, excluded: true }),
  ];
  const deepFreeze = (value) => {
    if (value && typeof value === "object") {
      for (const key of Object.keys(value)) deepFreeze(value[key]);
      Object.freeze(value);
    }
    return value;
  };
  const records = deepFreeze(build());
  const before = build().map((r) => ({ id: r.judgment_id, outcome: r.outcome, excluded: r.excluded }));

  const filters = [
    filter(),
    filter({ pendingOnly: true }),
    filter({ model: "a/a", questionGroup: "cp-review" }),
    filter({ provenance: "code" }),
    filter({ includeExcluded: true }),
  ];
  for (const f of filters) {
    filterRows(records, f);
    binsFor(records, f, 5);
  }
  questionGroups(records);
  judgmentStats(records);

  const after = records.map((r) => ({ id: r.judgment_id, outcome: r.outcome, excluded: r.excluded }));
  assert.deepEqual(after, before, "no record's outcome/excluded changed under any filter or bin");
  assert.deepEqual(
    records.map((r) => r.outcome),
    [true, false, null, true, null],
    "pending rows are still pending after the pass"
  );
});
