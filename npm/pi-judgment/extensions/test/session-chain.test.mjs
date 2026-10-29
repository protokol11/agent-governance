// Run: node --test test/session-chain.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_CHAIN_DEPTH, readSessionHeader, resolveSessionChain } from "../core/session-chain.ts";
import { hookCheck } from "../core/scope.ts";

const DIR = mkdtempSync(join(tmpdir(), "judgment-chain-"));

/** A session file whose header names its parent, matching pi's own layout. */
function sessionFile(id, { cwd = null, parentSession = null } = {}) {
  const path = join(DIR, `2026-10-27T10-00-00-000Z_${id}.jsonl`);
  const header = { type: "session", version: 3, id, timestamp: "2026-10-27T10:00:00.000Z" };
  if (cwd) header.cwd = cwd;
  if (parentSession) header.parentSession = parentSession;
  writeFileSync(path, JSON.stringify(header) + "\n" + JSON.stringify({ type: "model_change" }) + "\n");
  return path;
}

test("readSessionHeader reads the first line only, whatever follows", () => {
  const path = join(DIR, "huge.jsonl");
  const header = { type: "session", id: "aaa", cwd: "C:/proj" };
  writeFileSync(path, JSON.stringify(header) + "\n" + "x".repeat(200_000) + "\n");
  assert.deepEqual(readSessionHeader(path), header);
});

test("readSessionHeader fails closed on a missing file, bad JSON, or a foreign first line", () => {
  assert.equal(readSessionHeader(join(DIR, "nope.jsonl")), null);
  const bad = join(DIR, "bad.jsonl");
  writeFileSync(bad, "not json\n");
  assert.equal(readSessionHeader(bad), null);
  const foreign = join(DIR, "foreign.jsonl");
  writeFileSync(foreign, JSON.stringify({ type: "message", id: "x" }) + "\n");
  assert.equal(readSessionHeader(foreign), null);
});

test("resolveSessionChain walks to the root session and collects every ancestor", () => {
  const root = sessionFile("root0001", { cwd: "C:/Users/HOME/Desktop/Agentic-Engineering" });
  const parent = sessionFile("parent01", { cwd: "C:/elsewhere", parentSession: root });
  sessionFile("child001", { cwd: "C:/Users/HOME/.pi/agent/extensions/judgment", parentSession: parent });

  // The argument is the chain START (the direct parent), not the current session.
  const chain = resolveSessionChain(parent);
  assert.deepEqual(chain.ancestors, ["parent01", "root0001"], "nearest parent first, root last");
  assert.equal(
    chain.rootCwd,
    "C:/Users/HOME/Desktop/Agentic-Engineering",
    "the root project owns the ledger, not the child cwd"
  );
});

test("resolveSessionChain stops at a cycle instead of looping", () => {
  const a = join(DIR, `2026-10-27T10-00-00-000Z_cycleA.jsonl`);
  const b = join(DIR, `2026-10-27T10-00-00-000Z_cycleB.jsonl`);
  writeFileSync(a, JSON.stringify({ type: "session", id: "cycleA", cwd: "C:/a", parentSession: b }) + "\n");
  writeFileSync(b, JSON.stringify({ type: "session", id: "cycleB", cwd: "C:/b", parentSession: a }) + "\n");

  const chain = resolveSessionChain(a);
  assert.deepEqual(chain.ancestors, ["cycleA", "cycleB"]);
  assert.equal(chain.rootCwd, "C:/b", "the last readable header wins");
});

test("resolveSessionChain caps the depth so a runaway chain cannot cost a file read each", () => {
  let prev = sessionFile("deep0000", { cwd: "C:/deep" });
  for (let i = 1; i <= MAX_CHAIN_DEPTH + 2; i++) {
    prev = sessionFile(`deep000${i}`, { cwd: `C:/deep/${i}`, parentSession: prev });
  }
  const chain = resolveSessionChain(prev);
  assert.equal(chain.ancestors.length, MAX_CHAIN_DEPTH);
});

test("resolveSessionChain keeps an unreadable parent id but reports no root cwd", () => {
  const missing = join(DIR, "2026-10-27T10-00-00-000Z_ghost001.jsonl");
  const chain = resolveSessionChain(missing);
  assert.deepEqual(chain.ancestors, ["ghost001"]);
  assert.equal(chain.rootCwd, null, "an unreadable chain must not invent a cwd");
});

test("a bare id is an ancestor but is never handed to the reader (no fs read)", () => {
  const calls = [];
  const readHeader = (path) => {
    calls.push(path);
    return { cwd: DIR };
  };
  const chain = resolveSessionChain("bare-id-123", readHeader);
  assert.deepEqual(chain, { ancestors: ["bare-id-123"], rootCwd: null });
  assert.deepEqual(calls, [], "an unvalidated path must not reach the reader at all");
  // Same answer with the real reader, which refuses before its open().
  assert.deepEqual(resolveSessionChain("bare-id-123"), { ancestors: ["bare-id-123"], rootCwd: null });
  assert.equal(readSessionHeader("bare-id-123"), null, "a bare id never resolves against process.cwd()");
  assert.equal(readSessionHeader(DIR), null, "a directory is not a session file");
  assert.equal(readSessionHeader("relative/session.jsonl"), null, "a relative path is refused too");
});

test("a header whose cwd is relative cannot become rootCwd", () => {
  const relative = join(DIR, "2026-10-27T10-00-00-000Z_rel00001.jsonl");
  writeFileSync(relative, JSON.stringify({ type: "session", id: "rel00001", cwd: "relative/proj" }) + "\n");
  const chain = resolveSessionChain(relative);
  assert.deepEqual(chain.ancestors, ["rel00001"]);
  assert.equal(chain.rootCwd, null, "a relative cwd would resolve against OUR cwd");

  // An inherited relative cwd is ignored while an absolute one above it wins.
  const hidden = join(DIR, "2026-10-27T10-00-00-000Z_rel00002.jsonl");
  writeFileSync(hidden, JSON.stringify({ type: "session", id: "rel00002", cwd: "../elsewhere" }) + "\n");
  const root = sessionFile("absroot1", { cwd: DIR });
  const child = join(DIR, "2026-10-27T10-00-00-000Z_rel00003.jsonl");
  writeFileSync(child, JSON.stringify({ type: "session", id: "rel00003", cwd: "nope", parentSession: root }) + "\n");
  assert.equal(resolveSessionChain(child).rootCwd, DIR, "the absolute header is the one that counts");
  assert.equal(resolveSessionChain(hidden).rootCwd, null);
});

test("a grandchild is authorized by the ROOT session's allow row (ADR-0047 regression)", () => {
  const root = sessionFile("authroot", { cwd: "C:/proj" });
  const parent = sessionFile("authpar1", { cwd: "C:/elsewhere", parentSession: root });
  sessionFile("authchi1", { cwd: "C:/third", parentSession: parent });
  const { ancestors } = resolveSessionChain(parent);

  const ledger = [
    {
      kind: "judgment",
      question_id: "scope-lock",
      session_id: "authroot",
      outcome: null,
      decision: { action: "allow" },
    },
  ];

  assert.equal(
    hookCheck(ledger, { sessionId: "authchi1", ancestors }).allow,
    true,
    "the direct parent holds no allow row; the root does"
  );
  assert.equal(
    hookCheck(ledger, { sessionId: "authchi1", ancestors: ["authpar1"] }).allow,
    false,
    "the old single-parent wiring is exactly the bug this chain fixes"
  );
  assert.equal(
    hookCheck(ledger, { sessionId: "authchi1", ancestors }).allow,
    true,
    "a child cwd never enters this decision"
  );
});
