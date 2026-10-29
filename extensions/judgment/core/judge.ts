// core/judge.ts — the impure edge: lint → model call → validate → append.
// The model call is injected (deps.callModel) so the whole flow is testable
// with a stub; index.ts binds the real ctx.modelRegistry.complete.
import { lintQuestions } from "./lint.ts";
import { hashState } from "./hash.ts";
import { isCpReviewRequest, toJudgmentAnswers } from "./cp-review.ts";
import { JUDGE_SYSTEM, buildJudgeUser } from "./prompt.ts";
import type { Answer, JudgmentRecord, Question } from "./types.ts";

/** Minimal classifier result the judge engine consumes (pi's ClassifierResult is structurally wider). */
export interface ClassifierLike {
  stopReason: string;
  errorMessage?: string;
  model: string;
  answers: Record<string, { type: string; probability?: number }>;
}

export interface JudgeDeps {
  modelId: string;
  callModel: (system: string, user: string) => Promise<string>;
  ts?: () => string;
  /** Route cp-review requests here instead of the generative model. */
  classify?: (state: unknown, questions: Record<string, Question>) => Promise<ClassifierLike>;
  /** Ledger model id for classifier records; falls back to the result's model. */
  classifierModelId?: string;
  /** Override the classifier route predicate (default: isCpReviewRequest). */
  isClassifierRequest?: (questions: Record<string, { type: string }>) => boolean;
}

export interface JudgeResult {
  answers: Record<string, Answer>;
  judgment_ids: string[];
  errors: string[];
}

export interface LedgerSink {
  appendJudgment(record: JudgmentRecord): void;
}

export async function judge(
  state: unknown,
  questions: Record<string, Question>,
  ledger: LedgerSink,
  deps: JudgeDeps
): Promise<JudgeResult> {
  // Lint before any model call: a bad question costs nothing.
  const errors = lintQuestions(questions);
  if (errors.length) return { answers: {}, judgment_ids: [], errors };

  // cp-review requests go to the injected classifier. A failure is a fact, not
  // a parse slip: no retry, no record, and the caller escalates to a human.
  if (deps.classify && (deps.isClassifierRequest ?? isCpReviewRequest)(questions)) {
    const result = await deps.classify(state, questions);
    if (result.stopReason !== "stop" || Object.keys(result.answers ?? {}).length === 0) {
      return {
        answers: {},
        judgment_ids: [],
        errors: [`classifier unavailable: ${result.errorMessage ?? result.stopReason}`],
      };
    }
    const classificationTs = deps.ts ?? (() => new Date().toISOString());
    const classificationHash = hashState(state);
    const converted = toJudgmentAnswers(result.answers);
    const classifierAnswers: Record<string, Answer> = {};
    const classifierIds: string[] = [];
    for (const [id, q] of Object.entries(questions)) {
      const answer = converted[id];
      if (!answer) {
        errors.push(`${id}: classifier returned no answer`);
        continue;
      }
      const record = {
        judgment_id: `${id}-${classificationHash}-${Date.now()}-${classifierIds.length}`,
        ts: classificationTs(),
        state_hash: classificationHash,
        question_id: id,
        type: q.type,
        instructions: q.instructions,
        criteria: q.criteria ?? null,
        value: answer.value,
        confidence: answer.confidence,
        model: deps.classifierModelId ?? result.model,
        provenance: "classifier" as const,
        outcome: null,
      };
      ledger.appendJudgment(record); // throws on failure — never pass unrecorded
      classifierAnswers[id] = answer;
      classifierIds.push(record.judgment_id);
    }
    return { answers: classifierAnswers, judgment_ids: classifierIds, errors };
  }

  // Validate; retry the model call at most once on invalid output.
  const user = buildJudgeUser(state, questions);
  let parsed = parseAnswers(await deps.callModel(JUDGE_SYSTEM, user));
  if (!parsed.ok) parsed = parseAnswers(await deps.callModel(JUDGE_SYSTEM, user));
  if (!parsed.ok) {
    return { answers: {}, judgment_ids: [], errors: [`model output unparseable: ${parsed.error}`] };
  }

  const ts = deps.ts ?? (() => new Date().toISOString());
  const stateHash = hashState(state);
  const answers: Record<string, Answer> = {};
  const judgment_ids: string[] = [];
  for (const [id, q] of Object.entries(questions)) {
    const answer = parsed.answers[id];
    if (!answer) {
      errors.push(`${id}: model returned no answer`);
      continue;
    }
    const record = {
      judgment_id: `${id}-${stateHash}-${Date.now()}-${judgment_ids.length}`,
      ts: ts(),
      state_hash: stateHash,
      question_id: id,
      type: q.type,
      instructions: q.instructions,
      criteria: q.criteria ?? null,
      value: answer.value,
      confidence: answer.confidence,
      model: deps.modelId,
      provenance: "judge" as const,
      outcome: null,
    };
    ledger.appendJudgment(record); // throws on failure — never pass unrecorded
    answers[id] = { value: answer.value, confidence: answer.confidence };
    judgment_ids.push(record.judgment_id);
  }
  return { answers, judgment_ids, errors };
}

type Parsed = { ok: true; answers: Record<string, Answer> } | { ok: false; error: string };

function parseAnswers(raw: string): Parsed {
  if (!raw.trim()) return { ok: false, error: "empty model output" };
  const candidate = extractJson(raw);
  let data: unknown;
  try {
    data = parseJsonLoose(candidate);
  } catch (error) {
    return { ok: false, error: String(error) };
  }
  const answersBlock = (data as { answers?: unknown }).answers;
  if (!answersBlock || typeof answersBlock !== "object") return { ok: false, error: "missing answers object" };
  const answers: Record<string, Answer> = {};
  for (const [id, value] of Object.entries(answersBlock as Record<string, unknown>)) {
    const a = value as { value?: unknown; confidence?: unknown };
    if (typeof a?.value !== "string" || typeof a?.confidence !== "number") {
      return { ok: false, error: `${id}: bad answer shape` };
    }
    const confidence = Math.min(1, Math.max(0, a.confidence));
    answers[id] = { value: a.value, confidence };
  }
  return { ok: true, answers };
}

function parseJsonLoose(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Light repair: strip markdown fences and trailing commas, close braces.
    let s = raw.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").replace(/,\s*([}"])/g, "$1");
    try {
      return JSON.parse(s);
    } catch {
      const opens = (s.match(/{/g) ?? []).length - (s.match(/}/g) ?? []).length;
      if (opens > 0) return JSON.parse((s += "}".repeat(opens)));
      throw new Error("unrepairable JSON");
    }
  }
}

function extractJson(raw: string): string {
  // Prefer the smallest balanced object that contains "answers" — models like
  // to wrap JSON in prose or fences, and a trailing fence can truncate the
  // naive first-{-to-last-} slice.
  const answersAt = raw.indexOf('"answers"');
  if (answersAt >= 0) {
    const start = raw.lastIndexOf("{", answersAt);
    if (start >= 0) {
      let depth = 0;
      for (let i = start; i < raw.length; i++) {
        if (raw[i] === "{") depth++;
        else if (raw[i] === "}") {
          depth--;
          if (depth === 0) return raw.slice(start, i + 1);
        }
      }
    }
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
}
