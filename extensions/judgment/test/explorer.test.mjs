// Run: node --test test/explorer.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { offsetFor, renderJudgments, wrapText } from "../explorer.ts";

function state(overrides = {}) {
  return {
    stats: { total: 2, resolved: 1, pending: 1, models: ["a/a"] },
    view: "ledger",
    bins: [],
    modelFilter: null,
    provenanceFilter: "judge",
    pendingOnly: false,
    questionTotals: [{ question_id: "scope-lock", total: 2, resolved: 1 }],
    rows: [
      { ts: "2026-10-01T21:02:00Z", question_id: "scope-lock", value: "yes", confidence: 0.98, model: "a/a", provenance: "judge", outcome: null },
      { ts: "2026-10-01T20:44:00Z", question_id: "scope-lock", value: "yes", confidence: 0.5, model: "a/a", provenance: "code", outcome: true },
    ],
    selected: 0,
    detail: null,
    message: null,
    height: 24,
    pendingFallback: false,
    width: 100,
    offset: 0,
    help: false,
    questionGroup: null,
    questionGroups: [],
    ...overrides,
  };
}

const text = (lines) => lines.map((line) => line.map((s) => s.text).join(""));

test("header shows counts and pending is accented", () => {
  const lines = text(renderJudgments(state()));
  assert.ok(lines[0].includes("2 records"));
  assert.ok(lines[0].includes("1 PENDING"));
});

test("empty ledger renders zero-state hint, not a crash", () => {
  const lines = text(renderJudgments(state({ stats: { total: 0, resolved: 0, pending: 0, models: [] }, rows: [], questionTotals: [] })));
  assert.ok(lines.some((l) => l.includes("no judgments yet")));
});

test("empty filter result shows hint; pending fallback is labeled", () => {
  const empty = text(renderJudgments(state({ rows: [] })));
  assert.ok(empty.some((l) => l.includes("no rows match the filter")));
  const fallback = text(renderJudgments(state({ pendingFallback: true })));
  assert.ok(fallback.some((l) => l.includes("[all — no pending]")));
});

test("ledger rows include clock, question, p, provenance, outcome marker", () => {
  const lines = text(renderJudgments(state()));
  const row = lines.find((l) => l.includes("21:02"));
  assert.ok(row.includes("scope-lock"));
  assert.ok(row.includes("0.98"));
  assert.ok(row.includes("PENDING"));
  const resolvedRow = lines.find((l) => l.includes("20:44"));
  assert.ok(resolvedRow.includes("true"));
  assert.ok(resolvedRow.includes("code"), "degraded records are labeled");
});

test("calibration view flags overconfidence gap > 0.1 with n >= 5", () => {
  const bins = [{ lo: 0.6, hi: 0.8, n: 18, predicted: 0.7, observed: 0.55 }];
  const lines = text(renderJudgments(state({ view: "calibration", bins })));
  assert.ok(lines.some((l) => l.includes("gap=0.15") && l.includes("⚠")));
  const safe = [{ lo: 0.6, hi: 0.8, n: 2, predicted: 0.7, observed: 0.55 }];
  assert.ok(text(renderJudgments(state({ view: "calibration", bins: safe }))).every((l) => !l.includes("⚠")), "small n is not flagged");
});

test("offsetFor keeps the selected row inside the window", () => {
  assert.equal(offsetFor(0, 50, 10), 0);
  assert.equal(offsetFor(9, 50, 10), 0);
  assert.equal(offsetFor(10, 50, 10), 1);
  const offset = offsetFor(30, 50, 10);
  assert.equal(offset, 21);
  assert.ok(30 >= offset && 30 <= offset + 10 - 1, "row 30 is inside the window");
  assert.equal(offsetFor(49, 50, 10), 40, "clamped so the window ends on the last row");
  assert.equal(offsetFor(0, 0, 10), 0, "empty list never scrolls");
  assert.equal(offsetFor(5, 3, 10), 0, "a body larger than the list pins to zero");
});

