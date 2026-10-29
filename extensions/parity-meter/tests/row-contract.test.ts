/**
 * Row contract test: the live extension row and the shared JSON Schema must not drift.
 *
 * Direction 1: a row built by `buildRow` validates against `tests/row-schema.json`.
 * Direction 2: the Python-side fixture row validates with the TypeScript validator,
 * and the field sets of schema, row type, and fixture agree in both directions.
 *
 * Run: node --experimental-strip-types tests/row-contract.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildRow, emptyProtocolErrors, mergeToolSchemas, toolSequenceSha } from "../ledger.ts";
import {
  REPEAT_WINDOW_SEC,
  RULES_VERSION,
  ROW_FIELDS,
  ROW_JSON_SCHEMA,
  validateValue,
  type ParityRow,
} from "../schemas.ts";

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (name: string): unknown => JSON.parse(readFileSync(join(here, name), "utf8"));

const schemaFixture = readJson("row-schema.json") as Record<string, unknown>;
const rowFixture = readJson("row-fixture.json") as ParityRow;

const emittedRow: ParityRow = buildRow({
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  sessionFile: "2026-10-23T10-30-00_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  thinking: "high",
  samples: [
    {
      input: 1000,
      cacheRead: 50000,
      output: 300,
      reasoning: 100,
      costTotal: 0.2,
      costCacheRead: 0.1,
      costOutput: 0.08,
    },
    {
      input: 2000,
      cacheRead: 70000,
      output: 500,
      reasoning: 200,
      costTotal: 0.4,
      costCacheRead: 0.2,
      costOutput: 0.16,
    },
  ],
  toolNames: ["read", "grep", "edit", "bash"],
  protocolErrors: emptyProtocolErrors(),
  parseErrors: 0,
  schemaSnapshot: true,
  schemaBasis: "snapshot-current",
  emittedAt: "2026-10-23T12:30:00.000Z",
});

test("tests/row-schema.json matches the schema exported by schemas.ts", () => {
  assert.deepEqual(schemaFixture, ROW_JSON_SCHEMA);
});

test("TS-emitted row validates against the fixture schema", () => {
  assert.deepEqual(validateValue(emittedRow, schemaFixture), []);
});

test("Python fixture row validates with the TypeScript validator", () => {
  assert.deepEqual(validateValue(rowFixture, ROW_JSON_SCHEMA), []);
});

test("fixture row and TS row carry exactly the shared fields", () => {
  const schemaProperties = (schemaFixture.properties ?? {}) as Record<string, unknown>;
  assert.deepEqual(Object.keys(schemaProperties), [...ROW_FIELDS]);
  assert.deepEqual(schemaFixture.required, [...ROW_FIELDS]);
  assert.deepEqual(Object.keys(rowFixture), [...ROW_FIELDS]);
  assert.deepEqual(Object.keys(emittedRow), [...ROW_FIELDS]);
});

test("every row carries rules_version 2 (calibration spec, decision 3)", () => {
  assert.equal(RULES_VERSION, 2);
  assert.equal(emittedRow.rules_version, 2);
  assert.equal(rowFixture.rules_version, 2);
  assert.equal(emittedRow.schema_version, 1, "schema_version stays 1: the field is additive");
});

test("repeat window constant is 900 seconds and mirrored in the fixture schema shape", () => {
  // The Python engine declares the same number; a change on one side only must fail here.
  assert.equal(REPEAT_WINDOW_SEC, 900);
  const properties = (schemaFixture.properties ?? {}) as Record<string, Record<string, unknown>>;
  assert.deepEqual(properties.rules_version, { type: "integer", const: RULES_VERSION });
});

test("null protocol errors and unknown attribution stay valid rows", () => {
  const row: ParityRow = {
    ...emittedRow,
    provider: "unknown",
    model: "unknown",
    thinking: "unknown",
    attribution: "unknown",
    protocol_errors: null,
    schema_snapshot: false,
    schema_basis: "snapshot-current",
    tool_seq_sha: toolSequenceSha([]),
    tool_seq_len: 0,
  };
  assert.deepEqual(validateValue(row, schemaFixture), []);
});

test("validator rejects schema drift in both directions", () => {
  const missingField = { ...emittedRow } as Record<string, unknown>;
  delete missingField.tool_seq_len;
  assert.notDeepEqual(validateValue(missingField, schemaFixture), []);

  const missingRulesVersion = { ...emittedRow } as Record<string, unknown>;
  delete missingRulesVersion.rules_version;
  assert.notDeepEqual(validateValue(missingRulesVersion, schemaFixture), []);

  const oldRulesVersion = { ...emittedRow, rules_version: 1 };
  assert.notDeepEqual(validateValue(oldRulesVersion, schemaFixture), []);

  const extraField = { ...emittedRow, judgment_id: "not-allowed" };
  assert.notDeepEqual(validateValue(extraField, schemaFixture), []);

  const wrongType = { ...emittedRow, tool_seq_len: "4" };
  assert.notDeepEqual(validateValue(wrongType, schemaFixture), []);
});

test("tool schema union keeps late registrations and prefers the later schema", () => {
  const start = { read: { type: "object" } };
  const end = { read: { type: "string" }, subagent_supervisor: { type: "object" } };
  assert.deepEqual(mergeToolSchemas(start, end), {
    read: { type: "string" },
    subagent_supervisor: { type: "object" },
  });
  assert.deepEqual(mergeToolSchemas(start, {}), start);
});
