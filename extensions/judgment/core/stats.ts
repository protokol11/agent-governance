// core/stats.ts — pure aggregates over judgment records. No fs, no model calls.
// Binning delegates to policy.calibration — one implementation of bin math.
import { calibration } from "./policy.ts";
import type { JudgmentRecord, Provenance, ReliabilityBin } from "./types.ts";

export interface QuestionStat {
  question_id: string;
  total: number;
  resolved: number;
  pending: number;
}

export interface JudgmentStats {
  total: number;
  resolved: number;
  pending: number;
  excluded: number;
  models: string[];
  byQuestion: QuestionStat[];
}

export function judgmentStats(records: JudgmentRecord[]): JudgmentStats {
  // Excluded rows live in their own bucket, so the header reconciles:
  // total === resolved + pending + excluded.
  const resolved = records.filter((r) => r.excluded !== true && typeof r.outcome === "boolean");
  const excluded = records.filter((r) => r.excluded === true).length;
  const models = [...new Set(records.map((r) => r.model))].sort();
  const byId = new Map<string, QuestionStat>();
  for (const r of records) {
    // Per-question counters must not disagree with the header, so an excluded
    // row is dropped here entirely instead of landing in resolved or pending.
    if (r.excluded === true) continue;
    const stat = byId.get(r.question_id) ?? { question_id: r.question_id, total: 0, resolved: 0, pending: 0 };
    stat.total++;
    if (typeof r.outcome === "boolean") stat.resolved++;
    else stat.pending++;
    byId.set(r.question_id, stat);
  }
  return {
    total: records.length,
    resolved: resolved.length,
    // An excluded row needs no review, so it leaves the pending queue. `total`
    // stays the row count so the ledger and the report still reconcile.
    pending: records.filter((r) => typeof r.outcome !== "boolean" && r.excluded !== true).length,
    excluded,
    models,
    byQuestion: [...byId.values()].sort((a, b) => b.total - a.total),
  };
}

/** Text before the first `:` of a question id; no colon means the whole id. */
export function questionGroup(id: string): string {
  const at = id.indexOf(":");
  return at === -1 ? id : id.slice(0, at);
}

/** One entry per question group, sorted by total desc then group name asc. */
export function questionGroups(
  records: JudgmentRecord[]
): Array<{ group: string; pending: number; total: number }> {
  const byGroup = new Map<string, { group: string; pending: number; total: number }>();
  for (const r of records) {
    if (r.excluded === true) continue;
    const group = questionGroup(r.question_id);
    const stat = byGroup.get(group) ?? { group, pending: 0, total: 0 };
    stat.total++;
    if (typeof r.outcome !== "boolean") stat.pending++;
    byGroup.set(group, stat);
  }
  return [...byGroup.values()].sort((a, b) => b.total - a.total || a.group.localeCompare(b.group));
}

/** One filter drives both panes: rows and bins share the same predicate. */
export interface ExplorerFilter {
  pendingOnly: boolean;
  model: string | null;
  provenance: Provenance;
  questionGroup: string | null;
  includeExcluded?: boolean;
}

/**
 * Next provenance in the `p` cycle: the ones the ledger actually holds, sorted,
 * wrapping round. An unknown current value (or an empty ledger) lands on the
 * first present provenance, so the key never sticks on an absent family. Lives
 * here so the cycle is testable without importing the pi UI layer.
 */
export function nextProvenance(present: readonly Provenance[], current: Provenance): Provenance {
  const cycle = [...new Set(present)].sort();
  if (!cycle.length) return current;
  const i = cycle.indexOf(current);
  return cycle[(i + 1) % cycle.length];
}

/** Reliability bins for one filter. Ignored `pendingOnly`: bins need resolved rows. */
export function binsFor(records: JudgmentRecord[], filter: ExplorerFilter, bins = 5): ReliabilityBin[] {
  const filtered = filterRows(records, { ...filter, pendingOnly: false });
  return calibration(filtered, bins, { provenance: filter.provenance });
}

export function pendingRecords(records: JudgmentRecord[]): JudgmentRecord[] {
  return records.filter((r) => typeof r.outcome !== "boolean");
}

// Excluded rows stay hidden by default: a reader that does not ask for them must
// not see rows the owner already corrected away. `includeExcluded` is the only
// excluded gate; `pendingOnly` filters on the outcome alone. This is the ONE
// predicate: rows and bins both come through here.
export function filterRows(records: JudgmentRecord[], filter: ExplorerFilter): JudgmentRecord[] {
  return records.filter((r) => {
    if (filter.includeExcluded !== true && r.excluded === true) return false;
    if (filter.pendingOnly && typeof r.outcome === "boolean") return false;
    if (filter.model && r.model !== filter.model) return false;
    if (filter.provenance && r.provenance !== filter.provenance) return false;
    if (filter.questionGroup && questionGroup(r.question_id) !== filter.questionGroup) return false;
    return true;
  });
}
