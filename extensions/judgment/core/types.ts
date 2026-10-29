// core/types.ts — shared shape of the judgment primitive.
// Slice 1: `noul` questions end-to-end; choice/score lint but are not routed.

export const QUESTION_TYPES = ["noul", "choice", "score"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const PROVENANCES = ["judge", "prose", "code", "human", "classifier"] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** A typed question. `criteria` is a fixed option set (choice) or level list (score). */
export interface Question {
  type: QuestionType;
  instructions: string;
  criteria?: string[] | Record<string, string>;
}

export interface Answer {
  value: string;
  /** 0..1. For noul: P(yes). */
  confidence: number;
}

/** One line of the ledger. Append-only; outcome resolved later. */
export interface JudgmentRecord {
  judgment_id: string;
  ts: string;
  state_hash: string;
  question_id: string;
  type: QuestionType;
  instructions: string;
  criteria: string[] | Record<string, string> | null;
  value: string;
  /** 0..1. P(`value` is correct) — not P(yes). */
  confidence: number;
  model: string;
  provenance: Provenance;
  /** Truth of the recorded claim, and only that. The gate's action lives in `decision`. */
  outcome: boolean | null;
  /**
   * What the gate did with this claim. Separate from `outcome` so calibration
   * measures the model rather than the pricing table. Not `Decision`: this is the
   * recorded sidecar, while `Decision` is the policy output that carries costs.
   */
  decision?: { action: "act" | "escalate" | "allow" | "deny"; value?: string | null; pricedBy?: string };
  /** Bounded copy of what the judgment was about, so a pending row stays reviewable. */
  state_excerpt?: string;
  /** Read side: a ledger `annotation` op:"exclude" removed this row from counts and calibration. */
  excluded?: boolean;
  /** Read side: a ledger `annotation` op:"relabel" replaced the folded `outcome`. */
  annotated?: boolean;
}

/**
 * A correction event. The JSONL stays append-only: a bad row is answered with a
 * new line, never an edit. Ledger line kind:"annotation", folded on read.
 */
export interface AnnotationRecord {
  judgment_id: string;
  op: "relabel" | "exclude";
  outcome?: boolean;
  source: string;
  reason: string;
  ts: string;
}

/**
 * A priced refusal against a rule predicate, linked to the judgment it attaches
 * to. Ledger line kind:"refusal"; folded into a sidecar map on read. Slice 0 of
 * the rule-lifecycle spec (`.docs/SPECS/rule-lifecycle/rule-lifecycle.md`).
 */
export interface RefusalRecord {
  judgment_id: string;
  rule_id: string;
  witness: string;
  price: number | null;
  ts: string;
}

/** Result of the priced three-way decision. */
export interface Decision {
  action: "act" | "escalate";
  value: string | null;
  reason?: string;
  costs: { yes: number | null; no: number | null; escalate: number | null };
}

export interface ReliabilityBin {
  lo: number;
  hi: number;
  n: number;
  predicted: number;
  observed: number;
}
