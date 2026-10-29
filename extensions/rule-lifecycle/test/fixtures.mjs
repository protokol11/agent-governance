// Shared record factories for rule-lifecycle tests. Fixture-ledger only:
// no live ledger, no model calls.
export function record(overrides = {}) {
  return {
    judgment_id: "j-1",
    ts: "2026-10-02T00:00:00.000Z",
    state_hash: "h-1",
    question_id: "cp-review:CP-01",
    type: "noul",
    instructions: "judge it",
    criteria: null,
    value: "yes",
    confidence: 0.5,
    model: "mock/mock",
    provenance: "judge",
    outcome: null,
    ...overrides,
  };
}

export function refusal(overrides = {}) {
  return {
    judgment_id: "j-1",
    rule_id: "CP-50",
    witness: "w-1",
    price: 1,
    ts: "2026-10-02T00:00:00.000Z",
    ...overrides,
  };
}

/** Build a refusal map keyed by judgment_id. */
export function refusalMap(rows) {
  return new Map(rows.map((r) => [r.judgment_id, r]));
}
