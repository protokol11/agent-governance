// core/evidence.ts — internal shared helpers over judgment-ledger evidence.
// Not a public query surface: mine.ts and promote.ts expose the two queries.
import type { JudgmentRecord, RefusalRecord } from "../../judgment/core/types.ts";

/** Map a noul answer to a boolean; null when the value is not yes/no. */
export function valueAsBool(value: string): boolean | null {
  if (value === "yes") return true;
  if (value === "no") return false;
  return null;
}

/**
 * A residual disagreement: the recorded answer disagrees with the resolved
 * outcome (the deterministic predicate missed the witness). Null when the
 * record is unresolved or its value is not a noul yes/no.
 */
export function disagrees(record: JudgmentRecord): boolean | null {
  if (typeof record.outcome !== "boolean") return null;
  const decided = valueAsBool(record.value);
  if (decided === null) return null;
  return decided !== record.outcome;
}

/**
 * A residual is a resolved record the deterministic predicate delegated to the
 * judge (provenance "judge") or escalated (a refusal references it).
 */
export function isResidual(record: JudgmentRecord, refusals: Map<string, RefusalRecord>): boolean {
  if (typeof record.outcome !== "boolean") return false;
  return record.provenance === "judge" || refusals.has(record.judgment_id);
}
