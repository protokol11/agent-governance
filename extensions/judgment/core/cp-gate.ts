// core/cp-gate.ts — pure cp-review gate: questions in, verdicts out.
//
// The trained cell speaks the S1 wire: state {diff, cp_texts} with one
// cp-review:CP-XX noul question per should-CP. The drilled operating point
// (sess-drill-rlcd-operating-point) is applied per call here and only here:
// violated = P(yes) >= CP_GATE_THRESHOLD. decide() and scope-lock stay
// untouched. No fs, no model, no pi import.
import { CP_REVIEW_PREFIX } from "./cp-review.ts";
import type { CpEntry } from "./cp-corpus.ts";
import type { Answer, Question } from "./types.ts";

/** Drilled BA operating point; per-call, not baked into decide(). */
export const CP_GATE_THRESHOLD = 0.081149;

/** One gate review: the diff under edit plus the CP texts it is judged against. */
export interface CpReviewState {
  diff: string;
  cp_texts: Record<string, string>;
}

export interface GateQuestion {
  questions: Record<string, Question>;
  state: CpReviewState;
}

/**
 * Build the classifier request for one diff. Instruction shape matches the
 * cell's training wire verbatim (calibration-warmup corpus) with the CP id
 * substituted — the cell was trained on this exact phrasing.
 */
export function buildQuestions(diff: string, cps: CpEntry[]): GateQuestion {
  const questions: Record<string, Question> = {};
  const cp_texts: Record<string, string> = {};
  for (const cp of cps) {
    cp_texts[cp.id] = cp.statement;
    questions[`${CP_REVIEW_PREFIX}${cp.id}`] = {
      type: "noul",
      instructions:
        `Same diff in state.diff. Full principle text in state.cp_texts under key ${cp.id}. ` +
        `Does this diff violate principle ${cp.id}? yes/no with probability.`,
    };
  }
  return { questions, state: { diff, cp_texts } };
}

export interface Verdict {
  cp_id: string;
  /** P(violation) recovered from the answer; finite, in [0,1]. */
  p: number;
  violated: boolean;
}

export interface VerdictError {
  cp_id: string;
  error: string;
}

export interface GateVerdicts {
  verdicts: Verdict[];
  errors: VerdictError[];
}

function sanitizeConfidence(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0 || raw > 1) return null;
  return raw;
}

/**
 * Turn judgment answers into verdicts at the operating point. `confidence` is
 * P(recorded value) (ADR-0045), so P(yes) is reconstructed before the
 * comparison: pYes = value === "yes" ? confidence : 1 - confidence. The
 * verdict fills `p` with pYes — the same quantity the cell's raw probability
 * used to carry — so thresholds, reported p values and sort order stay
 * bit-for-bit identical to the pre-ADR-0045 records. Comparison is >= (prototype
 * edge p == t → violated). Answers with non-finite or out-of-range confidence
 * surface as errors, never as a clean verdict; so does a value that is neither
 * "yes" nor "no", which names no direction to threshold on. An unanswered CP
 * produces no row at all (HUMAN-JUDGMENT-FINAL: no row, not violated:false).
 * Verdicts sort by p (pYes) desc.
 */
export function verdictsFromAnswers(
  answers: Record<string, Answer>,
  threshold: number = CP_GATE_THRESHOLD
): GateVerdicts {
  const verdicts: Verdict[] = [];
  const errors: VerdictError[] = [];
  for (const [id, a] of Object.entries(answers)) {
    const cp_id = id.startsWith(CP_REVIEW_PREFIX) ? id.slice(CP_REVIEW_PREFIX.length) : id;
    if (!a || typeof a !== "object") {
      errors.push({ cp_id, error: "missing answer" });
      continue;
    }
    const p = sanitizeConfidence(a.confidence);
    if (p === null) {
      errors.push({ cp_id, error: `bad confidence ${String(a.confidence)}` });
      continue;
    }
    // Only a yes/no value names a direction. Anything else has no P(yes) to
    // recover, so it errors out instead of silently inverting one.
    if (a.value !== "yes" && a.value !== "no") {
      errors.push({ cp_id, error: `unsupported value ${String(a.value)}` });
      continue;
    }
    // confidence is P(value); the gate thresholds on P(yes), so invert "no".
    const pYes = a.value === "yes" ? p : 1 - p;
    verdicts.push({ cp_id, p: pYes, violated: pYes >= threshold });
  }
  verdicts.sort((x, y) => y.p - x.p);
  return { verdicts, errors };
}

