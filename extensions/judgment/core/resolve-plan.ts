// core/resolve-plan.ts — the y/n decision as a pure function. No fs, no pi imports.
// The handler must never write behind the reader's back: only a PENDING row the
// cursor can actually see is writable; a resolved row says so and writes nothing.
import type { ExplorerRow } from "../explorer.ts";

export type ResolutionPlan =
  | { kind: "write"; row: ExplorerRow }
  | { kind: "already-resolved"; row: ExplorerRow }
  | { kind: "empty" };

/**
 * Decide what `y`/`n` does for the row under the cursor. Pure: the caller reads
 * the ledger and appends; this only classifies. `empty` covers both a list with
 * no rows and a `selected` outside it (the renderer clamps, but a stale index
 * after a write must still be safe).
 */
export function planResolution(rows: ExplorerRow[], selected: number): ResolutionPlan {
  const row = rows[Math.max(0, selected)];
  if (!row) return { kind: "empty" };
  // `outcome === null` is the pending marker everywhere else in the ledger; a
  // non-boolean is pending, so the write gate matches the queue's predicate.
  if (typeof row.outcome === "boolean") return { kind: "already-resolved", row };
  return { kind: "write", row };
}
