/**
 * Ledger and row aggregation tests for the live parity meter.
 *
 * Covers ledger merge idempotency (a second `agent_end` for the same session must not add a row),
 * session isolation, row aggregation, and the tool-schema sidecar.
 *
 * Run: node --experimental-strip-types tests/ledger.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildRow,
  emptyProtocolErrors,
  mergeRows,
  mergeToolSchemas,
  readRows,
  readToolSchemaSnapshot,
  toolSequenceSha,
  writeToolSchemaSnapshot,
  type BuildRowInput,
} from "../ledger.ts";
import { RULES_VERSION, SCHEMA_VERSION, type ParityRow } from "../schemas.ts";

function sampleInput(overrides: Partial<BuildRowInput> = {}): BuildRowInput {
  return {
    sessionId: "session-1",
    sessionFile: "2026-10-23T10-00-00_session-1.jsonl",
    provider: "kimi-for-coding",
    model: "kimi-k2",
    thinking: "high",
    samples: [
      {
        input: 1000,
        cacheRead: 40000,
        output: 200,
        reasoning: 50,
        costTotal: 0.2,
        costCacheRead: 0.1,
        costOutput: 0.06,
      },
    ],
    toolNames: ["read", "bash"],
    protocolErrors: emptyProtocolErrors(),
    parseErrors: 0,
    schemaSnapshot: true,
    schemaBasis: "snapshot-current",
    emittedAt: "2026-10-23T12:00:00.000Z",
    ...overrides,
  };
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "parity-meter-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("row aggregation sums usage and derives shares", () => {
  const row: ParityRow = buildRow(
    sampleInput({
      samples: [
        {
          input: 100,
          cacheRead: 40,
          output: 200,
          reasoning: 50,
          costTotal: 1,
          costCacheRead: 0.5,
          costOutput: 0.25,
        },
        {
          input: 300,
          cacheRead: 60,
          output: 400,
          reasoning: 150,
          costTotal: 3,
          costCacheRead: 1.5,
          costOutput: 0.75,
        },
      ],
      toolNames: ["read", "edit", "read"],
    }),
  );

  assert.equal(row.schema_version, SCHEMA_VERSION);
  assert.equal(row.rules_version, RULES_VERSION);
  assert.equal(row.rules_version, 2);
  assert.equal(row.req, 2);
  assert.equal(row.avg_input, 250);
  assert.equal(row.avg_cache_read, 50);
  assert.equal(row.avg_output, 300);
  assert.equal(row.reasoning, 200);
  assert.equal(row.reasoning_share, 0.333333);
  assert.equal(row.cost_total, 4);
  assert.equal(row.cost_cache_share, 0.5);
  assert.equal(row.cost_output_share, 0.25);
  assert.equal(row.tool_seq_len, 3);
  assert.equal(row.tool_seq_sha, toolSequenceSha(["read", "edit", "read"]));
  assert.equal(row.attribution, "full");
});

test("missing provider or model narrows attribution to partial or unknown", () => {
  assert.equal(buildRow(sampleInput({ provider: "unknown" })).attribution, "partial");
  assert.equal(
    buildRow(sampleInput({ provider: "unknown", model: "unknown" })).attribution,
    "unknown",
  );
});

test("two writes for one session leave one row (fake double agent_end)", () => {
  withTempDir((dir) => {
    const ledger = join(dir, "parity.jsonl");
    const row = buildRow(sampleInput());

    mergeRows(ledger, row.session_id, [row]);
    const afterFirst = readFileSync(ledger, "utf8");
    mergeRows(ledger, row.session_id, [row]);
    const afterSecond = readFileSync(ledger, "utf8");

    assert.equal(afterFirst, afterSecond);
    assert.equal(readRows(ledger).length, 1);
  });
});

test("merge replaces only rows of the rewritten session", () => {
  withTempDir((dir) => {
    const ledger = join(dir, "parity.jsonl");
    const first = buildRow(sampleInput());
    const other = buildRow(
      sampleInput({ sessionId: "session-2", sessionFile: "session-2.jsonl", provider: "deepseek" }),
    );

    mergeRows(ledger, first.session_id, [first]);
    mergeRows(ledger, other.session_id, [other]);

    const updated = buildRow(sampleInput({ emittedAt: "2026-10-23T13:00:00.000Z" }));
    const result = mergeRows(ledger, updated.session_id, [updated]);

    assert.equal(result.replaced, 1);
    assert.equal(result.kept, 1);
    const rows = readRows(ledger) as ParityRow[];
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.session_id === "session-1")?.emitted_at, "2026-10-23T13:00:00.000Z");
    assert.equal(rows.find((row) => row.session_id === "session-2")?.emitted_at, other.emitted_at);
  });
});

test("corrupt ledger lines fail loudly instead of vanishing", () => {
  withTempDir((dir) => {
    const ledger = join(dir, "parity.jsonl");
    const row = buildRow(sampleInput());
    mergeRows(ledger, row.session_id, [row]);
    const withCorruptLine = `${readFileSync(ledger, "utf8")}{not-json}\n`;
    writeFileSync(ledger, withCorruptLine, "utf8");

    assert.throws(() => mergeRows(ledger, row.session_id, [row]), /not valid JSON/);
  });
});

test("tool schema union keeps tools registered after session start", () => {
  const union = mergeToolSchemas(
    { read: { type: "object" } },
    { read: { type: "object" }, subagent_supervisor: { type: "object" } },
  );
  assert.deepEqual(Object.keys(union).sort(), ["read", "subagent_supervisor"]);
});

test("sidecar round-trips and reports absence", () => {
  withTempDir((dir) => {
    const sidecar = join(dir, "parity-meter", "tool-schemas.json");
    assert.equal(readToolSchemaSnapshot(sidecar), null);

    const tools = {
      read: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    };
    const written = writeToolSchemaSnapshot(sidecar, tools, "2026-10-23T12:00:00.000Z");
    const loaded = readToolSchemaSnapshot(sidecar);

    assert.equal(written.schema_version, SCHEMA_VERSION);
    assert.deepEqual(loaded, written);
    assert.deepEqual(loaded?.tools, tools);
  });
});

