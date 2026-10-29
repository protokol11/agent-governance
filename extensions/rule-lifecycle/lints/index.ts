// lints/index.ts — registry of synthesized lint predicates, keyed by rule_id.
// promote.ts looks up the predicate here: promotion requires a synthesizable
// predicate, so a rule with no module here can never be promoted.
import type { JudgmentRecord } from "../../judgment/core/types.ts";
import { predicate as cp50, ruleId as cp50RuleId } from "./cp50-types-carry-invariant.ts";

export type LintPredicate = (record: JudgmentRecord) => boolean;

const REGISTRY: Record<string, LintPredicate> = {
  [cp50RuleId]: cp50,
};

export function predicateFor(ruleId: string): LintPredicate | undefined {
  return REGISTRY[ruleId];
}
