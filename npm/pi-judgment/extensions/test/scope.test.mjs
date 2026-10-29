// Run: node --test test/scope.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { decide } from "../core/policy.ts";
import {
  SCOPE_COSTS,
  buildScopeRecord,
  buildScopeState,
  countScopeResolved,
  detectTrigger,
  extractUserTexts,
  hookCheck,
  sessionIdFromParent,
} from "../core/scope.ts";
import { judgeRecord } from "./fixtures.mjs";

const SESSION = "session-a";

/** A well-formed scope-lock row: the gate allowed, in SESSION. */
function allowRow(overrides = {}) {
  return judgeRecord({
    question_id: "scope-lock",
    session_id: SESSION,
    value: "yes",
    decision: { action: "allow", value: "yes", pricedBy: "scope-lock" },
    ...overrides,
  });
}

test("detectTrigger finds explicit implement triggers (ru + en)", () => {
  assert.equal(detectTrigger(["давай сделай это"]), true);
  assert.equal(detectTrigger(["please implement the spec"]), true);
  assert.equal(detectTrigger(["BUILD IT now"]), true);
  assert.equal(detectTrigger(["давай обсудим архитектуру"]), false);
  assert.equal(detectTrigger([]), false);
});

test("extractUserTexts pulls only user text blocks", () => {
  const entries = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "сделай" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ок" }] } },
    { type: "message", message: { role: "user", content: "plain string" } },
  ];
  assert.deepEqual(extractUserTexts(entries), ["сделай", "plain string"]);
});

test("hookCheck blocks without a session-bound allow decision", () => {
  const block = hookCheck([]);
  assert.equal(block.allow, false);
  assert.match(block.reason, /scope_lock/);
  assert.match(block.reason, /Scope lock/);
  // A decision without the session to match cannot authorize anything.
  assert.equal(hookCheck([allowRow()]).allow, false, "no sessionId argument → nothing matches");
});

test("hookCheck session matrix: authorization is a decision bound to this session", () => {
  const cases = [
    ["same session + allow", [allowRow()], { sessionId: SESSION }, true],
    ["other session + allow", [allowRow({ session_id: "session-b" })], { sessionId: SESSION }, false],
    [
      "legacy row, no session_id, outcome:true",
      [judgeRecord({ question_id: "scope-lock", outcome: true })],
      { sessionId: SESSION },
      false,
    ],
    ["allow decision on a legacy row without session_id", [allowRow({ session_id: undefined })], { sessionId: SESSION }, false],
    ["same session + deny", [allowRow({ decision: { action: "deny", value: "no" } })], { sessionId: SESSION }, false],
    ["same session + escalate", [allowRow({ decision: { action: "escalate" } })], { sessionId: SESSION }, false],
    ["same session + allow + excluded", [allowRow({ excluded: true })], { sessionId: SESSION }, false],
    ["wrong question id", [allowRow({ question_id: "other" })], { sessionId: SESSION }, false],
    ["inherit (subagent access list)", [], { sessionId: SESSION, inherit: true }, true],
    ["gate off", [], { sessionId: SESSION, gateEnabled: false }, true],
  ];
  for (const [name, rows, options, expected] of cases) {
    assert.equal(hookCheck(rows, options).allow, expected, name);
  }
});

test("hookCheck never derives authorization from outcome", () => {
  // The whole point of the split: a true claim about a past session is not an
  // authorization for this one, and this session's allow is not a true claim.
  const resolvedElsewhere = allowRow({ session_id: "session-b", outcome: true });
  assert.equal(hookCheck([resolvedElsewhere], { sessionId: SESSION }).allow, false);
  const autoAllowed = allowRow({ outcome: null });
  assert.equal(hookCheck([autoAllowed], { sessionId: SESSION }).allow, true);
});

test("hookCheck inherits an ancestor session's allow (subagent chain)", () => {
  const parentAllow = allowRow({ session_id: "parent-a" });
  assert.equal(hookCheck([parentAllow], { sessionId: SESSION }).allow, false, "no ancestors → no inheritance");
  assert.equal(
    hookCheck([parentAllow], { sessionId: SESSION, ancestors: ["parent-a"] }).allow,
    true,
    "the parent's allow authorizes the child"
  );
  assert.equal(
    hookCheck([parentAllow], { sessionId: SESSION, ancestors: ["someone-else"] }).allow,
    false,
    "an unrelated ancestor authorizes nothing"
  );
  const parentDeny = allowRow({ session_id: "parent-a", decision: { action: "deny", value: "no" } });
  assert.equal(hookCheck([parentDeny], { sessionId: SESSION, ancestors: ["parent-a"] }).allow, false, "a parent deny does not authorize");
  const excludedParent = allowRow({ session_id: "parent-a", excluded: true });
  assert.equal(hookCheck([excludedParent], { sessionId: SESSION, ancestors: ["parent-a"] }).allow, false, "an excluded parent row does not authorize");
  assert.equal(
    hookCheck([allowRow()], { sessionId: SESSION, ancestors: ["parent-a"] }).allow,
    true,
    "the session's own allow still counts"
  );
});

test("sessionIdFromParent reads the id out of a session file path", () => {
  const id = "01a17385-dbbd-73f1-8806-fecf5a4f2d16";
  assert.equal(sessionIdFromParent("C:\\sessions\\2026-10-25T14-45-14-820Z_" + id + ".jsonl"), id);
  assert.equal(sessionIdFromParent("/home/x/sessions/2026-10-25T14-45-14-820Z_" + id + ".jsonl"), id);
  assert.equal(sessionIdFromParent(id), id, "a bare id passes through");
  assert.equal(sessionIdFromParent(null), null);
  assert.equal(sessionIdFromParent(""), null);
});

