// core/promote.ts — deep module: two pure queries over rule-lifecycle evidence.
// `promotionCandidates` fires mechanical should → must promotions when the
// gates pass; `demotionCandidates` is the symmetric must → should valve.
// No fs, no model calls.
import type { JudgmentRecord, RefusalRecord } from "../../judgment/core/types.ts";
import { predicateFor } from "../lints/index.ts";
import { valueAsBool } from "./evidence.ts";
import { replay } from "./mine.ts";

/** The held-out replay report carried by a promotion event. */
export interface HeldOutReplay {
  heldOutAccuracy: number;
  n: number;
}

export interface PromotionEvent {
  kind: "promotion";
  rule_id: string;
  from: "should";
  to: "must";
  provenance: string[];
  sample: number;
  falseRefusalRate: number;
  humanResolved: number;
  replay: HeldOutReplay;
}

export interface DemotionEvent {
  kind: "demotion";
  rule_id: string;
  from: "must";
  to: "should";
  probation: true;
  falsePositiveRate: number;
  n: number;
}

export interface LintStat {
  rule_id: string;
  n: number;
  falsePositiveRate: number;
}

/**
 * Fire should → must promotion per rule when all gates pass:
 *  1. at least `minSample` resolved refusals;
 *  2. false-refusal rate at or under `maxFalseRefusalRate`. A refusal is false
 *     when its witness resolved the way the predicate already answered
 *     (value === outcome), so the escalation was unnecessary;
 *  3. at least `minHumanResolved` human-resolved witnesses. Those human records
 *     form the held-out set — never used for mechanical synthesis — so they
 *     also carry the anti-self-reference check;
 *  4. a synthesized lint exists for the rule (promotion requires a predicate);
 *  5. the lint reproduces the held-out witnesses at `replayThreshold` or above.
 */
export function promotionCandidates(
  records: JudgmentRecord[],
  refusals: Map<string, RefusalRecord>,
  {
    minSample,
    maxFalseRefusalRate,
    minHumanResolved,
    replayThreshold,
  }: { minSample: number; maxFalseRefusalRate: number; minHumanResolved: number; replayThreshold: number }
): PromotionEvent[] {
  const byRule = new Map<string, string[]>();
  for (const refusal of refusals.values()) {
    const ids = byRule.get(refusal.rule_id) ?? [];
    ids.push(refusal.judgment_id);
    byRule.set(refusal.rule_id, ids);
  }
  const byId = new Map(records.map((record) => [record.judgment_id, record]));
  const events: PromotionEvent[] = [];
  for (const [rule_id, judgmentIds] of byRule) {
    const witnesses = judgmentIds
      .map((id) => byId.get(id))
      .filter((record): record is JudgmentRecord => !!record && typeof record.outcome === "boolean");
    if (witnesses.length < minSample) continue;
    const falseRefusals = witnesses.filter((record) => valueAsBool(record.value) === record.outcome).length;
    const falseRefusalRate = falseRefusals / witnesses.length;
    if (falseRefusalRate > maxFalseRefusalRate) continue;
    const heldOut = witnesses.filter((record) => record.provenance === "human");
    if (heldOut.length < minHumanResolved) continue;
    const predicate = predicateFor(rule_id);
    if (!predicate) continue;
    const report = replay(predicate, heldOut);
    if (report.n === 0 || report.accuracy < replayThreshold) continue;
    events.push({
      kind: "promotion",
      rule_id,
      from: "should",
      to: "must",
      provenance: witnesses.map((record) => record.judgment_id),
      sample: witnesses.length,
      falseRefusalRate: round(falseRefusalRate),
      humanResolved: heldOut.length,
      replay: { heldOutAccuracy: report.accuracy, n: report.n },
    });
  }
  events.sort((a, b) => a.rule_id.localeCompare(b.rule_id));
  return events;
}

/** Fire must → should demotion per lint stat above the false-positive tolerance. */
export function demotionCandidates(
  lintStats: LintStat[],
  { maxFalsePositiveRate }: { maxFalsePositiveRate: number }
): DemotionEvent[] {
  return lintStats
    .filter((stat) => stat.n > 0 && stat.falsePositiveRate > maxFalsePositiveRate)
    .map((stat) => ({
      kind: "demotion" as const,
      rule_id: stat.rule_id,
      from: "must" as const,
      to: "should" as const,
      probation: true as const,
      falsePositiveRate: stat.falsePositiveRate,
      n: stat.n,
    }))
    .sort((a, b) => a.rule_id.localeCompare(b.rule_id));
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
