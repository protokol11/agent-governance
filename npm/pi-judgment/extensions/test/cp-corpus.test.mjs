// Run: node --test test/cp-corpus.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mustCps, parseCorpus, shouldCps } from "../core/cp-corpus.ts";

const CORPUS_PATH = "C:/Users/HOME/.agents/skills/principles-render/rendered/cp-corpus.json";

function fixture() {
  return JSON.stringify({
    generated_from: "test",
    cps: [
      { id: "CP-02", severity: "must", statement: "Prefer complete construction." },
      { id: "CP-01", severity: "should", statement: "Favor composition." },
    ],
  });
}

test("parseCorpus accepts the emitted artifact from the live render", () => {
  const corpus = parseCorpus(readFileSync(CORPUS_PATH, "utf-8"));
  assert.equal(corpus.cps.length, 50);
  assert.equal(mustCps(corpus).length, 31);
  assert.equal(shouldCps(corpus).length, 19);
  for (const cp of corpus.cps) assert.ok(cp.statement.trim().length > 0);
});

test("parseCorpus validates a minimal fixture", () => {
  const corpus = parseCorpus(fixture());
  assert.equal(corpus.generated_from, "test");
  assert.deepEqual(
    corpus.cps.map((c) => c.id),
    ["CP-02", "CP-01"]
  );
});

test("parseCorpus rejects invalid JSON", () => {
  assert.throws(() => parseCorpus("{oops"), /invalid JSON/);
});

test("parseCorpus rejects non-object top level", () => {
  assert.throws(() => parseCorpus("[]"), /top level/);
  assert.throws(() => parseCorpus("{}"), /missing cps/);
});

test("parseCorpus rejects bad entries naming the CP", () => {
  assert.throws(
    () => parseCorpus(JSON.stringify({ cps: [{ id: "CP-02", severity: "maybe", statement: "x" }] })),
    /CP-02 bad severity/
  );
  assert.throws(
    () => parseCorpus(JSON.stringify({ cps: [{ id: "CP-02", severity: "must", statement: "  " }] })),
    /CP-02 missing statement/
  );
  assert.throws(
    () =>
      parseCorpus(
        JSON.stringify({
          cps: [
            { id: "CP-02", severity: "must", statement: "x" },
            { id: "CP-02", severity: "must", statement: "y" },
          ],
        })
      ),
    /duplicate id CP-02/
  );
});

test("must/should selectors partition by severity", () => {
  const corpus = parseCorpus(fixture());
  assert.deepEqual(
    mustCps(corpus).map((c) => c.id),
    ["CP-02"]
  );
  assert.deepEqual(
    shouldCps(corpus).map((c) => c.id),
    ["CP-01"]
  );
});
