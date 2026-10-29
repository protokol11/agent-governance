// Run: node --test test/ledger.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAnnotation, appendJudgment, appendResolution, countResolved, readJudgments } from "../core/ledger.ts";
import { judgeRecord } from "./fixtures.mjs";

test("ledger is newline-delimited JSON; first line parses standalone", () => {
  const dir = mkdtempSync(join(tmpdir(), "judgment-"));
  try {
    const path = join(dir, "nested", "judgments.jsonl");
    appendJudgment(path, judgeRecord({ judgment_id: "a" }));
    appendJudgment(path, judgeRecord({ judgment_id: "b", confidence: 0.9 }));
    const first = readFileSync(path, "utf8").split("\n")[0];
    assert.doesNotThrow(() => JSON.parse(first));
    const records = readJudgments(path);
    assert.equal(records.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolutions are folded into records on read (append-only)", () => {
  const dir = mkdtempSync(join(tmpdir(), "judgment-"));
  try {
    const path = join(dir, "judgments.jsonl");
    appendJudgment(path, judgeRecord({ judgment_id: "a" }));
    assert.equal(readJudgments(path)[0].outcome, null);
    appendResolution(path, "a", true, "t");
    const records = readJudgments(path);
    assert.equal(records.length, 1, "resolution must not duplicate the record");
    assert.equal(records[0].outcome, true);
    assert.equal(countResolved(records), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relabel annotation overrides the folded outcome", () => {
  const dir = mkdtempSync(join(tmpdir(), "judgment-"));
  try {
    const path = join(dir, "judgments.jsonl");
    appendJudgment(path, judgeRecord({ judgment_id: "a" }));
    appendResolution(path, "a", false, "t");
    const before = readJudgments(path);
    assert.equal(before[0].outcome, false);
    appendAnnotation(path, {
      judgment_id: "a",
      op: "relabel",
      outcome: true,
      source: "owner",
      reason: "outcome held the gate action, not claim truth",
      ts: "t2",
    });
    const after = readJudgments(path);
    assert.equal(after.length, 1, "an annotation must not duplicate the record");
    assert.equal(after[0].outcome, true);
    assert.equal(after[0].annotated, true);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 3, "ledger lines stay append-only");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exclude annotation marks the row on read", () => {
  const dir = mkdtempSync(join(tmpdir(), "judgment-"));
  try {
    const path = join(dir, "judgments.jsonl");
    appendJudgment(path, judgeRecord({ judgment_id: "a", outcome: true }));
    appendAnnotation(path, {
      judgment_id: "a",
      op: "exclude",
      source: "owner",
      reason: "batch stored the violation flag as the outcome",
      ts: "t2",
    });
    const records = readJudgments(path);
    assert.equal(records.length, 1);
    assert.equal(records[0].excluded, true);
    assert.equal(records[0].outcome, true, "exclude hides the row, it does not rewrite it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dangling annotation warns and is skipped, never fatal", () => {
  const dir = mkdtempSync(join(tmpdir(), "judgment-"));
  try {
    const path = join(dir, "judgments.jsonl");
    appendJudgment(path, judgeRecord({ judgment_id: "a" }));
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    let records;
    try {
      appendAnnotation(path, {
        judgment_id: "missing",
        op: "relabel",
        outcome: true,
        source: "owner",
        reason: "orphan",
        ts: "t2",
      });
      records = readJudgments(path);
    } finally {
      console.warn = original;
    }
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, null, "the orphan line must not touch a real row");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unknown judgment_id: missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a relabel without a boolean outcome warns and is skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "judgment-"));
  try {
    const path = join(dir, "judgments.jsonl");
    appendJudgment(path, judgeRecord({ judgment_id: "a" }));
    appendResolution(path, "a", false, "t");
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    let records;
    try {
      appendAnnotation(path, {
        judgment_id: "a",
        op: "relabel",
        source: "owner",
        reason: "no outcome recorded",
        ts: "t2",
      });
      records = readJudgments(path);
    } finally {
      console.warn = original;
    }
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, false, "a relabel with no boolean outcome must not touch the row");
    assert.equal(records[0].annotated, undefined, "a skipped relabel leaves no annotated mark");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /skipping relabel without a boolean outcome: a/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a later resolution overwrites an earlier relabel (last writer wins)", () => {
  const dir = mkdtempSync(join(tmpdir(), "judgment-"));
  try {
    const path = join(dir, "judgments.jsonl");
    appendJudgment(path, judgeRecord({ judgment_id: "a" }));
    appendAnnotation(path, {
      judgment_id: "a",
      op: "relabel",
      outcome: true,
      source: "owner",
      reason: "first correction",
      ts: "t1",
    });
    assert.equal(readJudgments(path)[0].outcome, true);
    appendResolution(path, "a", false, "t2");
    assert.equal(readJudgments(path)[0].outcome, false, "append order decides: the resolution lands last");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendJudgment truncates state_excerpt to 400 chars", () => {
  const dir = mkdtempSync(join(tmpdir(), "judgment-"));
  try {
    const path = join(dir, "judgments.jsonl");
    appendJudgment(path, judgeRecord({ judgment_id: "a", state_excerpt: "x".repeat(1000) }));
    const stored = JSON.parse(readFileSync(path, "utf8").trim());
    assert.equal(stored.state_excerpt.length, 400);
    assert.equal(readJudgments(path)[0].state_excerpt.length, 400);
    appendJudgment(path, judgeRecord({ judgment_id: "b", state_excerpt: "short" }));
    assert.equal(readJudgments(path)[1].state_excerpt, "short");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
