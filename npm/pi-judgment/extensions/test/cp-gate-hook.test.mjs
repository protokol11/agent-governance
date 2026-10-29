// Run: node --test test/cp-gate-hook.test.mjs
// Integration tests for the cp-review gate hook: drive the real listener with
// a stubbed registry/UI and a temp ledger. The scope-lock listener is
// listener[0]; the cp-review gate is listener[1].
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpGateHook } from "../core/gate-hook.ts";

const FIXTURE_CORPUS = JSON.stringify({
  cps: [{ id: "CP-01", severity: "should", statement: "Favor composition over inheritance." }],
});

function setup({ hasUI = true, classifyImpl, confirmResult = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cp-gate-hook-"));
  writeFileSync(join(dir, "corpus.json"), FIXTURE_CORPUS);
  process.env.CP_REVIEW_GATE = "on";
  process.env.CP_CORPUS_PATH = join(dir, "corpus.json");
  const notifications = [];
  const confirms = [];
  const ctx = {
    cwd: dir,
    hasUI,
    signal: undefined,
    ui: {
      notify: (msg) => notifications.push(msg),
      confirm: async (_t, msg) => {
        confirms.push(msg);
        return confirmResult;
      },
    },
    modelRegistry: {
      findOfType: (...args) =>
        args[0] === "classifier" ? { provider: "rlcd-local", id: "cell-coder-1.5b" } : undefined,
      classify: classifyImpl ?? (async () => ({ stopReason: "stop", provider: "rlcd-local", model: "cell-coder-1.5b", answers: { "cp-review:CP-01": { type: "bool", probability: 0.02 } } })),
    },
  };
  const gate = (event) => cpGateHook(event, ctx);
  return { dir, gate, ctx, notifications, confirms };
}

function writeEvent(content) {
  return { toolCallId: "t1", toolName: "write", input: { path: "a.ts", content } };
}

function ledgerLines(dir) {
  try {
    return readFileSync(join(dir, ".pi", "judgments.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

test("clean payload allows without UI interaction and records a classifier row", async () => {
  const { dir, gate, ctx, notifications, confirms } = setup();
  const res = await gate(writeEvent("const x = 1;"), ctx);
  assert.equal(res, undefined);
  assert.deepEqual(notifications, []);
  assert.deepEqual(confirms, []);
  const rows = ledgerLines(dir).filter((r) => r.provenance === "classifier");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].question_id, "cp-review:CP-01");
  rmSync(dir, { recursive: true, force: true });
});

test("violated should-CP blocks; confirm override allows and appends one refusal", async () => {
  const classifyImpl = async () => ({
    stopReason: "stop",
    provider: "rlcd-local",
    model: "cell-coder-1.5b",
    answers: { "cp-review:CP-01": { type: "bool", probability: 0.95 } },
  });
  const { dir, gate, ctx } = setup({ classifyImpl, confirmResult: true });
  const res = await gate(writeEvent("class A extends B {}"), ctx);
  assert.equal(res, undefined);
  const refusals = ledgerLines(dir).filter((r) => r.kind === "refusal");
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].rule_id, "cp-review-gate:operating-point");
  rmSync(dir, { recursive: true, force: true });

  const denied = setup({ classifyImpl, confirmResult: false });
  const res2 = await denied.gate(writeEvent("class A extends B {}"), denied.ctx);
  assert.equal(res2.block, true);
  assert.match(res2.reason, /user rejected/);
  assert.equal(ledgerLines(denied.dir).filter((r) => r.kind === "refusal").length, 0);
  rmSync(denied.dir, { recursive: true, force: true });
});

test("classifier error escalates: confirm with UI, block without; no judgment row", async () => {
  const classifyImpl = async () => ({ stopReason: "error", errorMessage: "sidecar down", answers: {} });
  const { dir, gate, ctx } = setup({ classifyImpl });
  const res = await gate(writeEvent("anything"), ctx);
  assert.equal(res, undefined); // user confirmed the escalation
  assert.equal(ledgerLines(dir).filter((r) => r.provenance === "classifier").length, 0);
  // The refusal must link a real row: the escalation confirm fact recorded as
  // a rule judgment (incident 2026-10-12 — a dangling judgment_id bricked the
  // whole read path in another session).
  const refusals = ledgerLines(dir).filter((r) => r.kind === "refusal");
  assert.equal(refusals.length, 1);
  const linked = ledgerLines(dir).filter((r) => r.kind === "judgment" && r.judgment_id === refusals[0].judgment_id);
  assert.equal(linked.length, 1);
  assert.equal(linked[0].provenance, "code");
  assert.equal(linked[0].model, "rule:cp-gate-confirm");
  rmSync(dir, { recursive: true, force: true });

  const noUI = setup({ classifyImpl, hasUI: false });
  const res2 = await noUI.gate(writeEvent("anything"), noUI.ctx);
  assert.equal(res2.block, true);
  assert.match(res2.reason, /classifier failure/);
  assert.match(res2.reason, /no UI/);
  assert.equal(ledgerLines(noUI.dir).length, 0);
  rmSync(noUI.dir, { recursive: true, force: true });
});

test("verdict-override refusal links the classifier judgment row of the violated CP", async () => {
  const classifyImpl = async () => ({
    stopReason: "stop",
    provider: "rlcd-local",
    model: "cell-coder-1.5b",
    answers: { "cp-review:CP-01": { type: "bool", probability: 0.95 } },
  });
  const { dir, gate, ctx } = setup({ classifyImpl, confirmResult: true });
  const res = await gate(writeEvent("class A extends B {}"), ctx);
  assert.equal(res, undefined);
  const refusals = ledgerLines(dir).filter((r) => r.kind === "refusal");
  assert.equal(refusals.length, 1);
  const linked = ledgerLines(dir).filter(
    (r) => r.kind === "judgment" && r.judgment_id === refusals[0].judgment_id && r.provenance === "classifier"
  );
  assert.equal(linked.length, 1);
  assert.equal(linked[0].question_id, "cp-review:CP-01");
  rmSync(dir, { recursive: true, force: true });
});

test("oversized payload notifies and does not classify", async () => {
  const { dir, gate, ctx, notifications } = setup();
  const res = await gate(writeEvent("x".repeat(4001)), ctx);
  assert.equal(res, undefined);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /UNREVIEWED/);
  assert.equal(ledgerLines(dir).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("missing corpus notifies (degrades open) and does not classify", async () => {
  const { dir, gate, ctx, notifications } = setup();
  const saved = process.env.CP_CORPUS_PATH;
  process.env.CP_CORPUS_PATH = join(dir, "nope.json");
  try {
    const res = await gate(writeEvent("const y = 2;"), ctx);
    assert.equal(res, undefined);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /own infra down/);
    assert.equal(ledgerLines(dir).length, 0);
  } finally {
    delete process.env.CP_CORPUS_PATH;
  }
  rmSync(dir, { recursive: true, force: true });
});

test("gate is off by default; CP_REVIEW_GATE=on arms it", async () => {
  // Default off: no classification, no ledger rows.
  const bare = setup();
  delete process.env.CP_REVIEW_GATE;
  try {
    const res = await bare.gate(writeEvent("const z = 3;"));
    assert.equal(res, undefined);
    assert.equal(ledgerLines(bare.dir).length, 0);
  } finally {
    process.env.CP_REVIEW_GATE = "on";
  }
  rmSync(bare.dir, { recursive: true, force: true });

  // Explicit on: classification runs.
  const armed = setup();
  try {
    const res = await armed.gate(writeEvent("const z = 3;"));
    assert.equal(res, undefined);
    assert.equal(ledgerLines(armed.dir).filter((r) => r.provenance === "classifier").length, 1);
  } finally {
    delete process.env.CP_REVIEW_GATE;
  }
  rmSync(armed.dir, { recursive: true, force: true });
});

test("registered must-lint predicate blocks without confirm and without classifying", async () => {
  const { lintRegistry } = await import("../core/cp-gate.ts");
  const probe = { id: "CP-02", check: (content) => (content.includes("hack") ? "ad-hoc construction" : null) };
  lintRegistry.push(probe);
  try {
    const { dir, gate, ctx, confirms } = setup();
    const res = await gate(writeEvent("hack shortcut"), ctx);
    assert.equal(res.block, true);
    assert.match(res.reason, /CP-02/);
    assert.deepEqual(confirms, []);
    assert.equal(ledgerLines(dir).length, 0);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    lintRegistry.splice(lintRegistry.indexOf(probe), 1);
  }
});

