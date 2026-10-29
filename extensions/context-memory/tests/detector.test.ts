/**
 * Detector tests — table-driven, no pi runtime, no filesystem.
 *
 * Scripted scenarios from the spec: drift into a constraint path, the 20-turn control
 * window, and the cooldown boundary. Every row names the reason it expects, because the
 * trace is the deliverable, not the boolean.
 *
 * Run: node --experimental-strip-types tests/detector.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  AGREEMENT_CUSTOM_TYPE,
  DEFAULT_COOLDOWN_TURNS,
  REMINDER_TOKEN_BUDGET,
  buildReminder,
  cooldownBlocks,
  collectConstraints,
  decide,
  estimateTokens,
  normalizePath,
  pathsIntersect,
  readActiveTask,
  readAgreements,
  readFireTurns,
  toolTargetsOf,
  type Constraint,
  type DetectorInput,
  type DetectorReason,
} from "../detector.ts";

const API: Constraint = {
  id: "api-untouched",
  subjectPath: "src/api",
  text: "API layer stays untouched",
  source: "AGENTS.md",
};

const DOCS: Constraint = {
  id: "specs-read-only",
  subjectPath: ".docs/SPECS",
  text: "Specs stay read-only in implementation sessions",
  source: "seed",
};

interface DecisionRow {
  name: string;
  input: DetectorInput;
  expectFire: boolean;
  expectReason: DetectorReason;
  expectConstraint?: string;
}

const DECISION_ROWS: DecisionRow[] = [
  {
    name: "drift scenario 1: active task plus tool target under the constraint path fires",
    input: {
      turn: 7,
      activeTaskId: "t-3",
      toolTargets: ["src/api/handlers/orders.ts"],
      constraints: [API, DOCS],
    },
    expectFire: true,
    expectReason: "fire",
    expectConstraint: "api-untouched",
  },
  {
    name: "drift scenario 2: touching the parent directory of the subject path fires",
    input: {
      turn: 12,
      activeTaskId: "t-3",
      toolTargets: ["src/"],
      constraints: [API],
    },
    expectFire: true,
    expectReason: "fire",
    expectConstraint: "api-untouched",
  },
  {
    name: "control window: work outside every constraint path stays silent",
    input: {
      turn: 9,
      activeTaskId: "t-3",
      toolTargets: ["extensions/context-memory/detector.ts"],
      constraints: [API, DOCS],
    },
    expectFire: false,
    expectReason: "no-path-intersection",
  },
  {
    name: "no active task on the board means silence even inside the subject path",
    input: {
      turn: 4,
      activeTaskId: null,
      toolTargets: ["src/api/handlers/orders.ts"],
      constraints: [API],
    },
    expectFire: false,
    expectReason: "no-active-task",
  },
  {
    name: "no constraint at all means silence",
    input: { turn: 4, activeTaskId: "t-3", toolTargets: ["src/api/x.ts"], constraints: [] },
    expectFire: false,
    expectReason: "no-constraints",
  },
  {
    name: "no tool target yet means silence",
    input: { turn: 2, activeTaskId: "t-3", toolTargets: [], constraints: [API] },
    expectFire: false,
    expectReason: "no-tool-target",
  },
  {
    name: "cooldown boundary: exactly 20 turns after a fire still blocks",
    input: {
      turn: 21,
      activeTaskId: "t-3",
      toolTargets: ["src/api/x.ts"],
      constraints: [API],
      lastFireTurns: { "api-untouched": 1 },
    },
    expectFire: false,
    expectReason: "cooldown",
    expectConstraint: "api-untouched",
  },
  {
    name: "cooldown boundary: 21 turns after a fire re-arms the reminder",
    input: {
      turn: 22,
      activeTaskId: "t-3",
      toolTargets: ["src/api/x.ts"],
      constraints: [API],
      lastFireTurns: { "api-untouched": 1 },
    },
    expectFire: true,
    expectReason: "fire",
    expectConstraint: "api-untouched",
  },
  {
    name: "cooldown of one constraint does not silence another",
    input: {
      turn: 3,
      activeTaskId: "t-3",
      toolTargets: [".docs/SPECS/x.md"],
      constraints: [API, DOCS],
      lastFireTurns: { "api-untouched": 2 },
    },
    expectFire: true,
    expectReason: "fire",
    expectConstraint: "specs-read-only",
  },
  {
    name: "most specific subject path wins when two constraints intersect",
    input: {
      turn: 5,
      activeTaskId: "t-3",
      toolTargets: ["src/api/v1/x.ts"],
      constraints: [
        { id: "src-wide", subjectPath: "src", text: "Source tree stays local" },
        { id: "api-untouched", subjectPath: "src/api/v1", text: "API layer stays untouched" },
      ],
    },
    expectFire: true,
    expectReason: "fire",
    expectConstraint: "api-untouched",
  },
  {
    name: "same input twice yields the same decision",
    input: {
      turn: 8,
      activeTaskId: "t-3",
      toolTargets: ["src/api/x.ts", "src/api/y.ts"],
      constraints: [API, DOCS],
    },
    expectFire: true,
    expectReason: "fire",
    expectConstraint: "api-untouched",
  },
];

for (const row of DECISION_ROWS) {
  test(row.name, () => {
    const decision = decide(row.input);
    assert.equal(decision.reason, row.expectReason);
    assert.equal(decision.fire, row.expectFire);
    if (row.expectConstraint !== undefined) {
      assert.equal(decision.constraintId, row.expectConstraint);
    }
    if (row.expectFire) {
      assert.ok(decision.reminder !== null);
      assert.ok(decision.reminderTokens !== null);
      assert.ok(decision.reminderTokens <= REMINDER_TOKEN_BUDGET);
      assert.ok(decision.detail.includes("fire"));
    } else {
      assert.equal(decision.reminder, null);
      assert.ok(decision.detail.includes("no-fire"));
    }
  });
}

test("the decision is stable across a second call with the same input", () => {
  const input = DECISION_ROWS[0].input;
  assert.deepEqual(decide(input), decide(input));
});

test("path normalization strips backslashes, dot prefix, and trailing slash", () => {
  const rows: Array<[string, string]> = [
    ["src\\api\\x.ts", "src/api/x.ts"],
    ["./src/api/", "src/api"],
    ["src//api", "src/api"],
    ["  src/api  ", "src/api"],
    [".", ""],
  ];
  for (const [raw, expected] of rows) {
    assert.equal(normalizePath(raw), expected, raw);
  }
});

test("path intersection respects segment boundaries in both directions", () => {
  const rows: Array<[string, string, boolean]> = [
    ["src/api", "src/api", true],
    ["src/api/v1/x.ts", "src/api", true],
    ["src/api", "src/api/v1/x.ts", true],
    ["src/apiary/x.ts", "src/api", false],
    ["src/api-docs/x.ts", "src/api", false],
    ["src/api", "", false],
    ["extensions/x.ts", "src/api", false],
  ];
  for (const [left, right, expected] of rows) {
    assert.equal(pathsIntersect(left, right), expected, `${left} vs ${right}`);
  }
});

test("a long agreement text stays inside the token budget", () => {
  const long: Constraint = {
    id: "long",
    subjectPath: "src/api",
    text: `The API layer stays untouched for the whole session because the migration owns it. ${"Extra clause about ownership and sequencing. ".repeat(12)}`,
  };
  const reminder = buildReminder(long, "t-3");
  const tokens = estimateTokens(reminder);
  assert.ok(tokens <= REMINDER_TOKEN_BUDGET, `tokens=${tokens}`);
  assert.ok(reminder.startsWith("Agreement: "));
});

test("reminder reads as a fact and carries no imperative mood", () => {
  const reminder = buildReminder(API, "t-3");
  assert.ok(reminder.includes("Agreement: API layer stays untouched"));
  assert.ok(reminder.includes("Subject path: src/api"));
  assert.ok(reminder.includes("Active task: t-3"));
  assert.equal(/must|shall|do not|don't|never/i.test(reminder), false);
});

test("reminder omits the active task line when the board has no id", () => {
  assert.equal(buildReminder(API, null).includes("Active task:"), false);
});

test("cooldown blocks inside the window and clears after it", () => {
  assert.equal(cooldownBlocks(5, undefined, DEFAULT_COOLDOWN_TURNS), false);
  assert.equal(cooldownBlocks(25, 5, DEFAULT_COOLDOWN_TURNS), true);
  assert.equal(cooldownBlocks(26, 5, DEFAULT_COOLDOWN_TURNS), false);
  assert.equal(cooldownBlocks(5, 5, DEFAULT_COOLDOWN_TURNS), true);
});

test("active task is read from the board in the shapes the sibling may write", () => {
  const rows: Array<[unknown, string | null]> = [
    [{ tasks: [{ id: "t-1", status: "pending" }, { id: "t-2", status: "in_progress" }] }, "t-2"],
    [{ tasks: [{ id: "t-1", status: "done" }] }, null],
    [{ board: { tasks: [{ id: "t-9", status: "in_progress" }] } }, "t-9"],
    [[{ id: "t-4", state: "in_progress" }], "t-4"],
    [{ tasks: [{ task_id: "t-5", status: "in_progress" }] }, "t-5"],
    [[], null],
    [null, null],
    ["garbage", null],
    [{ tasks: [{ id: "t-1", status: "in_progress" }, { id: "t-2", status: "in_progress" }] }, "t-1"],
  ];
  for (const [board, expected] of rows) {
    assert.equal(readActiveTask(board), expected, JSON.stringify(board));
  }
});

test("constraints merge the seed file and session agreements, seed wins a duplicate id", () => {
  const seed = {
    constraints: [
      { constraint_id: "api-untouched", subject_path: "src/api", text: "API layer stays untouched" },
      { subject_path: "src", text: "Source tree stays local" },
      { text: "   " },
      "not-an-object",
    ],
  };
  const agreements = [
    { constraint_id: "specs-read-only", subject_path: ".docs/SPECS", text: "Specs stay read-only" },
    { constraint_id: "api-untouched", subject_path: "src/api", text: "overridden copy" },
  ];
  const constraints = collectConstraints(seed, agreements);
  assert.equal(constraints.length, 3);
  assert.equal(constraints[0].id, "api-untouched");
  assert.equal(constraints[0].text, "API layer stays untouched");
  assert.equal(constraints[1].id, "c2");
  assert.equal(constraints[2].id, "specs-read-only");
  assert.deepEqual(collectConstraints(null, []), []);
});

test("tool targets come from file arguments and from shell command paths", () => {
  assert.deepEqual(toolTargetsOf("read", { path: "src/api/x.ts" }), ["src/api/x.ts"]);
  assert.deepEqual(toolTargetsOf("edit", { file_path: "src/api/x.ts" }), ["src/api/x.ts"]);
  assert.deepEqual(toolTargetsOf("grep", { paths: ["src/api", "src/api", "src/web"] }), [
    "src/api",
    "src/web",
  ]);
  assert.deepEqual(toolTargetsOf("bash", { command: "rm -rf src/api/legacy.ts && ls" }), [
    "src/api/legacy.ts",
  ]);
  assert.deepEqual(toolTargetsOf("ls", { path: "." }), ["."]);
  assert.deepEqual(toolTargetsOf("bash", { command: "git status" }), []);
  assert.deepEqual(toolTargetsOf("read", null), []);
});

test("cooldown state rebuilds from the branch and keeps the latest turn per constraint", () => {
  const branch = [
    { type: "custom", customType: "context-memory-fire", data: { constraintId: "a", turn: 3 } },
    { type: "custom", customType: "context-memory-fire", data: { constraintId: "a", turn: 9 } },
    { type: "custom", customType: "other", data: { constraintId: "b", turn: 40 } },
    { type: "custom", customType: "context-memory-fire", data: { constraintId: 7, turn: 4 } },
    { type: "message", customType: "context-memory-fire", data: { constraintId: "c", turn: 2 } },
  ];
  assert.deepEqual(readFireTurns(branch), { a: 9 });
});

test("agreements are read from custom entries only, in branch order", () => {
  const branch = [
    { type: "custom", customType: AGREEMENT_CUSTOM_TYPE, data: { constraint_id: "a" } },
    { type: "custom_message", customType: AGREEMENT_CUSTOM_TYPE, data: { constraint_id: "b" } },
    { type: "custom", customType: "context-memory-fire", data: { constraint_id: "c" } },
    { type: "custom", customType: AGREEMENT_CUSTOM_TYPE, data: { constraint_id: "d" } },
  ];
  assert.deepEqual(readAgreements(branch), [{ constraint_id: "a" }, { constraint_id: "d" }]);
});

test("fired decision names the matched target for the trace", () => {
  const decision = decide({
    turn: 3,
    activeTaskId: "t-3",
    toolTargets: ["./src/web/app.ts", "src/api/handlers/orders.ts"],
    constraints: [API, DOCS],
  });
  assert.equal(decision.matchedTarget, "src/api/handlers/orders.ts");
  assert.deepEqual(decision.toolTargets, ["src/web/app.ts", "src/api/handlers/orders.ts"]);
  assert.equal(decision.cooldownTurns, DEFAULT_COOLDOWN_TURNS);
});

test("cooldown length is overridable per call", () => {
  const input: DetectorInput = {
    turn: 3,
    activeTaskId: "t-3",
    toolTargets: ["src/api/x.ts"],
    constraints: [API],
    lastFireTurns: { "api-untouched": 2 },
    cooldownTurns: 1,
  };
  assert.equal(decide(input).reason, "cooldown");
  assert.equal(decide({ ...input, turn: 4 }).reason, "fire");
});