test("width contract: no rendered line exceeds 120/100/72 columns", () => {
  for (const width of [120, 100, 72]) {
    for (const st of [state(), state({ view: "calibration" }), state({ stats: { total: 0, resolved: 0, pending: 0, models: [] }, rows: [], questionTotals: [] })]) {
      for (const line of text(renderJudgments(st))) {
        assert.ok(line.length <= width, `line exceeds ${width}: "${line}"`);
      }
    }
  }
});

// ── v2: queue, window, detail, help (spec steps 4–8) ────────────────────────
// The fixtures below are the five states the spec asks to pin at 120/100/72.
// The excerpt is long on purpose: it must wrap differently at each width.

const EXCERPT =
  "WILL touch: explorer.ts, commands.ts, test/explorer.test.mjs. WILL NOT touch: core/stats.ts, index.ts, package.json. Success: tsc 0 errors and node --test green.";

const ROW = (o = {}) => ({
  ts: "2026-10-27T09:14:00Z",
  question_id: "scope-lock",
  value: "yes",
  confidence: 0.92,
  model: "a/a",
  provenance: "judge",
  outcome: null,
  ...o,
});

const QUEUE_ROWS = [
  ROW({
    instructions: "Does this change stay inside the declared scope?",
    decision: { action: "allow", value: "yes", pricedBy: "scope-lock" },
    state_excerpt: EXCERPT,
  }),
  ROW({ ts: "2026-10-27T08:02:00Z", value: "no", confidence: 0.44, model: "b/b", instructions: "Does this change stay inside the declared scope?" }),
];

const QUEUE_GROUPS = [
  { group: "cp-review", pending: 0, total: 401 },
  { group: "scope-lock", pending: 12, total: 142 },
];

const FIVE_STATES = {
  queue: (width) => state({ width, rows: QUEUE_ROWS, detail: QUEUE_ROWS[0], questionGroup: "scope-lock", questionGroups: QUEUE_GROUPS, pendingOnly: true, stats: { total: 543, resolved: 531, pending: 12, models: ["a/a", "b/b"] } }),
  filteredEmpty: (width) => state({ width, rows: [], detail: null, questionGroup: "cp-review", questionGroups: QUEUE_GROUPS, pendingOnly: true, stats: { total: 543, resolved: 531, pending: 12, models: ["a/a", "b/b"] } }),
  calibration: (width) => state({
    width,
    view: "calibration",
    rows: QUEUE_ROWS,
    detail: null,
    questionGroup: "scope-lock",
    questionGroups: QUEUE_GROUPS,
    pendingOnly: true,
    stats: { total: 543, resolved: 531, pending: 12, models: ["a/a", "b/b"] },
    bins: [{ lo: 0.8, hi: 1.0, n: 18, predicted: 0.91, observed: 0.78 }],
    questionTotals: [
      { question_id: "scope-lock", total: 142, resolved: 130 },
      { question_id: "cp-review:CP-22", total: 401, resolved: 401 },
    ],
  }),
  help: (width) => state({ width, help: true, rows: QUEUE_ROWS, detail: QUEUE_ROWS[0], questionGroup: "scope-lock", questionGroups: QUEUE_GROUPS, pendingOnly: true, stats: { total: 543, resolved: 531, pending: 12, models: ["a/a", "b/b"] } }),
  zero: (width) => state({ width, stats: { total: 0, resolved: 0, pending: 0, models: [] }, rows: [], detail: null, questionTotals: [], questionGroups: [], questionGroup: null }),
};

