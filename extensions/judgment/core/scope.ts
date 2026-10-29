// core/scope.ts — scope-lock gate: deterministic predicate first, judge on the
// residue, hook-check for enforcement. Pure functions only; model/UI live in
// index.ts. Prior art: DS-SEC-03 (authorize sensitive sinks independently),
// DS-SEC-05 (dual-judge: rule judge + semantic judge), SK-ORCH-02 (access list).
import type { JudgmentRecord, Provenance } from "./types.ts";

/** Explicit implementation triggers (AGENTS.md session-mode triggers). */
export const TRIGGERS = [
  "сделай",
  "коди",
  "внедри",
  "implement",
  "implementation",
  "build it",
  "do it",
];

/** RuleJudge: is there an explicit implement trigger in the user's messages? */
export function detectTrigger(userTexts: string[]): boolean {
  const hay = userTexts.join("\n").toLowerCase();
  return TRIGGERS.some((t) => hay.includes(t));
}

/** Extract user text from session branch entries (pure; entries are plain data). */
export function extractUserTexts(entries: Array<{ type?: string; message?: { role?: string; content?: unknown } }>): string[] {
  const texts: string[] = [];
  for (const entry of entries) {
    const message = entry?.message;
    if (!message || message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
          texts.push(String((block as { text?: unknown }).text ?? ""));
        }
      }
    }
  }
  return texts;
}

/**
 * Hook decision for a mutating tool call. Deterministic only — no model.
 * Returns allow, or a block reason telling the agent how to authorize.
 *
 * Authorization is a DECISION, not truth (ADR-0045). The hook therefore reads
 * `decision.action` and the `session_id` the gate bound it to, and never
 * `outcome`: `outcome` answers "was the claim true?", so a historical `true`
 * row is a fact about a past session and must not unlock this one. Two
 * consequences are deliberate:
 *   - authorization is session-bound — the scope the owner approved is the
 *     work it approved, not every future task in the repo;
 *   - legacy rows (no `decision`, no `session_id`) fail closed. Failing closed
 *     once costs one `scope_lock` call; a silent global allow costs the gate.
 * An excluded row never authorizes: the owner removed it from every count.
 * Inheritance has two channels. A subagent runs in its own session, so it
 * carries no row of its own; the hook therefore accepts an `allow` row from a
 * named ancestor session (`ancestors`), derived from the session header's
 * `parentSession`. The env flag `PI_SCOPE_LOCK=inherit` stays only for external
 * CLI agents, which are separate processes and cannot pass a session list.
 */
export function hookCheck(
  records: ScopeHookRecord[],
  {
    sessionId = null,
    ancestors = [],
    inherit = false,
    gateEnabled = true,
  }: {
    sessionId?: string | null;
    /** Session ids whose authorization this session inherits (subagent chain). */
    ancestors?: string[];
    inherit?: boolean;
    gateEnabled?: boolean;
  } = {}
): { allow: boolean; reason?: string } {
  if (!gateEnabled) return { allow: true };
  if (inherit) return { allow: true }; // external CLI: separate process, no session list
  const allowed = new Set<string>();
  if (typeof sessionId === "string") allowed.add(sessionId);
  for (const id of ancestors) if (typeof id === "string" && id) allowed.add(id);
  const authorized = records.some(
    (r) =>
      r.question_id === "scope-lock" &&
      r.excluded !== true &&
      typeof r.session_id === "string" &&
      allowed.has(r.session_id) &&
      r.decision?.action === "allow"
  );
  if (authorized) return { allow: true };
  return {
    allow: false,
    reason:
      "Scope lock: no authorized scope judgment for this session. " +
      "Call the scope_lock tool with your declared scope before mutating files.",
  };
}

/** The authorization-bearing fields of a ledger row (the only ones the hook reads). */
export interface ScopeHookRecord {
  question_id: string;
  excluded?: boolean;
  /** Session the gate bound its decision to. Absent on legacy rows → never authorizes. */
  session_id?: string | null;
  /** What the gate did. The hook reads `action`, never `outcome`. */
  decision?: { action: "act" | "escalate" | "allow" | "deny"; value?: string | null; pricedBy?: string } | null;
}

/**
 * The parent session id a subagent inherits from. `parentSession` is a session
 * file path (`<timestamp>_<id>.jsonl`); a bare id is accepted as-is. A path
 * without the `<id>` suffix returns null, which fails closed.
 */
