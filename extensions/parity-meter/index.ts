/**
 * parity-meter live extension.
 *
 * Measures a running session: tool-schema snapshot at start, protocol errors at call time,
 * usage per assistant turn, one ledger row per (provider, model, thinking) group at agent end.
 * The meter never changes tool arguments and never stops a call (RTL-08: meter measures, gates decide).
 *
 * Rule calibration v2: the tool schemas are snapshotted twice (`session_start` and `agent_end`)
 * and rule 1 counts ghosts against the union, so a tool registered mid-session is not a ghost;
 * rule 3 counts repeat reads only inside `REPEAT_WINDOW_SEC`.
 *
 * Spec: `.docs/SPECS/harness-core/parity-meter-extension.md`,
 * `.docs/SPECS/harness-core/parity-meter-rule-calibration.md`.
 */

import { basename } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  buildRow,
  defaultLedgerPath,
  defaultSidecarPath,
  emptyProtocolErrors,
  mergeRows,
  mergeToolSchemas,
  type UsageSample,
  writeToolSchemaSnapshot,
} from "./ledger.ts";
import {
  REPEAT_WINDOW_SEC,
  SCHEMA_VERSION,
  validateValue,
  type JsonSchema,
  type ParityRow,
  type ProtocolErrors,
} from "./schemas.ts";

const CUSTOM_TYPE = "parity-meter";
const UNKNOWN = "unknown";
const SNAPSHOT_BASIS = "snapshot-current";

/** Repeat reads narrower than this gap count as redundancy; wider gaps are rational re-reads. */
const REPEAT_WINDOW_MS = REPEAT_WINDOW_SEC * 1000;

interface UsageLike {
  input?: number;
  cacheRead?: number;
  output?: number;
  reasoning?: number;
  cost?: {
    total?: number;
    cacheRead?: number;
    cacheWrite?: number;
    output?: number;
  };
}

interface MessageLike {
  role?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  usage?: UsageLike;
  content?: unknown;
}

interface ReplayEntry {
  type?: string;
  timestamp?: string;
  message?: MessageLike;
  provider?: string;
  model?: string;
  usage?: UsageLike;
}

interface GroupState {
  provider: string;
  model: string;
  thinking: string;
  samples: UsageSample[];
}

interface SessionState {
  sessionId: string;
  sessionFile: string;
  toolSchemas: Record<string, JsonSchema>;
  schemaSnapshot: boolean;
  schemaBasis: string;
  parseErrors: number;
  groups: Map<string, GroupState>;
  /** Session-wide call sequence. Replay carries the same sequence in every group row. */
  toolNames: string[];
  errors: ProtocolErrors;
  /**
   * Last read time per path, in epoch ms, since its last edit or write.
   * `null` means the read time is unknown (branch replay without an event timestamp).
   */
  readAnchors: Map<string, number | null>;
  finalized: boolean;
}

let state: SessionState | null = null;

let clock: () => number = () => Date.now();

/**
 * Test seam only: the live meter reads wall time. A deterministic clock is what
 * lets a test prove the 900s window instead of waiting 15 minutes.
 */
export function setClockForTests(next: (() => number) | null): void {
  clock = next ?? (() => Date.now());
}