const GOLDEN = {
  queue: {
    "120": [
      " judgments 2 models · 543 records · 531 resolved · 12 PENDING",
      "",
      " LEDGER  [pending only] model: all   [tab: calibration]",
      " groups: cp-review 0/401 · [scope-lock 12/142]",
      "→ 09:14 scope-lock     yes    0.92  judge PENDING",
      "  08:02 scope-lock     no     0.44  judge PENDING",
      "────────────────────────────────────────────────────────────",
      "  scope-lock  Does this change stay inside the declared scope?",
      "  model=a/a  provenance=judge  PENDING",
      "  decision: allow value=yes",
      "  WILL touch: explorer.ts, commands.ts, test/explorer.test.mjs. WILL NOT touch: core/stats.ts, index.ts,",
      "  package.json. Success: tsc 0 errors and node --test green.",
      " ? help · q close",
    ],
    "100": [
      " judgments 2 models · 543 records · 531 resolved · 12 PENDING",
      "",
      " LEDGER  [pending only] model: all   [tab: calibration]",
      " groups: cp-review 0/401 · [scope-lock 12/142]",
      "→ 09:14 scope-lock     yes    0.92  judge PENDING",
      "  08:02 scope-lock     no     0.44  judge PENDING",
      "────────────────────────────────────────────────────────────",
      "  scope-lock  Does this change stay inside the declared scope?",
      "  model=a/a  provenance=judge  PENDING",
      "  decision: allow value=yes",
      "  WILL touch: explorer.ts, commands.ts, test/explorer.test.mjs. WILL NOT touch: core/stats.ts,",
      "  index.ts, package.json. Success: tsc 0 errors and node --test green.",
      " ? help · q close",
    ],
    "72": [
      " judgments 2 models · 543 records · 531 resolved · 12 PENDING",
      "",
      " LEDGER  [pending only] model: all   [tab: calibration]",
      " groups: cp-review 0/401 · [scope-lock 12/142]",
      "→ 09:14 scope-lock     yes    0.92  judge PENDING",
      "  08:02 scope-lock     no     0.44  judge PENDING",
      "────────────────────────────────────────────────────────────",
      "  scope-lock  Does this change stay inside the declared scope?",
      "  model=a/a  provenance=judge  PENDING",
      "  decision: allow value=yes",
      "  WILL touch: explorer.ts, commands.ts, test/explorer.test.mjs. WILL",
      "  NOT touch: core/stats.ts, index.ts, package.json. Success: tsc 0",
      "  errors and node --test green.",
      " ? help · q close",
    ],
  },
  filteredEmpty: {
    "120": [
      " judgments 2 models · 543 records · 531 resolved · 12 PENDING",
      "",
      " LEDGER  [pending only] model: all   [tab: calibration]",
      " groups: [cp-review 0/401] · scope-lock 12/142",
      "  no rows match the filter — f: toggle pending, m: cycle model",
      "────────────────────────────────────────────────────────────",
      "  (no selection)",
      " ? help · q close",
    ],
    "100": [
      " judgments 2 models · 543 records · 531 resolved · 12 PENDING",
      "",
      " LEDGER  [pending only] model: all   [tab: calibration]",
      " groups: [cp-review 0/401] · scope-lock 12/142",
      "  no rows match the filter — f: toggle pending, m: cycle model",
      "────────────────────────────────────────────────────────────",
      "  (no selection)",
      " ? help · q close",
    ],
    "72": [
      " judgments 2 models · 543 records · 531 resolved · 12 PENDING",
      "",
      " LEDGER  [pending only] model: all   [tab: calibration]",
      " groups: [cp-review 0/401] · scope-lock 12/142",
      "  no rows match the filter — f: toggle pending, m: cycle model",
      "────────────────────────────────────────────────────────────",
      "  (no selection)",
      " ? help · q close",
    ],
  },
  calibration: {
    "120": [
      " judgments 2 models · 543 records · 531 resolved · 12 PENDING",
      "",
      " CALIBRATION model: all  prov: judge   [tab: ledger]",
      "  p 0.8-1.0  n= 18  pred=0.91  obs=0.78  gap=0.13 ⚠",
      "",
      " by question",
      "  scope-lock                 total=142  resolved=130",
      "  cp-review:CP-22            total=401  resolved=401",
      "────────────────────────────────────────────────────────────",
      "  (no selection)",
      " ? help · q close",
    ],
    "100": [
      " judgments 2 models · 543 records · 531 resolved · 12 PENDING",
      "",
      " CALIBRATION model: all  prov: judge   [tab: ledger]",
      "  p 0.8-1.0  n= 18  pred=0.91  obs=0.78  gap=0.13 ⚠",
      "",
      " by question",
      "  scope-lock                 total=142  resolved=130",
      "  cp-review:CP-22            total=401  resolved=401",
      "────────────────────────────────────────────────────────────",
      "  (no selection)",
      " ? help · q close",
    ],
    "72": [
      " judgments 2 models · 543 records · 531 resolved · 12 PENDING",
      "",
      " CALIBRATION model: all  prov: judge   [tab: ledger]",
      "  p 0.8-1.0  n= 18  pred=0.91  obs=0.78  gap=0.13 ⚠",
      "",
      " by question",
      "  scope-lock                 total=142  resolved=130",
      "  cp-review:CP-22            total=401  resolved=401",
      "────────────────────────────────────────────────────────────",
      "  (no selection)",
      " ? help · q close",
    ],
  },
  help: {
    "120": [
      " judgments 2 models · 543 records · 531 resolved · 12 PENDING",
      "",
      " HELP",
      "  ↑ / ↓        move the cursor one row",
      "  tab          switch ledger / calibration",
      "  y            the claim was true — record that verdict",
      "  n            the claim was false — record that verdict",
      "  f            toggle pending-only",
      "  m            cycle the model filter",
      "  p            cycle the provenance filter",
      "  g            cycle the question group",
      "  pgup / pgdn  move one page",
      "  home / end   jump to the first / last row",
      "  ?            toggle this help",
      "  q / esc      close the explorer",
      '  y/n write only on a PENDING row; a resolved row says "already resolved".',
      "",
      " ? help · q close",
    ],
    "100": [
      " judgments 2 models · 543 records · 531 resolved · 12 PENDING",
      "",
      " HELP",
      "  ↑ / ↓        move the cursor one row",
      "  tab          switch ledger / calibration",
      "  y            the claim was true — record that verdict",
      "  n            the claim was false — record that verdict",
      "  f            toggle pending-only",
      "  m            cycle the model filter",
      "  p            cycle the provenance filter",
      "  g            cycle the question group",
      "  pgup / pgdn  move one page",
      "  home / end   jump to the first / last row",
      "  ?            toggle this help",
      "  q / esc      close the explorer",
      '  y/n write only on a PENDING row; a resolved row says "already resolved".',
      "",
      " ? help · q close",
    ],
    "72": [
      " judgments 2 models · 543 records · 531 resolved · 12 PENDING",
      "",
      " HELP",
      "  ↑ / ↓        move the cursor one row",
      "  tab          switch ledger / calibration",
      "  y            the claim was true — record that verdict",
      "  n            the claim was false — record that verdict",
      "  f            toggle pending-only",
      "  m            cycle the model filter",
      "  p            cycle the provenance filter",
      "  g            cycle the question group",
      "  pgup / pgdn  move one page",
      "  home / end   jump to the first / last row",
      "  ?            toggle this help",
      "  q / esc      close the explorer",
      '  y/n write only on a PENDING row; a resolved row says "already resolve…',
      "",
      " ? help · q close",
    ],
  },
  zero: {
    "120": [
      " judgments 0 models · 0 records · 0 resolved · 0 PENDING",
      "",
      "no judgments yet — the ledger warms up as gates record decisions",
      "call judge / scope_lock, then return here to resolve outcomes",
      " ? help · q close",
    ],
    "100": [
      " judgments 0 models · 0 records · 0 resolved · 0 PENDING",
      "",
      "no judgments yet — the ledger warms up as gates record decisions",
      "call judge / scope_lock, then return here to resolve outcomes",
      " ? help · q close",
    ],
    "72": [
      " judgments 0 models · 0 records · 0 resolved · 0 PENDING",
      "",
      "no judgments yet — the ledger warms up as gates record decisions",
      "call judge / scope_lock, then return here to resolve outcomes",
      " ? help · q close",
    ],
  },
};

