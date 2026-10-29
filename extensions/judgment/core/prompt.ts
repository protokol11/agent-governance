// core/prompt.ts — build the constrained judge prompt from typed questions.
// Output contract: one JSON object, fixed keys, no prose.
import { hashState } from "./hash.ts";
import type { Question } from "./types.ts";

export const JUDGE_SYSTEM = [
  "You are a calibrated judgment engine.",
  "Respond with ONLY one JSON object and nothing else — no markdown fences, no prose, no thinking:",
  '{"answers": {"<question_id>": {"value": <answer>, "confidence": <0..1>}}}',
  "value for type=noul must be the string yes or no. Keep the whole response under 200 tokens.",
  "value for type=noul must be the string yes or no.",
  "confidence is the probability that your value is correct.",
  "Answer every question_id exactly once. Use the criteria options verbatim when given.",
].join(" ");

export function buildJudgeUser(state: unknown, questions: Record<string, Question>): string {
  return [
    "State (context for the judgment):",
    JSON.stringify(state, null, 2),
    "",
    `Questions (state_hash ${hashState(state)}):`,
    JSON.stringify(questions, null, 2),
  ].join("\n");
}
