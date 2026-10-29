// core/cp-review.ts — the pure cp-review request/answer contract.
//
// The RLCD cell speaks the classifier wire: one `bool` question with
// criteria {true,false} answers with {type:"bool", probability}. The judgment
// engine speaks `noul` questions and {value, confidence} answers. This module
// is the only place that translates between the two, and the only place that
// names the request shape. No model, no fs, no pi import.
import type { Answer, Question } from "./types.ts";

/** Question-id prefix that marks a request for the trained cp-review cell. */
export const CP_REVIEW_PREFIX = "cp-review:";

export function isCpReviewQuestion(id: string): boolean {
  return id.startsWith(CP_REVIEW_PREFIX);
}

/**
 * All-or-nothing route: a request goes to the classifier only when every
 * question is a cp-review question. A mixed request keeps the generative path,
 * so one state_hash is never split across two models.
 */
export function isCpReviewRequest(questions: Record<string, { type: string }>): boolean {
  const ids = Object.keys(questions);
  return ids.length > 0 && ids.every(isCpReviewQuestion);
}

/** Classifier wire question: fixed yes/no criteria, per the S1 prototype. */
export interface ClassifierBoolQuestion {
  type: "bool";
  instructions: string;
  criteria: { true: string; false: string };
  /** Per-question CP key (cp-review questions only): lets the sidecar align the CP
   * text without parsing the id string. See ADR-0039. */
  cp_key?: string;
}

/** Map judgment `noul` questions to the classifier `bool` wire shape. */
export function toClassifierQuestions(questions: Record<string, Question>): Record<string, ClassifierBoolQuestion> {
  const out: Record<string, ClassifierBoolQuestion> = {};
  for (const [id, q] of Object.entries(questions)) {
    out[id] = {
      type: "bool",
      instructions: q.instructions,
      criteria: { true: "yes", false: "no" },
    };
    // The CP key is derived from the single id-format source (CP_REVIEW_PREFIX);
    // the sidecar reads the field and never parses the id (ADR-0039).
    if (isCpReviewQuestion(id)) out[id].cp_key = id.slice(CP_REVIEW_PREFIX.length);
  }
  return out;
}

/** Classifier wire answer; only `bool` carries a probability. */
export interface ClassifierBoolAnswer {
  type: string;
  probability?: number;
}

/**
 * Map classifier answers back to judgment answers. The value is the point
 * guess at the 0.5 boundary; `confidence` is P(recorded value) — the raw
 * probability for "yes", its complement for "no" (ADR-0045). A caller that
 * thresholds on P(yes), like the cp-review gate, must invert explicitly.
 */
export function toJudgmentAnswers(answers: Record<string, ClassifierBoolAnswer>): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const [id, a] of Object.entries(answers)) {
    const p = typeof a.probability === "number" && Number.isFinite(a.probability) ? a.probability : 0.5;
    const clamped = Math.min(1, Math.max(0, p));
    out[id] =
      clamped >= 0.5
        ? { value: "yes", confidence: clamped }
        : { value: "no", confidence: 1 - clamped };
  }
  return out;
}