for (const [name, byWidth] of Object.entries(GOLDEN)) {
  test(`golden ${name} at 120/100/72`, () => {
    for (const [width, expected] of Object.entries(byWidth)) {
      const actual = text(renderJudgments(FIVE_STATES[name](Number(width))));
      assert.deepEqual(actual, expected, `${name} @ ${width}`);
      for (const line of actual) {
        assert.ok(line.length <= Number(width), `${name} @ ${width}: line too wide (${line.length}): "${line}"`);
      }
    }
  });
}

test("help panel names every key the footer legend advertises", () => {
  const lines = text(renderJudgments(FIVE_STATES.help(100)));
  const footer = lines[lines.length - 1];
  assert.equal(footer, " ? help · q close", "the legend shrinks to two hints");
  // Line-anchored: every key must open a row of the key column at the 2-space
  // indent. A bare `panel.includes("n")` is satisfied by the word PENDING.
  const panel = lines.slice(2, -2);
  const keys = ["↑ / ↓", "tab", "y", "n", "f", "m", "p", "g", "pgup / pgdn", "home / end", "?", "q / esc"];
  for (const key of keys) {
    const prefix = "  " + key.padEnd(13);
    assert.ok(panel.some((l) => l.startsWith(prefix)), `a help row must start with the padded key \`${key}\``);
  }
  assert.ok(panel.some((l) => l.includes("the claim was true")), "y means the claim was true");
  assert.ok(panel.some((l) => l.startsWith("  y/n ") && l.includes("already resolved")), "the note spells out the y/n write rule");
});

