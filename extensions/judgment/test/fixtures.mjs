// Shared record factory for tests.
export function judgeRecord(overrides = {}) {
  return {
    judgment_id: "q-1",
    ts: "2026-09-27T00:00:00.000Z",
    state_hash: "abc123",
    question_id: "q",
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
