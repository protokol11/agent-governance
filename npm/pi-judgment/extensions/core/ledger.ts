// core/ledger.ts — append-only JSONL under <cwd>/<config-dir>/judgments.jsonl.
// One judgment per line; resolutions are separate events folded on read.
// Append failure throws — a judgment that is not recorded must not pass.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AnnotationRecord, Decision, JudgmentRecord, RefusalRecord } from "./types.ts";

const RESOLUTION = "resolution";
const REFUSAL = "refusal";
const ANNOTATION = "annotation";
const EXCERPT_CAP = 400;

export function appendJudgment(path: string, record: JudgmentRecord): void {
  appendLine(path, JSON.stringify({ kind: "judgment", ...capExcerpt(record) }));
}

/**
 * Record a correction as its own line. Callers never touch existing lines, so the
 * audit trail shows the original value and the fix side by side.
 */
export function appendAnnotation(path: string, annotation: AnnotationRecord): void {
  appendLine(path, JSON.stringify({ kind: ANNOTATION, ...annotation }));
}

/**
 * Keep the excerpt bounded: a pending row needs enough text to review, and the
 * ledger must not grow into a session store.
 */
function capExcerpt(record: JudgmentRecord): JudgmentRecord {
  if (typeof record.state_excerpt !== "string") return record;
  return { ...record, state_excerpt: record.state_excerpt.slice(0, EXCERPT_CAP) };
}

export function appendResolution(path: string, judgmentId: string, outcome: boolean, ts: string): boolean {
  appendLine(path, JSON.stringify({ kind: RESOLUTION, judgment_id: judgmentId, outcome, ts }));
  return true;
}

/** Append a priced refusal against a rule predicate, linked to a judgment row. */
export function appendRefusal(path: string, refusal: RefusalRecord): void {
  appendLine(path, JSON.stringify({ kind: REFUSAL, ...refusal }));
}

/**
 * The refusal to record when a rule-predicate decision escalates, or null when
 * it acts. Central place for the emission rule so call sites stay thin.
 */
export function refusalForEscalation(
  decision: Decision,
  { judgment_id, rule_id, witness, ts }: { judgment_id: string; rule_id: string; witness: string; ts: string }
): RefusalRecord | null {
  if (decision.action !== "escalate") return null;
  return { judgment_id, rule_id, witness, price: decision.costs.escalate, ts };
}

/** Read the ledger and fold resolution + refusal events into judgment records. */
export function readJudgments(path: string): JudgmentRecord[] {
  return readLedger(path).judgments;
}

/** Refusals keyed by judgment_id (sidecar map; judgments keep their shape). */
export function readRefusals(path: string): Map<string, RefusalRecord> {
  return readLedger(path).refusals;
}

interface LedgerView {
  judgments: JudgmentRecord[];
  refusals: Map<string, RefusalRecord>;
}

function readLedger(path: string): LedgerView {
  const byId = new Map<string, JudgmentRecord>();
  const refusals = new Map<string, RefusalRecord>();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { judgments: [], refusals };
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // tolerate a torn last line; never crash the read path
    }
    if (entry.kind === "judgment") {
      const record = { ...entry } as unknown as JudgmentRecord;
      delete (record as { kind?: string }).kind;
      byId.set(record.judgment_id, record);
    } else if (entry.kind === RESOLUTION) {
      // Last writer wins: this overwrites an earlier relabel (append order).
      const record = byId.get(String(entry.judgment_id));
      if (record) record.outcome = Boolean(entry.outcome);
    } else if (entry.kind === REFUSAL) {
      const judgmentId = String(entry.judgment_id);
      // Incident 2026-10-12: a refusal written without its judgment row (gate
      // escalation path) made this strict throw brick every readLedger caller —
      // scope lock, gate, judge — blocking all writes session-wide. Writes are
      // fixed to always link a row; reads still tolerate a corrupt line: skip
      // it loudly instead of letting one bad append become a total outage.
      if (!byId.has(judgmentId)) {
        console.warn(`cp-review ledger: skipping refusal with unknown judgment_id: ${judgmentId}`);
        continue;
      }
      refusals.set(judgmentId, {
        judgment_id: judgmentId,
        rule_id: String(entry.rule_id),
        witness: String(entry.witness),
        price: typeof entry.price === "number" ? entry.price : null,
        ts: String(entry.ts),
      });
    } else if (entry.kind === ANNOTATION) {
      const record = byId.get(String(entry.judgment_id));
      // Same policy as the refusal incident 2026-10-12: one dangling line must
      // not brick every reader, so warn and move on.
      if (!record) {
        console.warn(`cp-review ledger: skipping annotation with unknown judgment_id: ${String(entry.judgment_id)}`);
        continue;
      }
      if (entry.op === "relabel") {
        if (typeof entry.outcome !== "boolean") {
          console.warn(`cp-review ledger: skipping relabel without a boolean outcome: ${record.judgment_id}`);
          continue;
        }
        record.outcome = entry.outcome;
        record.annotated = true;
      } else if (entry.op === "exclude") {
        record.excluded = true;
      } else {
        console.warn(`cp-review ledger: skipping annotation with unknown op: ${String(entry.op)}`);
      }
    }
  }
  return { judgments: [...byId.values()], refusals };
}

export function countResolved(records: JudgmentRecord[], provenance: ProvenanceLike = "judge"): number {
  return records.filter((r) => r.provenance === provenance && r.excluded !== true && typeof r.outcome === "boolean")
    .length;
}

type ProvenanceLike = JudgmentRecord["provenance"];

function appendLine(path: string, line: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line + "\n", "utf8");
  } catch (error) {
    throw new Error(`judgment ledger append failed (${path}): ${String(error)}`);
  }
}