test("scroll: the window starts at the offset and keeps the selected row visible", () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    ROW({ ts: `2026-10-27T09:${String(59 - i).padStart(2, "0")}:00Z`, confidence: 0.5 })
  );
  const offset = offsetFor(30, 50, 10); // body for a 20-row screen
  const lines = text(
    renderJudgments(
      state({ width: 100, height: 20, rows: many, selected: 30, offset, detail: many[30], questionGroup: "scope-lock", questionGroups: QUEUE_GROUPS })
    )
  );
  assert.equal(offset, 21);
  const rowLines = lines.filter((l) => /^[→ ] \d{2}:\d{2} /.test(l));
  assert.equal(rowLines.length, 10, "height 20 leaves a body of 10 rows");
  assert.equal(rowLines[0].slice(0, 7), "  09:38", "the first drawn row is rows[21]");
  assert.equal(rowLines[9], "→ 09:29 scope-lock     yes    0.50  judge PENDING", "rows[30] is drawn and marked");
  assert.ok(lines.some((l) => l.includes("… 19 more")), "rows below the window are counted");
  assert.equal(lines[lines.length - 1], " ? help · q close", "the window never pushes the footer off screen");
});

test("detail pane shows the decision action and the wrapped excerpt", () => {
  const row = ROW({
    instructions: "Does this change stay inside the declared scope?",
    decision: { action: "allow", value: "yes" },
    state_excerpt: EXCERPT,
  });
  const lines = text(renderJudgments(state({ width: 72, rows: [row], detail: row })));
  const at = lines.indexOf("  decision: allow value=yes");
  assert.ok(at > 0, "the decision renders after the question/model lines");
  const body = lines.slice(at + 1, lines.indexOf(" ? help · q close"));
  assert.ok(body.length > 1, "the excerpt wraps instead of running off the line");
  for (const line of body) assert.ok(line.length <= 68, "wrapped to the inner width (72 - 4), indent included");
  assert.equal(body.map((l) => l.trim()).join(" "), EXCERPT, "wrapping loses no text at this height");

  // Engineered: 40 + 1 + 27 = 68 characters fit the OLD wrap width exactly, so
  // the greedy line would have been 70 columns once the 2-space indent landed on
  // it. The wrap must budget for that indent: 66 characters, 68 with the indent.
  const A = "A".repeat(40);
  const B = "B".repeat(27);
  const tight = ROW({ state_excerpt: `${A} ${B} tail` });
  const tightLines = text(renderJudgments(state({ width: 72, rows: [tight], detail: tight })));
  const firstExcerpt = tightLines.indexOf(`  model=a/a  provenance=judge  PENDING`) + 1;
  const tightBody = tightLines.slice(firstExcerpt, tightLines.indexOf(" ? help · q close"));
  assert.equal(tightBody[0], `  ${A}`, "the 68-character word pair cannot share a line: the indent costs 2");
  for (const line of tightBody) assert.ok(line.length <= 68, `a wrapped excerpt line must stay inside 68: "${line}" (${line.length})`);
  assert.ok(tightBody[1].startsWith(`  ${B}`), "the 27-character word moves to the next line instead of overflowing");

  const bare = text(renderJudgments(state({ width: 72, rows: [ROW()], detail: ROW() })));
  const sep = bare.findIndex((l) => l.startsWith("────"));
  assert.deepEqual(bare.slice(sep), [
    "────────────────────────────────────────────────────────────",
    "  scope-lock  was this claim true?",
    "  model=a/a  provenance=judge  PENDING",
    " ? help · q close",
  ], "no excerpt, no decision: nothing invented");

  const noValue = ROW({ decision: { action: "deny" } });
  const deny = text(renderJudgments(state({ width: 100, rows: [noValue], detail: noValue })));
  assert.ok(deny.includes("  decision: deny"), "a decision without a value still shows its action");
});

