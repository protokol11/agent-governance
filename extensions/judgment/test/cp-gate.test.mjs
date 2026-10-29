// Run: node --test test/cp-gate.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  CP_GATE_THRESHOLD,
  buildQuestions,
  lintRegistry,
  runLints,
  verdictsFromAnswers,
} from "../core/cp-gate.ts";
import { parseCorpus, shouldCps } from "../core/cp-corpus.ts";
import { toJudgmentAnswers } from "../core/cp-review.ts";

const CORPUS_PATH = "C:/Users/HOME/.agents/skills/principles-render/rendered/cp-corpus.json";

function liveShouldCps() {
  return shouldCps(parseCorpus(readFileSync(CORPUS_PATH, "utf-8")));
}

test("threshold is the drilled operating point", () => {
  assert.equal(CP_GATE_THRESHOLD, 0.081149);
});

test("buildQuestions emits one cp-review noul question per should-CP on the live corpus", () => {
  const cps = liveShouldCps();
  const { questions, state } = buildQuestions("DIFF", cps);
  assert.equal(Object.keys(questions).length, 19);
  for (const cp of cps) {
    const id = `cp-review:${cp.id}`;
    assert.equal(questions[id].type, "noul");
    assert.ok(questions[id].instructions.includes(`key ${cp.id}`));
    assert.ok(questions[id].instructions.includes(`principle ${cp.id}?`));
    assert.equal(state.cp_texts[cp.id], cp.statement);
  }
  assert.equal(state.diff, "DIFF");
});

test("verdictsFromAnswers flags P(yes) >= threshold and sorts by p desc", () => {
  const { verdicts, errors } = verdictsFromAnswers({
    "cp-review:CP-22": { value: "no", confidence: 0.9997358653181929 },
    "cp-review:CP-13": { value: "yes", confidence: 0.7 },
    "cp-review:CP-01": { value: "no", confidence: 0.98 },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(
    verdicts.map((v) => [v.cp_id, v.violated]),
    [
      ["CP-13", true],
      ["CP-01", false],
      ["CP-22", false],
    ]
  );
});

test("gate verdicts are unchanged from the raw-probability rule at every boundary", () => {
  const probabilities = [0, 0.3, 0.4999, 0.5, 0.5001, 0.7, 0.9, 1];
  const answers = toJudgmentAnswers(
    Object.fromEntries(probabilities.map((probability, i) => [`q${i}`, { type: "bool", probability }]))
  );
  const { verdicts, errors } = verdictsFromAnswers(answers);
  assert.deepEqual(errors, []);
  const byCp = new Map(verdicts.map((v) => [v.cp_id, v]));
  probabilities.forEach((rawProbability, i) => {
    const verdict = byCp.get(`q${i}`);
    assert.ok(verdict, `missing verdict for ${rawProbability}`);
    // Pre-change rule: violated = raw P(yes) >= CP_GATE_THRESHOLD.
    assert.equal(verdict.violated, rawProbability >= CP_GATE_THRESHOLD, `p=${rawProbability}`);
    // p is still the cell's P(yes), so reported values are bit-for-bit unchanged.
    assert.ok(Math.abs(verdict.p - rawProbability) < 1e-12, `p=${rawProbability} reported ${verdict.p}`);
  });
});

test("edge p == threshold is violated (>=)", () => {
  const { verdicts } = verdictsFromAnswers({ "cp-review:CP-13": { value: "yes", confidence: CP_GATE_THRESHOLD } });
  assert.deepEqual(verdicts, [{ cp_id: "CP-13", p: CP_GATE_THRESHOLD, violated: true }]);
});

test("non-finite and out-of-range confidence become errors, not verdicts", () => {
  const { verdicts, errors } = verdictsFromAnswers({
    "cp-review:CP-13": { value: "yes", confidence: Number.NaN },
    "cp-review:CP-22": { value: "yes", confidence: 1.5 },
    "cp-review:CP-01": { value: "yes", confidence: -0.1 },
  });
  assert.deepEqual(verdicts, []);
  assert.deepEqual(
    errors.map((e) => e.cp_id),
    ["CP-13", "CP-22", "CP-01"]
  );
});

test("an unanswered CP produces no row and no error (missing answers are not clean)", () => {
  const { verdicts, errors } = verdictsFromAnswers({});
  assert.deepEqual(verdicts, []);
  assert.deepEqual(errors, []);
});

test("threshold is overridable per call; decide() is not involved", () => {
  const { verdicts } = verdictsFromAnswers(
    { "cp-review:CP-13": { value: "yes", confidence: 0.5 } },
    0.9
  );
  assert.deepEqual(verdicts, [{ cp_id: "CP-13", p: 0.5, violated: false }]);
});

test("verdicts round-trip through JSON (RTL-03)", () => {
  const input = { "cp-review:CP-13": { value: "yes", confidence: 0.7 } };
  const once = verdictsFromAnswers(input);
  const twice = JSON.parse(JSON.stringify(once));
  assert.deepEqual(verdictsFromAnswers(input), twice);
});

test("a value that is neither yes nor no errors instead of inverting", () => {
  const { verdicts, errors } = verdictsFromAnswers({
    "cp-review:CP-13": { value: "maybe", confidence: 0.9 },
    "cp-review:CP-22": { value: "true", confidence: 0.9 },
    "cp-review:CP-01": { value: "", confidence: 0.9 },
    "cp-review:CP-02": { value: "no", confidence: 0.9 },
  });
  assert.deepEqual(
    errors,
    [
      { cp_id: "CP-13", error: "unsupported value maybe" },
      { cp_id: "CP-22", error: "unsupported value true" },
      { cp_id: "CP-01", error: "unsupported value " },
    ],
    "an unknown value names no direction, so it must not become a probability"
  );
  assert.deepEqual(
    verdicts.map((v) => v.cp_id),
    ["CP-02"],
    "only the yes/no answer yields a verdict"
  );
});

test("empty lint registry passes; a registered predicate blocks with its reason", () => {
  assert.deepEqual(runLints("anything"), []);

  const probe = {
    id: "CP-02",
    check: (content) => (content.includes("hack") ? "ad-hoc construction" : null),
  };
  lintRegistry.push(probe);
  try {
    assert.deepEqual(runLints("clean code"), []);
    assert.deepEqual(runLints("hack shortcut"), [{ cp_id: "CP-02", error: "ad-hoc construction" }]);
    // registry is exported mutable state for B2/rule-lifecycle registration
    assert.ok(lintRegistry.includes(probe));
  } finally {
    lintRegistry.splice(lintRegistry.indexOf(probe), 1);
  }
  assert.deepEqual(lintRegistry, []);
});