/**
 * The must-CP slot. Predicates are synthesized by rule-lifecycle promotion
 * (ADR-0034) and registered here; the registry ships empty — no deterministic
 * predicates exist for the 31 must-CPs yet, and inventing them would be a lie.
 * check returns a violation reason or null.
 */
export interface LintPredicate {
  id: string;
  check: (content: string) => string | null;
}

export const lintRegistry: LintPredicate[] = [];

/** Run registered must-lint predicates over the payload. Empty registry passes. */
export function runLints(content: string, registry: LintPredicate[] = lintRegistry): VerdictError[] {
  const hits: VerdictError[] = [];
  for (const pred of registry) {
    const reason = pred.check(content);
    if (reason !== null) hits.push({ cp_id: pred.id, error: reason });
  }
  return hits;
}

/**
 * The hook's decision, planned pure from gate outputs. Typed union (CP-50):
 * allow — proceed; notice — proceed, the caller surfaces why the gate stood
 * down (oversized payload, own-infra failure); block — hard stop (lint hit,
 * or verdict/escalation with no UI to ask); confirm — ask the human (verdict
 * override or classifier-failure escalation).
 */
export type GateDecision =
  | { action: "allow"; reason: string }
  | { action: "notice"; reason: string }
  | { action: "block"; reason: string; kind: "lint" | "no-ui" }
  | { action: "confirm"; reason: string; violated: Verdict[] | null };

export interface GatePlanInput {
  gateEnabled: boolean;
  contentLength: number;
  cap: number;
  /** Own-infra failure (corpus unreadable/unparseable). Degrades open, loudly. */
  infraError: string | null;
  lintHits: VerdictError[];
  /** Classifier unavailable or judge returned errors. Escalates, never a silent no. */
  classifyError: string | null;
  verdicts: Verdict[];
  hasUI: boolean;
}

export function planGateDecision(input: GatePlanInput): GateDecision {
  if (!input.gateEnabled) return { action: "allow", reason: "cp-review gate off (CP_REVIEW_GATE=off)" };
  if (input.contentLength > input.cap) {
    return {
      action: "notice",
      reason: `cp-review gate: payload ${input.contentLength} chars exceeds ${input.cap}-char review cap; written UNREVIEWED (full-diff retrieval is a lab-side step)`,
    };
  }
  if (input.infraError) {
    return { action: "notice", reason: `cp-review gate: own infra down (${input.infraError}); written UNREVIEWED` };
  }
  if (input.lintHits.length) {
    const names = input.lintHits.map((h) => `${h.cp_id}: ${h.error}`).join("; ");
    return { action: "block", kind: "lint", reason: `cp-review gate (must-CP lint): ${names}` };
  }
  if (input.classifyError) {
    const reason = `cp-review gate: classifier failure — ${input.classifyError}. No guess recorded; a human decides.`;
    return input.hasUI
      ? { action: "confirm", reason, violated: null }
      : { action: "block", kind: "no-ui", reason: `${reason} (no UI: request human review)` };
  }
  const violated = input.verdicts.filter((v) => v.violated);
  if (violated.length) {
    const names = violated.map((v) => `${v.cp_id} (p=${v.p.toFixed(3)})`).join(", ");
    const reason = `cp-review gate: suspected violation(s) at t=${CP_GATE_THRESHOLD}: ${names}. Confirm to override.`;
    return input.hasUI
      ? { action: "confirm", reason, violated }
      : { action: "block", kind: "no-ui", reason: `${reason} (no UI: request human review)` };
  }
  return { action: "allow", reason: "cp-review gate: clean" };
}
