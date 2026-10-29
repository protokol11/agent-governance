// core/lint.ts — the single authoring-rule gate. All rules live here; neither
// the tool wrapper nor the prompt duplicates them.
import type { Question } from "./types.ts";
import { QUESTION_TYPES } from "./types.ts";

export function lintQuestion(id: string, q: unknown): string[] {
  const errors: string[] = [];
  if (!q || typeof q !== "object") return [`${id}: not an object`];
  const question = q as Question;
  if (!QUESTION_TYPES.includes(question.type)) {
    errors.push(`${id}: bad type ${String((question as { type?: unknown }).type)}`);
  }
  if (!question.instructions || !String(question.instructions).trim()) {
    errors.push(`${id}: empty instructions`);
  }
  if (question.type === "choice") {
    const keys = question.criteria && typeof question.criteria === "object" ? Object.keys(question.criteria) : [];
    if (keys.length < 2) errors.push(`${id}: choice needs >=2 criteria options`);
  }
  if (question.type === "score") {
    const ok = Array.isArray(question.criteria) && question.criteria.length >= 2 && question.criteria.length <= 10;
    if (!ok) errors.push(`${id}: score needs 2..10 levels`);
  }
  return errors;
}

export function lintQuestions(questions: Record<string, unknown>): string[] {
  return Object.entries(questions).flatMap(([id, q]) => lintQuestion(id, q));
}