/** Parse an ISO timestamp into epoch ms; `undefined` when absent or unparsable. */
function timeOf(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function groupKey(provider: string, model: string, thinking: string): string {
  return `${provider}\u0000${model}\u0000${thinking}`;
}

function normalize(value: string | undefined): string {
  return value && value.length > 0 ? value : UNKNOWN;
}

function toolPath(args: Record<string, unknown>): string | undefined {
  const value = args.path;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toSample(usage: UsageLike): UsageSample {
  return {
    input: usage.input ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    output: usage.output ?? 0,
    reasoning: usage.reasoning ?? 0,
    costTotal: usage.cost?.total ?? 0,
    costCacheRead: usage.cost?.cacheRead ?? 0,
    costCacheWrite: usage.cost?.cacheWrite ?? 0,
    costOutput: usage.cost?.output ?? 0,
  };
}

function getGroup(session: SessionState, provider?: string, model?: string, thinking?: string): GroupState {
  const normalizedProvider = normalize(provider);
  const normalizedModel = normalize(model);
  const normalizedThinking = normalize(thinking);
  const key = groupKey(normalizedProvider, normalizedModel, normalizedThinking);
  let group = session.groups.get(key);
  if (!group) {
    group = {
      provider: normalizedProvider,
      model: normalizedModel,
      thinking: normalizedThinking,
      samples: [],
    };
    session.groups.set(key, group);
  }
  return group;
}

function addUsage(
  session: SessionState,
  provider: string | undefined,
  model: string | undefined,
  thinking: string | undefined,
  usage: UsageLike | undefined,
): void {
  if (!usage) return;
  getGroup(session, provider, model, thinking).samples.push(toSample(usage));
}

/** Count protocol errors and append the tool name. Read-only: arguments are never touched. */
function recordToolCall(
  session: SessionState,
  toolName: string,
  args: Record<string, unknown>,
  atMs: number | undefined,
): void {
  session.toolNames.push(toolName);

  if (session.schemaSnapshot) {
    const schema = session.toolSchemas[toolName];
    // Rule 1 (ghost tool) is decided at agent_end against the session-start/agent_end union:
    // a tool registered after session_start is live, so the start snapshot alone must not judge it.
    if (schema && validateValue(args, schema, `$${toolName}`).length > 0) {
      session.errors.args_fail_schema += 1;
    }
  }

  const path = toolPath(args);
  if (!path) return;
  if (toolName === "read") {
    if (session.readAnchors.has(path)) {
      const anchor = session.readAnchors.get(path) ?? null;
      // An unmeasurable gap (unknown read time) stays counted: absence of evidence
      // is not evidence of a rational long-horizon re-read.
      if (anchor === null || atMs === undefined || atMs - anchor <= REPEAT_WINDOW_MS) {
        session.errors.repeat_read_unchanged += 1;
      }
    }
    // Every read becomes the new anchor, counted or not: a repeat beyond the window
    // resets the baseline instead of accumulating a stale one.
    session.readAnchors.set(path, atMs ?? null);
  } else if (toolName === "edit" || toolName === "write") {
    session.readAnchors.delete(path);
  }
}

function replayBranch(session: SessionState, branch: readonly unknown[]): void {
  for (const raw of branch) {
    const entry = raw as ReplayEntry;
    if (entry.type === "message" && entry.message) {
      const message = entry.message;
      if (message.role !== "assistant") continue;
      addUsage(session, message.provider, message.model, message.thinkingLevel, message.usage);
      if (!Array.isArray(message.content)) continue;
      for (const item of message.content) {
        const call = item as { type?: string; name?: string; arguments?: Record<string, unknown> };
        if (call.type !== "toolCall" || typeof call.name !== "string") continue;
        recordToolCall(session, call.name, call.arguments ?? {}, timeOf(entry.timestamp));
      }
    } else if (entry.type === "usage" && entry.usage) {
      addUsage(session, entry.provider, entry.model, undefined, entry.usage);
    }
  }
}

/**
 * Snapshot the registered tool schemas. Throws when the pi API fails, never returns
 * a partial map: a silently thin snapshot would inflate the ghost count.
 */
function collectToolSchemas(pi: ExtensionAPI, stage: string): Record<string, JsonSchema> {
  let infos: ReturnType<ExtensionAPI["getAllTools"]>;
  try {
    infos = pi.getAllTools();
  } catch (error) {
    throw new Error(`parity-meter: ${stage} tool schema snapshot failed: ${(error as Error).message}`);
  }
  if (!Array.isArray(infos)) {
    throw new Error(`parity-meter: ${stage} tool schema snapshot failed: getAllTools() did not return a list`);
  }
  const tools: Record<string, JsonSchema> = {};
  for (const info of infos) {
    tools[info.name] = info.parameters as JsonSchema;
  }
  return tools;
}

function initSession(pi: ExtensionAPI, ctx: ExtensionContext): SessionState {
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionPath = ctx.sessionManager.getSessionFile();
  const sessionFile = sessionPath ? basename(sessionPath) : `${sessionId}.jsonl`;
  const toolSchemas = collectToolSchemas(pi, "session_start");

  try {
    writeToolSchemaSnapshot(defaultSidecarPath(), toolSchemas);
  } catch (error) {
    // The sidecar makes replay rows trustworthy; a missing snapshot must not pass silently.
    throw new Error(`parity-meter: tool schema sidecar write failed: ${(error as Error).message}`);
  }

  const session: SessionState = {
    sessionId,
    sessionFile,
    toolSchemas,
    schemaSnapshot: true,
    schemaBasis: SNAPSHOT_BASIS,
    parseErrors: 0,
    groups: new Map<string, GroupState>(),
    toolNames: [],
    errors: emptyProtocolErrors(),
    readAnchors: new Map<string, number | null>(),
    finalized: false,
  };
  replayBranch(session, ctx.sessionManager.getBranch());
  return session;
}

/**
 * Second snapshot at agent_end: union it with the start snapshot, count rule-1 ghosts
 * against the union, and refresh the sidecar so replay shares the improved basis.
 */
function applyUnionSnapshot(pi: ExtensionAPI, session: SessionState): void {
  const later = collectToolSchemas(pi, "agent_end");
  const union = mergeToolSchemas(session.toolSchemas, later);
  session.toolSchemas = union;

  const ghosts = session.toolNames.filter((name) => !(name in union)).length;
  session.errors.tool_name_not_in_schema = ghosts;
  session.errors.total =
    ghosts + session.errors.args_fail_schema + session.errors.repeat_read_unchanged;

  try {
    writeToolSchemaSnapshot(defaultSidecarPath(), union);
  } catch (error) {
    // A stale sidecar would hand replay a worse basis than the live count used.
    throw new Error(`parity-meter: union tool schema sidecar refresh failed: ${(error as Error).message}`);
  }
}

function ensureState(pi: ExtensionAPI, ctx: ExtensionContext): SessionState {
  if (!state) state = initSession(pi, ctx);
  return state;
}

function buildSessionRows(session: SessionState, emittedAt: string): ParityRow[] {
  const groups = [...session.groups.values()]
    .filter((group) => group.samples.length > 0)
    .sort((left, right) =>
      groupKey(left.provider, left.model, left.thinking).localeCompare(
        groupKey(right.provider, right.model, right.thinking),
      ),
    );

  return groups.map((group) =>
    buildRow({
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      provider: group.provider,
      model: group.model,
      thinking: group.thinking,
      samples: group.samples,
      toolNames: session.toolNames,
      protocolErrors: session.schemaSnapshot ? { ...session.errors } : null,
      parseErrors: session.parseErrors,
      schemaSnapshot: session.schemaSnapshot,
      schemaBasis: session.schemaBasis,
      emittedAt,
    }),
  );
}

function finalize(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const session = ensureState(pi, ctx);
  if (session.finalized) return;

  // Rule 1 needs the union; a failing second snapshot is an extension error (PS-FIXER-03),
  // never a silent fallback to the single start snapshot.
  applyUnionSnapshot(pi, session);

  const emittedAt = new Date().toISOString();
  const rows = buildSessionRows(session, emittedAt);
  if (rows.length > 0) mergeRows(defaultLedgerPath(), session.sessionId, rows);

  pi.appendEntry(CUSTOM_TYPE, {
    schema_version: SCHEMA_VERSION,
    session_id: session.sessionId,
    session_file: session.sessionFile,
    emitted_at: emittedAt,
    rows,
  });
  session.finalized = true;
}

export default function parityMeter(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    state = initSession(pi, ctx);
  });

  pi.on("tool_call", (event, ctx) => {
    // Nested calls never enter the transcript; replay cannot see them, so the live count skips them.
    if (event.parentToolCallId) return;
    const session = ensureState(pi, ctx);
    const atMs = timeOf((event as unknown as { timestamp?: unknown }).timestamp) ?? clock();
    recordToolCall(session, event.toolName, event.input as Record<string, unknown>, atMs);
    session.finalized = false;
  });

  pi.on("turn_end", (event, ctx) => {
    const session = ensureState(pi, ctx);
    const message = event.message as MessageLike;
    if (message.role !== "assistant") return;
    addUsage(session, message.provider, message.model, message.thinkingLevel, message.usage);
    session.finalized = false;
  });

  pi.on("agent_end", (_event, ctx) => {
    finalize(pi, ctx);
  });

  pi.on("session_shutdown", (event, ctx) => {
    // A reload keeps the same session: `session_start` rebuilds the counters from the branch.
    if (event.reason === "reload") return;
    finalize(pi, ctx);
  });
}
