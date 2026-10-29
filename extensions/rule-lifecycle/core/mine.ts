// core/mine.ts — deep module: two pure queries over judgment-ledger evidence.
// `mineResiduals` clusters escalation residuals by question shape; `replay`
// scores a candidate predicate over resolved records. No fs, no model calls.
import type { JudgmentRecord, RefusalRecord } from "../../judgment/core/types.ts";
import { disagrees, isResidual } from "./evidence.ts";

export interface Cluster {
  question_id: string;
  n: number;
  disagreementRate: number;
  sampleHashes: string[];
  sampleInstructions: string[];
}

export interface ReplayReport {
  accuracy: number;
  n: number;
  mismatches: string[];
}

const SAMPLE_LIMIT = 5;

/**
 * Cluster residuals by question_id and keep clusters above both thresholds.
 * Rank by volume × disagreement rate (the recurring hard cases first).
 */
export function mineResiduals(
  records: JudgmentRecord[],
  refusals: Map<string, RefusalRecord>,
  { minVolume, minDisagreement }: { minVolume: number; minDisagreement: number }
): Cluster[] {
  const buckets = new Map<string, { n: number; disagreements: number; hashes: string[]; instructions: string[] }>();
  for (const record of records) {
    if (!isResidual(record, refusals)) continue;
    const d = disagrees(record);
    if (d === null) continue;
    const bucket = buckets.get(record.question_id) ?? { n: 0, disagreements: 0, hashes: [], instructions: [] };
    bucket.n += 1;
    if (d) bucket.disagreements += 1;
    if (!bucket.hashes.includes(record.state_hash)) bucket.hashes.push(record.state_hash);
    if (!bucket.instructions.includes(record.instructions)) bucket.instructions.push(record.instructions);
    buckets.set(record.question_id, bucket);
  }
  const ranked: Array<Cluster & { weight: number }> = [];
  for (const [question_id, bucket] of buckets) {
    const disagreementRate = bucket.disagreements / bucket.n;
    if (bucket.n < minVolume || disagreementRate < minDisagreement) continue;
    ranked.push({
      question_id,
      n: bucket.n,
      disagreementRate: round(disagreementRate),
      sampleHashes: bucket.hashes.slice(0, SAMPLE_LIMIT),
      sampleInstructions: bucket.instructions.slice(0, SAMPLE_LIMIT),
      weight: bucket.n * disagreementRate,
    });
  }
  ranked.sort((a, b) => b.weight - a.weight);
  return ranked.map(({ weight: _weight, ...cluster }) => cluster);
}

/**
 * Re-run a candidate predicate over resolved records. Accuracy is matches over
 * the resolved count; mismatches lists the judgment_ids it got wrong.
 */
export function replay(predicate: (record: JudgmentRecord) => boolean, records: JudgmentRecord[]): ReplayReport {
  let n = 0;
  let matches = 0;
  const mismatches: string[] = [];
  for (const record of records) {
    if (typeof record.outcome !== "boolean") continue;
    n += 1;
    if (predicate(record) === record.outcome) matches += 1;
    else mismatches.push(record.judgment_id);
  }
  return { accuracy: n ? round(matches / n) : 0, n, mismatches };
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
