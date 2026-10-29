// Run: node --test test/cp-review.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  CP_REVIEW_PREFIX,
  isCpReviewQuestion,
  isCpReviewRequest,
  toClassifierQuestions,
  toJudgmentAnswers,
} from "../core/cp-review.ts";

test("isCpReviewQuestion keys off the prefix only", () => {
  assert.equal(isCpReviewQuestion("cp-review:CP-22"), true);
  assert.equal(isCpReviewQuestion("scope-lock"), false);
  assert.equal(isCpReviewQuestion(""), false);
  assert.equal(CP_REVIEW_PREFIX, "cp-review:");
});

test("isCpReviewRequest is all-or-nothing", () => {
  assert.equal(isCpReviewRequest({ "cp-review:CP-13": { type: "noul" } }), true);
  assert.equal(
    isCpReviewRequest({ "cp-review:CP-13": { type: "noul" }, "cp-review:CP-22": { type: "noul" } }),
    true
  );
  assert.equal(isCpReviewRequest({ "cp-review:CP-13": { type: "noul" }, "scope-lock": { type: "noul" } }), false);
  assert.equal(isCpReviewRequest({ "scope-lock": { type: "noul" } }), false);
  assert.equal(isCpReviewRequest({}), false);
});

test("toClassifierQuestions emits the fixed bool wire shape", () => {
  const out = toClassifierQuestions({
    "cp-review:CP-22": { type: "noul", instructions: "Does this diff violate CP-22?" },
  });
  assert.deepEqual(out, {
    "cp-review:CP-22": {
      type: "bool",
      instructions: "Does this diff violate CP-22?",
      criteria: { true: "yes", false: "no" },
      cp_key: "CP-22",
    },
  });
});

test("toClassifierQuestions sets cp_key only for cp-review questions", () => {
  const out = toClassifierQuestions({
    "cp-review:CP-04": { type: "noul", instructions: "a" },
    "scope-lock": { type: "noul", instructions: "b" },
  });
  assert.equal(out["cp-review:CP-04"].cp_key, "CP-04");
  assert.equal("cp_key" in out["scope-lock"], false);
});

test("toJudgmentAnswers stores confidence as P(recorded value)", () => {
  assert.deepEqual(toJudgmentAnswers({ q: { type: "bool", probability: 0.7 } }), {
    q: { value: "yes", confidence: 0.7 },
  });
  assert.deepEqual(toJudgmentAnswers({ q: { type: "bool", probability: 0.2 } }), {
    q: { value: "no", confidence: 0.8 },
  });
});

test("toJudgmentAnswers boundary and missing probability never produce NaN", () => {
  assert.deepEqual(toJudgmentAnswers({ q: { type: "bool", probability: 0.5 } }), {
    q: { value: "yes", confidence: 0.5 },
  });
  const missing = toJudgmentAnswers({ q: { type: "bool" } }).q;
  assert.equal(Number.isNaN(missing.confidence), false);
  assert.equal(missing.confidence, 0.5);
  const nonFinite = toJudgmentAnswers({ q: { type: "bool", probability: Number.NaN } }).q;
  assert.equal(nonFinite.confidence, 0.5);
  const clamped = toJudgmentAnswers({ q: { type: "bool", probability: 1.4 } }).q;
  assert.equal(clamped.confidence, 1);
});

test("a marginal P(yes) becomes a confident no with confidence >= 0.9999", () => {
  const a = toJudgmentAnswers({ q: { type: "bool", probability: 2e-5 } }).q;
  assert.equal(a.value, "no");
  assert.ok(a.confidence >= 0.9999, `confidence ${a.confidence} should be >= 0.9999`);
});

test("the 0.5 split: 0.5 is yes, 0.4999 is no with P(no) = 0.5001", () => {
  assert.deepEqual(toJudgmentAnswers({ q: { type: "bool", probability: 0.5 } }).q, {
    value: "yes",
    confidence: 0.5,
  });
  const below = toJudgmentAnswers({ q: { type: "bool", probability: 0.4999 } }).q;
  assert.equal(below.value, "no");
  assert.ok(Math.abs(below.confidence - 0.5001) < 1e-12, `got ${below.confidence}`);
});

test("CP-22: value splits at P(yes)=0.5 and confidence is never below 0.5", () => {
  const grid = [0, 1e-5, 0.1, 0.3, 0.4999, 0.5, 0.5001, 0.7, 0.8, 0.9, 0.9999, 1];
  for (const probability of grid) {
    const a = toJudgmentAnswers({ q: { type: "bool", probability } }).q;
    assert.equal(a.value, probability >= 0.5 ? "yes" : "no", `p=${probability}: ${a.value}`);
    // confidence = P(value), so it is always the majority side: never below 0.5.
    assert.ok(a.confidence >= 0.5, `p=${probability}: ${a.value} @ ${a.confidence}`);
  }
});
