// Run: node --test test/judge.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { judge } from "../core/judge.ts";

const QUESTIONS = { q: { type: "noul", instructions: "is it verified?" } };

const arrayLedger = (records) => ({ appendJudgment: (r) => records.push(r) });

function stub(reply, calls = []) {
  return {
    modelId: "stub/stub",
    callModel: async (system, user) => {
      calls.push({ system, user });
      return typeof reply === "function" ? reply() : reply;
    },
    ts: () => "2026-09-27T00:00:00.000Z",
  };
}

test("bad question returns errors, no model call, no record", async () => {
  const calls = [];
  const records = [];
  const res = await judge({}, { bad: { type: "noul", instructions: " " } }, arrayLedger(records), stub("x", calls));
  assert.equal(res.judgment_ids.length, 0);
  assert.equal(records.length, 0);
  assert.equal(calls.length, 0);
  assert.match(res.errors[0], /empty instructions/);
});

test("valid question records provenance=judge, outcome=null, stable keys", async () => {
  const records = [];
  const reply = JSON.stringify({ answers: { q: { value: "yes", confidence: 0.8 } } });
  const res = await judge({ x: 1 }, QUESTIONS, arrayLedger(records), stub(reply));
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.provenance, "judge");
  assert.equal(r.outcome, null);
  for (const key of [
    "judgment_id", "ts", "state_hash", "question_id", "type", "instructions",
    "criteria", "value", "confidence", "model", "provenance", "outcome",
  ]) {
    assert.ok(key in r, `missing key ${key}`);
  }
  assert.deepEqual(res.answers, { q: { value: "yes", confidence: 0.8 } });
});

test("unparseable model output retries once then errors without records", async () => {
  const calls = [];
  const records = [];
  const res = await judge({}, QUESTIONS, arrayLedger(records), stub("not json at all", calls));
  assert.equal(calls.length, 2, "exactly one retry");
  assert.equal(records.length, 0);
  assert.match(res.errors[0], /unparseable/);
});

test("ledger failure throws — judgment never passes unrecorded", async () => {
  const failingLedger = { appendJudgment() { throw new Error("disk full"); } };
  const reply = JSON.stringify({ answers: { q: { value: "yes", confidence: 0.8 } } });
  await assert.rejects(() => judge({}, QUESTIONS, failingLedger, stub(reply)), /disk full/);
});

const CP = { "cp-review:CP-22": { type: "noul", instructions: "Does this diff violate CP-22?" } };

test("cp-review request routes to the classifier with provenance=classifier", async () => {
  const records = [];
  const generativeCalls = [];
  let classifyCalls = 0;
  const res = await judge(
    { diff: "x", cp_texts: { "CP-22": "text" } },
    CP,
    arrayLedger(records),
    {
      modelId: "unused",
      callModel: async () => {
        generativeCalls.push(1);
        return "{}";
      },
      classifierModelId: "rlcd-local/cell-coder-1.5b",
      classify: async () => {
        classifyCalls++;
        return {
          stopReason: "stop",
          model: "rlcd-local/cell-coder-1.5b",
          answers: { "cp-review:CP-22": { type: "bool", probability: 0.7 } },
        };
      },
      ts: () => "2026-10-10T00:00:00.000Z",
    }
  );
  assert.equal(classifyCalls, 1);
  assert.equal(generativeCalls.length, 0, "generative model must not be called");
  assert.equal(records.length, 1);
  assert.equal(records[0].provenance, "classifier");
  assert.equal(records[0].model, "rlcd-local/cell-coder-1.5b");
  assert.equal(records[0].value, "yes");
  assert.equal(records[0].confidence, 0.7);
  assert.deepEqual(res.answers, { "cp-review:CP-22": { value: "yes", confidence: 0.7 } });
});

test("classifier failure returns errors and writes no record", async () => {
  const records = [];
  const res = await judge({}, CP, arrayLedger(records), {
    modelId: "unused",
    callModel: async () => {
      throw new Error("should not be called");
    },
    classify: async () => ({
      stopReason: "error",
      errorMessage: "ECONNREFUSED",
      model: "rlcd-local/cell-coder-1.5b",
      answers: {},
    }),
  });
  assert.equal(records.length, 0);
  assert.equal(Object.keys(res.answers).length, 0);
  assert.match(res.errors[0], /classifier unavailable: ECONNREFUSED/);
});

test("a mixed request keeps the generative path", async () => {
  const records = [];
  let classifyCalls = 0;
  const reply = JSON.stringify({ answers: { q: { value: "yes", confidence: 0.8 } } });
  await judge(
    {},
    { "cp-review:CP-22": { type: "noul", instructions: "x" }, q: { type: "noul", instructions: "y" } },
    arrayLedger(records),
    {
      modelId: "stub/stub",
      callModel: async () => reply,
      classify: async () => {
        classifyCalls++;
        return { stopReason: "stop", model: "c", answers: {} };
      },
    }
  );
  assert.equal(classifyCalls, 0);
  assert.equal(records[0].provenance, "judge");
});