test("an excluded scope-lock row never authorizes and is not evidence", () => {
  const excluded = allowRow({ excluded: true, outcome: true });
  assert.equal(hookCheck([excluded], { sessionId: SESSION }).allow, false, "exclude removes the row from every count");
  assert.equal(countScopeResolved([excluded]), 0, "an excluded row is not evidence volume");

  const kept = allowRow({ outcome: true });
  assert.equal(hookCheck([kept], { sessionId: SESSION }).allow, true, "a non-excluded row still authorizes");
  assert.equal(countScopeResolved([kept]), 1);
  assert.equal(countScopeResolved([{ ...kept, excluded: false }]), 1, "explicit false is not excluded");
});

test("countScopeResolved counts human truth only (auto decisions are not evidence)", () => {
  const autoAllow = allowRow({ outcome: null });
  const humanAnswer = allowRow({ outcome: true });
  assert.equal(countScopeResolved([autoAllow]), 0, "an auto decision carries no truth, so it is not evidence");
  assert.equal(countScopeResolved([autoAllow, humanAnswer]), 1);
  assert.equal(countScopeResolved([allowRow({ question_id: "other", outcome: true })]), 0, "other questions are not scope evidence");
});

test("countScopeResolved counts only post-ADR-0045 rows with a human truth (2026-10-25 warmup evidence)", () => {
  // The min-sample gate warms on human answers. A legacy row has a boolean
  // outcome that is a policy action, not truth, and no session_id, so it cannot
  // warm the gate.
  const legacy = {
    question_id: "scope-lock",
    provenance: "judge",
    outcome: true,
  };
  assert.equal(countScopeResolved([legacy]), 0, "a legacy row with no session_id is not evidence");
  assert.equal(
    countScopeResolved([{ ...legacy, session_id: null }]),
    0,
    "an explicit null session_id is still not a gate-written row"
  );

  const decisionBearing = allowRow({ outcome: true });
  assert.equal(countScopeResolved([decisionBearing]), 1, "a session-bound row with a boolean outcome counts once");

  const auto = allowRow({ outcome: null });
  assert.equal(countScopeResolved([auto]), 0, "an auto row carries no human truth");

  const excluded = allowRow({ outcome: true, excluded: true });
  assert.equal(countScopeResolved([excluded]), 0, "an excluded row is not evidence");

  assert.equal(
    countScopeResolved([legacy, decisionBearing, auto, excluded]),
    1,
    "only the single human-checked, session-bound row counts"
  );
});

test("buildScopeRecord: an auto decision writes outcome null and keeps the decision", () => {
  const record = buildScopeRecord({
    judgment_id: "sl-1",
    ts: "2026-10-25T00:00:00.000Z",
    state_hash: "h1",
    instructions: "do the user's messages authorize the scope?",
    value: "yes",
    confidence: 0.85,
    model: "mock/mock",
    provenance: "judge",
    decision: { action: "allow", value: "yes", pricedBy: "scope-lock" },
    authorized: null,
    sessionId: SESSION,
    stateExcerpt: "declared scope + user tail",
  });
  assert.equal(record.outcome, null, "nobody checked the claim → not ground truth");
  assert.deepEqual(record.decision, { action: "allow", value: "yes", pricedBy: "scope-lock" });
  assert.equal(record.session_id, SESSION);
  assert.equal(record.state_excerpt, "declared scope + user tail");
  assert.equal(record.question_id, "scope-lock");
  assert.equal(record.type, "noul");
});

test("buildScopeRecord: outcome is the truth of the recorded claim, not the gate action", () => {
  const build = (value, authorized, action = "allow") =>
    buildScopeRecord({
      judgment_id: "sl-2",
      ts: "2026-10-25T00:00:00.000Z",
      state_hash: "h2",
      instructions: "do the user's messages authorize the scope?",
      value,
      confidence: 0.6,
      model: "mock/mock",
      provenance: "judge",
      decision: { action, value, pricedBy: "scope-lock" },
      authorized,
      sessionId: SESSION,
      stateExcerpt: "scope",
    });

  assert.equal(build("yes", true).outcome, true, "claim 'user authorizes' + human yes → true");
  assert.equal(build("no", false, "deny").outcome, true, "claim 'user does not authorize' + human no → true");
  assert.equal(build("no", true).outcome, false, "claim 'no' + human yes → false");
  assert.equal(build("yes", false, "deny").outcome, false, "claim 'yes' + human no → false");
});

test("buildScopeState marks trigger detection in the judge state", () => {
  const state = buildScopeState("fix bug X", ["пожалуйста сделай"]);
  assert.equal(state.trigger_detected, true);
  assert.equal(state.declared_scope, "fix bug X");
  assert.ok(state.user_messages_tail.includes("сделай"));
});

test("scope costs: cold start (0 resolved) escalates even with trigger p=0.95", () => {
  const d = decide(0.95, { ...SCOPE_COSTS, resolvedCount: 0 });
  assert.equal(d.action, "escalate", "HUMAN-JUDGMENT-FINAL: below minSample must ask");
});

test("scope costs: the middle band asks the human (10/2/1, minSample 3)", () => {
  const at = (p) => decide(p, { ...SCOPE_COSTS, resolvedCount: 3 }).action;
  assert.equal(at(0.49), "act");
  assert.equal(decide(0.49, { ...SCOPE_COSTS, resolvedCount: 3 }).value, "no");
  for (const p of [0.5, 0.68, 0.8, 0.85, 0.9]) {
    assert.equal(at(p), "escalate", `p=${p} must reach the owner`);
  }
  for (const p of [0.91, 0.95]) {
    assert.equal(at(p), "act", `p=${p} is above the band`);
    assert.equal(decide(p, { ...SCOPE_COSTS, resolvedCount: 3 }).value, "yes");
  }
});