test("wrapText breaks on words and hard-splits a word wider than the line", () => {
  assert.deepEqual(wrapText("one two three", 7), ["one two", "three"]);
  assert.deepEqual(wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assert.deepEqual(wrapText("", 10), []);
  assert.deepEqual(wrapText("a  b", 5), ["a b"], "runs of whitespace collapse");
});

test("the cursor survives a selected index outside rows (defensive clamp, not a state guarantee)", () => {
  // A `y`/`n` shrinks the ledger by one row while the cursor stays put; the
  // renderer must still draw a cursor instead of silently losing it.
  const rows = [ROW({ ts: "2026-10-27T09:14:00Z" }), ROW({ ts: "2026-10-27T08:02:00Z" }), ROW({ ts: "2026-10-27T07:03:00Z" })];
  const lines = text(renderJudgments(state({ width: 100, rows, selected: 40, offset: 0 })));
  const cursors = lines.filter((l) => l.startsWith("→ "));
  assert.equal(cursors.length, 1, "exactly one row carries the cursor");
  assert.ok(cursors[0].includes("07:03"), "it is the last row, the clamped position");
});

test("'?' answers on an empty ledger instead of being a no-op", () => {
  const lines = text(
    renderJudgments(
      state({ help: true, stats: { total: 0, resolved: 0, pending: 0, models: [] }, rows: [], detail: null, questionTotals: [], questionGroups: [] })
    )
  );
  assert.ok(lines.some((l) => l === " HELP"), "the help panel renders before the zero-state early return");
  assert.ok(lines.some((l) => l.startsWith("  ? ")), "and it lists the keys");
  assert.ok(!lines.some((l) => l.includes("no judgments yet")), "help replaces the zero-state hint");
  assert.equal(lines[lines.length - 1], " ? help · q close", "the footer still closes the screen");
});

test("a confirmation message renders above the footer, in every branch", () => {
  const msg = "resolved j-1 → true";
  const cases = {
    main: state({ message: msg }),
    help: state({ help: true, message: msg }),
    zero: state({ message: msg, stats: { total: 0, resolved: 0, pending: 0, models: [] }, rows: [], detail: null, questionTotals: [], questionGroups: [] }),
  };
  for (const [name, st] of Object.entries(cases)) {
    const lines = text(renderJudgments({ ...st, height: 60 }));
    const at = lines.indexOf(` ${msg}`);
    const footer = lines.indexOf(" ? help · q close");
    assert.ok(at >= 0, `${name}: the message is drawn`);
    assert.ok(footer > at, `${name}: the footer comes after the message (trim eats the tail, not the confirmation)`);
  }
});

test("the more-line advertises the page key", () => {
  const many = Array.from({ length: 30 }, (_, i) => ROW({ ts: `2026-10-27T09:${String(59 - i).padStart(2, "0")}:00Z` }));
  const lines = text(renderJudgments(state({ width: 100, height: 20, rows: many, selected: 0, offset: 0 })));
  const hint = lines.find((l) => l.includes("more"));
  assert.ok(hint.includes("pgdn"), `the hint names a key that pages: "${hint}"`);
});
