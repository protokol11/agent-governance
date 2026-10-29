/**
 * Ledger projection for the live parity meter.
 *
 * The ledger is a state keyed by session: rows for one session are replaced on every write.
 * A crash between writes therefore converges on the next `agent_end`, never duplicates a session.
 * Atomic writes use a temp file in the same directory followed by a rename.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  RULES_VERSION,
  SCHEMA_VERSION,
  type Attribution,
  type JsonSchema,
  type ParityRow,
  type ProtocolErrors,
  type ToolSchemaSnapshot,
} from "./schemas.ts";

/** One assistant response reduced to the fields the ledger aggregates. */
export interface UsageSample {
  input: number;
  cacheRead: number;
  output: number;
  reasoning: number;
  costTotal: number;
  costCacheRead: number;
  costCacheWrite?: number;
  costOutput: number;
}

export interface BuildRowInput {
  sessionId: string;
  sessionFile: string;
  provider: string;
  model: string;
  thinking: string;
  samples: readonly UsageSample[];
  toolNames: readonly string[];
  protocolErrors: ProtocolErrors | null;
  parseErrors: number;
  schemaSnapshot: boolean;
  schemaBasis: string;
  emittedAt: string;
}

export interface MergeResult {
  /** Rows removed because they belonged to the rewritten session. */
  replaced: number;
  /** Unrelated rows kept untouched. */
  kept: number;
  /** New rows written for this session. */
  written: number;
}

export function defaultLedgerPath(): string {
  return join(homedir(), ".pi", "agent", "parity.jsonl");
}

export function defaultSidecarPath(): string {
  return join(homedir(), ".pi", "agent", "parity-meter", "tool-schemas.json");
}

export function emptyProtocolErrors(): ProtocolErrors {
  return {
    total: 0,
    tool_name_not_in_schema: 0,
    args_fail_schema: 0,
    repeat_read_unchanged: 0,
  };
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function share(part: number, total: number): number {
  if (!total) return 0;
  return round(part / total);
}

export function attributionOf(provider: string, model: string): Attribution {
  const providerKnown = provider !== "unknown";
  const modelKnown = model !== "unknown";
  if (providerKnown && modelKnown) return "full";
  if (providerKnown || modelKnown) return "partial";
  return "unknown";
}

export function toolSequenceSha(toolNames: readonly string[]): string {
  return createHash("sha256").update(toolNames.join("\n"), "utf8").digest("hex");
}

/** Build one ledger row from per-group accumulators. */
export function buildRow(input: BuildRowInput): ParityRow {
  const count = input.samples.length;
  let inputTokens = 0;
  let cacheRead = 0;
  let output = 0;
  let reasoning = 0;
  let costTotal = 0;
  let costCache = 0;
  let costOutput = 0;

  for (const sample of input.samples) {
    inputTokens += sample.input + sample.cacheRead;
    cacheRead += sample.cacheRead;
    output += sample.output;
    reasoning += sample.reasoning;
    costTotal += sample.costTotal;
    costCache += sample.costCacheRead + (sample.costCacheWrite ?? 0);
    costOutput += sample.costOutput;
  }

  return {
    schema_version: SCHEMA_VERSION,
    rules_version: RULES_VERSION,
    session_id: input.sessionId,
    session_file: input.sessionFile,
    provider: input.provider,
    model: input.model,
    thinking: input.thinking,
    req: count,
    avg_input: count ? round(inputTokens / count, 4) : 0,
    avg_cache_read: count ? round(cacheRead / count, 4) : 0,
    avg_output: count ? round(output / count, 4) : 0,
    reasoning,
    reasoning_share: share(reasoning, output),
    cost_total: round(costTotal),
    cost_cache_share: share(costCache, costTotal),
    cost_output_share: share(costOutput, costTotal),
    protocol_errors: input.protocolErrors,
    tool_seq_sha: toolSequenceSha(input.toolNames),
    tool_seq_len: input.toolNames.length,
    parse_errors: input.parseErrors,
    attribution: attributionOf(input.provider, input.model),
    schema_snapshot: input.schemaSnapshot,
    schema_basis: input.schemaBasis,
    emitted_at: input.emittedAt,
  };
}

function writeJsonLinesAtomic(filePath: string, rows: readonly unknown[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  writeFileSync(tmpPath, rows.length ? `${body}\n` : "", "utf8");
  renameSync(tmpPath, filePath);
}

function readLedgerRows(filePath: string): unknown[] {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  const rows: unknown[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      // A corrupt ledger line is not ours to drop: fail loudly and leave the file untouched.
      throw new Error(`${filePath}: line ${index + 1} is not valid JSON: ${(error as Error).message}`);
    }
  }
  return rows;
}

/**
 * Replace every row that belongs to `sessionId` with `rows`.
 * Repeating the call with the same rows leaves the ledger byte-identical.
 */
export function mergeRows(filePath: string, sessionId: string, rows: readonly ParityRow[]): MergeResult {
  const kept: unknown[] = [];
  let replaced = 0;
  for (const row of readLedgerRows(filePath)) {
    if (isObject(row) && row.session_id === sessionId) {
      replaced += 1;
    } else {
      kept.push(row);
    }
  }
  writeJsonLinesAtomic(filePath, [...kept, ...rows]);
  return { replaced, kept: kept.length, written: rows.length };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read and parse ledger rows. Used by tests and future tooling. */
export function readRows(filePath: string): unknown[] {
  return readLedgerRows(filePath);
}

/**
 * Union of two registered-tool snapshots, later snapshot winning on a name collision.
 *
 * Rule 1 needs the union because a tool can be registered or exposed after `session_start`
 * (live catch 01a16114: `subagent_supervisor` was live but absent from the start snapshot).
 * A name present in either snapshot is a live tool, so it is not a ghost.
 */
export function mergeToolSchemas(
  earlier: Record<string, JsonSchema>,
  later: Record<string, JsonSchema>,
): Record<string, JsonSchema> {
  return { ...earlier, ...later };
}

/** Write the tool schema sidecar. Throws on any filesystem failure. */
export function writeToolSchemaSnapshot(
  filePath: string,
  tools: Record<string, JsonSchema>,
  capturedAt = new Date().toISOString(),
): ToolSchemaSnapshot {
  const snapshot: ToolSchemaSnapshot = {
    schema_version: SCHEMA_VERSION,
    captured_at: capturedAt,
    tools,
  };
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
  return snapshot;
}

/** Read the sidecar. Returns null when it does not exist; throws on a corrupt file. */
export function readToolSchemaSnapshot(filePath: string): ToolSchemaSnapshot | null {
  if (!existsSync(filePath)) return null;
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!isObject(parsed) || !isObject(parsed.tools)) {
    throw new Error(`${filePath}: tool schema sidecar has no "tools" object`);
  }
  return parsed as unknown as ToolSchemaSnapshot;
}