export function sessionIdFromParent(parentSession: string | null | undefined): string | null {
  if (!parentSession) return null;
  const base = parentSession.replace(/\\/g, "/").split("/").pop() ?? "";
  if (!base.endsWith(".jsonl")) return base || null;
  const stem = base.slice(0, -".jsonl".length);
  const sep = stem.lastIndexOf("_");
  const id = sep >= 0 ? stem.slice(sep + 1) : stem;
  return id || null;
}

/** Judge prompt state for the residue case (no explicit trigger found). */
export function buildScopeState(declaredScope: string, userTexts: string[]): {
  declared_scope: string;
  trigger_detected: boolean;
  user_messages_tail: string;
} {
  return {
    declared_scope: declaredScope,
    trigger_detected: detectTrigger(userTexts),
    user_messages_tail: userTexts.join("\n---\n").slice(-2000),
  };
}

export const SCOPE_QUESTION = {
  id: "scope-lock",
  question: {
    type: "noul" as const,
    instructions:
      "Do the user's messages authorize implementing the declared scope in this session? " +
      "Answer yes only if an explicit implementation request covers this scope.",
  },
};

/** Priced decision costs for scope-lock. A wrong deny costs as much as asking
 * (a wasted turn plus blocked work), so denial is priced above escalation; a
 * wrong allow stays the most expensive. Truth table at minSample 3:
 * `p > 0.9` → yes, `0.5 ≤ p ≤ 0.9` → escalate (exact ties go to the human),
 * `p < 0.5` → no. */
export const SCOPE_COSTS = { costFalseYes: 10, costFalseNo: 2, costEscalate: 1, minSample: 3 };

/** A ledger row that carries the gate's decision next to the claim it judged. */
export type ScopeRecord = JudgmentRecord & { session_id: string | null };

export interface BuildScopeRecordInput {
  judgment_id: string;
  ts: string;
  state_hash: string;
  instructions: string;
  /** The claim under judgment ("yes" = the user authorizes this scope). */
  value: string;
  /** P(`value` is correct). */
  confidence: number;
  model: string;
  provenance: Provenance;
  /** What the gate did. Never derived from `outcome`. */
  decision: { action: "act" | "escalate" | "allow" | "deny"; value?: string | null; pricedBy?: string };
  /** The human's answer, or null when nobody was asked (auto decision). */
  authorized: boolean | null;
  sessionId: string | null;
  /** Bounded copy of the declared scope + user tail (ledger caps it at 400). */
  stateExcerpt: string;
}

/**
 * Build one scope-lock row: the decision/truth split in one place (ADR-0045).
 * `outcome` is the truth of the recorded claim and is written only when a human
 * answered; an autonomous allow/deny leaves it null and stays in the review
 * queue. `decision` is trace for the hook. Pure — the ledger does the writing.
 */
export function buildScopeRecord(input: BuildScopeRecordInput): ScopeRecord {
  return {
    judgment_id: input.judgment_id,
    ts: input.ts,
    state_hash: input.state_hash,
    question_id: SCOPE_QUESTION.id,
    type: "noul",
    instructions: input.instructions,
    criteria: null,
    value: input.value,
    confidence: input.confidence,
    model: input.model,
    provenance: input.provenance,
    outcome:
      input.authorized === null ? null : (input.value === "yes") === input.authorized,
    decision: input.decision,
    session_id: input.sessionId,
    state_excerpt: input.stateExcerpt,
  };
}

/**
 * Evidence volume for the min-sample gate: scope-lock rows with a human truth.
 * Under ADR-0045 an auto decision carries `outcome: null`, so only rows a human
 * checked are evidence — the gate warms on answers, not on its own choices.
 * The `session_id` requirement is the same rule read from the row: only rows the
 * gate wrote after ADR-0045 carry it, so a legacy row whose boolean `outcome` is
 * a policy action (not human truth) cannot warm the gate. An excluded row is not
 * evidence either.
 */
export function countScopeResolved(
  records: Array<{
    question_id: string;
    provenance: string;
    outcome: boolean | null;
    excluded?: boolean;
    session_id?: string | null;
  }>
): number {
  return records.filter(
    (r) =>
      r.question_id === "scope-lock" &&
      (r.provenance === "judge" || r.provenance === "code") &&
      r.excluded !== true &&
      typeof r.session_id === "string" &&
      typeof r.outcome === "boolean"
  ).length;
}
