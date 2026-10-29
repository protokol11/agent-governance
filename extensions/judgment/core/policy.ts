// core/policy.ts — pure queries over judgment records. No fs, no model calls.
import type { JudgmentRecord, Provenance, ReliabilityBin, Decision } from "./types.ts";

// Reliability curve for one provenance. Human/prose decisions must never leak
// into the model's curve — filter by provenance, not just by type.
// Excluded rows are corrections the owner already judged wrong; counting them
// would keep a bad batch inside the curve it is meant to leave.
export function calibration(
  records: JudgmentRecord[],
  bins = 5,
  { provenance = "judge" }: { provenance?: Provenance } = {}
): ReliabilityBin[] {
  const rows = records.filter(
    (r) =>
      r.type === "noul" &&
      r.provenance === provenance &&
      typeof r.outcome === "boolean" &&
      r.excluded !== true
  );
  const out: ReliabilityBin[] = [];
  for (let i = 0; i < bins; i++) {
    const lo = i / bins;
    const hi = (i + 1) / bins;
    const inBin = rows.filter((r) =>
      i === bins - 1 ? r.confidence >= lo && r.confidence <= hi : r.confidence >= lo && r.confidence < hi
    );
    if (!inBin.length) continue;
    const predicted = inBin.reduce((s, r) => s + r.confidence, 0) / inBin.length;
    const observed = inBin.filter((r) => r.outcome).length / inBin.length;
    out.push({ lo, hi, n: inBin.length, predicted: round(predicted), observed: round(observed) });
  }
  return out;
}

// Priced third action: pick the cheapest of act yes / act no / escalate, and
// escalate when it ties the winner (the owner decides at equal price).
// Below minSample resolved same-provenance records the probability is noise —
// decide must escalate regardless of p (cold-start default).
// resolvedCount=null disables the gate (probability calibrated elsewhere).
export function decide(
  p: number,
  {
    costFalseYes = 1,
    costFalseNo = 1,
    costEscalate = Infinity,
    resolvedCount = null,
    minSample = 1,
  }: {
    costFalseYes?: number;
    costFalseNo?: number;
    costEscalate?: number;
    resolvedCount?: number | null;
    minSample?: number;
  } = {}
): Decision {
  const costYes = (1 - p) * costFalseYes;
  const costNo = p * costFalseNo;
  if (resolvedCount !== null && resolvedCount < minSample) {
    return {
      action: "escalate",
      value: null,
      reason: `min-sample: ${resolvedCount} resolved < ${minSample}`,
      costs: { yes: round(costYes), no: round(costNo), escalate: costEscalate === Infinity ? null : costEscalate },
    };
  }
  const options: Array<{ action: "act" | "escalate"; value: string | null; cost: number }> = [
    { action: "act", value: "yes", cost: costYes },
    { action: "act", value: "no", cost: costNo },
    { action: "escalate", value: null, cost: costEscalate },
  ];
  options.sort((a, b) => a.cost - b.cost);
  const best = options[0];
  const costs = { yes: round(costYes), no: round(costNo), escalate: costEscalate === Infinity ? null : costEscalate };
  // Tie-break (HUMAN-JUDGMENT-FINAL): at equal price the human is the safer
  // oracle, so an `act` that only ties the escalation loses. Strict ties are the
  // interesting case — e.g. p=0.5 or 0.9 at costs 10/2/1 — and they must reach
  // the owner instead of being resolved by sort order. The comparison uses the
  // same 2-decimal costs the result reports, so float noise like
  // (1-0.9)*10 = 0.9999999999999998 does not steal a tie from the human. A
  // default Infinity never matches a finite act cost, so escalation stays off
  // unless it is priced.
  if (best.action === "act" && costEscalate <= round(best.cost)) {
    return {
      action: "escalate",
      value: null,
      reason: "tie: escalate is not more expensive",
      costs,
    };
  }
  return {
    action: best.action,
    value: best.value,
    costs,
  };
}

// The recorded gate action, or null for rows written before the split. Read it
// here rather than inferring an action from `outcome`.
export function decisionOf(record: JudgmentRecord): NonNullable<JudgmentRecord["decision"]> | null {
  return record.decision ?? null;
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
