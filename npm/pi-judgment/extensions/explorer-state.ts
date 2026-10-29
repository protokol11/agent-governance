// explorer-state.ts — ViewState in, ExplorerState out. Pure: no fs, no pi imports,
// so `node --test` can drive the real state builder (goldens alone cannot prove
// the queue filters, sorts or picks its group).
import type { JudgmentRecord, Provenance } from "./core/types.ts";
import { binsFor, filterRows, judgmentStats, questionGroups } from "./core/stats.ts";
import type { ExplorerFilter } from "./core/stats.ts";
import { questionGroup } from "./core/stats.ts";
import { bodyFor, offsetFor, type ExplorerRow, type ExplorerState } from "./explorer.ts";

export interface ExplorerViewState {
  view: "calibration" | "ledger";
  modelFilter: string | null;
  provenanceFilter: Provenance;
  pendingOnly: boolean;
  questionGroup: string | null;
  selected: number;
  message: string | null;
  help: boolean;
  height: number;
  records: JudgmentRecord[];
}

/**
 * The group the queue opens on: the one whose newest pending row is the newest
 * in the ledger. The view's model and provenance count first, because a group
 * whose pending rows live in another provenance would open on an empty screen;
 * with nothing pending, the newest group still gives the reader a place to start.
 */
export function openingGroup(records: JudgmentRecord[], model: string | null, provenance: Provenance): string | null {
  const newest = (keep: (r: JudgmentRecord) => boolean): string | null => {
    let best: { group: string; ts: string } | null = null;
    for (const r of records) {
      if (r.excluded === true || !keep(r)) continue;
      const group = questionGroup(r.question_id);
      if (!best || r.ts > best.ts) best = { group, ts: r.ts };
    }
    return best?.group ?? null;
  };
  const pending = (r: JudgmentRecord) => typeof r.outcome !== "boolean";
  // Both filters are null-guarded: an "all" model or an absent provenance must
  // not silently discard the other active filter and fall through to any group.
  return (
    newest((r) => pending(r) && (!model || r.model === model) && (!provenance || r.provenance === provenance)) ??
    newest(pending) ??
    newest(() => true)
  );
}

/**
 * Next group in the `g` cycle: only the groups that still hold rows under the
 * current model + provenance filter, so `g` never lands on a pane that renders
 * another filter's rows. Pending-only is not part of the cycle: a quiet group
 * still has to be reachable (it falls back to its resolved rows).
 */
export function nextGroup(
  records: JudgmentRecord[],
  current: string | null,
  model: string | null,
  provenance: Provenance
): string | null {
  const visible = filterRows(records, { pendingOnly: false, model, provenance, questionGroup: null });
  const groups = questionGroups(visible).map((g) => g.group);
  if (!groups.length) return null;
  const i = current ? groups.indexOf(current) : -1;
  return groups[(i + 1) % groups.length];
}

export function toExplorerState(v: ExplorerViewState, height: number, width: number): ExplorerState {
  const stats = judgmentStats(v.records);
  const group = v.questionGroup ?? openingGroup(v.records, v.modelFilter, v.provenanceFilter);
  // One filter object drives the list and the bins, so the panes cannot drift.
  const inGroup: ExplorerFilter = {
    pendingOnly: true,
    model: v.modelFilter,
    provenance: v.provenanceFilter,
    questionGroup: group,
  };
  // pendingOnly is the default, but a group with no pending rows falls back to
  // all its rows — an empty screen teaches nothing (live feedback 2026-10-01).
  // The check runs inside the group filter, so a quiet group still shows itself
  // while a loud one stays a queue. Excluded rows need no review, so they never
  // count as pending here.
  const pendingInView = filterRows(v.records, inGroup).length;
  const effectivePendingOnly = pendingInView > 0 && v.pendingOnly;
  const filter: ExplorerFilter = { ...inGroup, pendingOnly: effectivePendingOnly };
  const rows = filterRows(v.records, filter)
    .slice()
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .map(
      (r): ExplorerRow => ({
        ts: r.ts,
        question_id: r.question_id,
        value: r.value,
        confidence: r.confidence,
        model: r.model,
        provenance: r.provenance,
        outcome: r.outcome,
        instructions: r.instructions,
        decision: r.decision,
        state_excerpt: r.state_excerpt,
      })
    );
  v.selected = Math.max(0, Math.min(v.selected, Math.max(0, rows.length - 1)));
  return {
    stats,
    view: v.view,
    // Same `filter` as the rows above, with pendingOnly off inside binsFor: the
    // bins' n is exactly the resolved rows of this list.
    bins: binsFor(v.records, filter, 5),
    modelFilter: v.modelFilter,
    provenanceFilter: v.provenanceFilter,
    pendingOnly: v.pendingOnly,
    questionTotals: stats.byQuestion.map((q) => ({ question_id: q.question_id, total: q.total, resolved: q.resolved })),
    rows,
    selected: v.selected,
    detail: rows[v.selected] ?? null,
    message: v.message,
    height,
    pendingFallback: stats.total > 0 && pendingInView === 0 && v.pendingOnly,
    width,
    offset: offsetFor(v.selected, rows.length, bodyFor(height)),
    help: v.help,
    questionGroup: group,
    questionGroups: questionGroups(v.records),
  };
}
