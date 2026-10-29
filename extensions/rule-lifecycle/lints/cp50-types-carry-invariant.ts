// lints/cp50-types-carry-invariant.ts — example synthesized lint (CP-50).
// One pure predicate per promoted rule. Deterministic, no fs, no model calls.
// Flags a witness as a violation when its instructions reach for a type escape
// hatch instead of carrying the invariant in the type.
import type { JudgmentRecord } from "../../judgment/core/types.ts";

export const ruleId = "CP-50";

const ESCAPE_HATCH = /(^|\W)(any|unknown)(\W|$)|@ts-ignore|as unknown/;

export function predicate(record: JudgmentRecord): boolean {
  return ESCAPE_HATCH.test(record.instructions ?? "");
}
