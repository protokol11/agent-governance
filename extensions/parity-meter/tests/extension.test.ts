/**
 * Extension wiring test: run the real event handlers against a fake pi runtime.
 *
 * Covers session start (sidecar, counters), a scripted tool call (protocol errors),
 * agent end (ledger row plus custom entry), and the double `agent_end` idempotency guard.
 *
 * Run: node --experimental-strip-types tests/extension.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import parityMeter, { setClockForTests } from "../index.ts";
import { readRows, readToolSchemaSnapshot } from "../ledger.ts";
import { ROW_JSON_SCHEMA, validateValue, type ParityRow } from "../schemas.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface ToolInfo {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface RuntimeOptions {
  branch?: unknown[];
  /** Called for every `getAllTools()`; index 0 is `session_start`, index 1 is `agent_end`. Throwing simulates a broken pi API. */
  tools?: (callIndex: number) => ToolInfo[];
}

const READ_TOOL: ToolInfo = {
  name: "read",
  description: "read a file",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: { path: { type: "string" } },
  },
};

const SUPERVISOR_TOOL: ToolInfo = {
  name: "subagent_supervisor",
  description: "late-registered tool, live catch 01a16114",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: { prompt: { type: "string" } },
  },
};

interface FakeRuntime {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  appended: Array<{ customType: string; data: unknown }>;
  ctx: ExtensionContext;
  /** Number of `getAllTools()` invocations, so a test can prove the second snapshot happened. */
  toolSnapshotCalls: () => number;
}

function fakeRuntime(options: RuntimeOptions = {}): FakeRuntime {
  const handlers = new Map<string, Handler[]>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  let snapshotCalls = 0;
  const pi = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    getAllTools: () => {
      const index = snapshotCalls;
      snapshotCalls += 1;
      return options.tools ? options.tools(index) : [READ_TOOL];
    },
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ customType, data });
    },
  } as unknown as ExtensionAPI;

  const sessionManager = {
    getSessionId: () => "session-live-1",
    getSessionFile: () => "/tmp/sessions/2026-10-23T10-00-00_session-live-1.jsonl",
    getBranch: () => options.branch ?? [],
  };
  const ctx = {
    model: { provider: "test-provider", id: "test-model" },
    thinkingLevel: "high",
    sessionManager,
  } as unknown as ExtensionContext;

  return { pi, handlers, appended, ctx, toolSnapshotCalls: () => snapshotCalls };
}

async function fire(runtime: FakeRuntime, event: string, payload: unknown): Promise<void> {
  const handler = runtime.handlers.get(event)?.[0];
  assert.ok(handler, `no handler registered for ${event}`);
  await handler(payload, runtime.ctx);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Run `body` with HOME/USERPROFILE pointed at a throwaway directory. */
async function withTempHome(body: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "parity-meter-home-"));
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await body(home);
  } finally {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousProfile);
    setClockForTests(null);
    rmSync(home, { recursive: true, force: true });
  }
}

function assistantTurn(input = 100): unknown {
  return {
    type: "turn_end",
    message: {
      role: "assistant",
      provider: "test-provider",
      model: "test-model",
      thinkingLevel: "high",
      usage: {
        input,
        cacheRead: 0,
        output: 10,
        reasoning: 0,
        cost: { total: 0.01 },
      },
    },
  };
}

test("extension records a live session row and one custom entry", async () => {
  const home = mkdtempSync(join(tmpdir(), "parity-meter-home-"));
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  try {
    const runtime = fakeRuntime();
    parityMeter(runtime.pi);

    await fire(runtime, "session_start", { type: "session_start", reason: "startup" });
    await fire(runtime, "tool_call", { type: "tool_call", toolName: "read", input: { path: "a.ts" } });
    await fire(runtime, "tool_call", { type: "tool_call", toolName: "ghost_tool", input: {} });
    await fire(runtime, "turn_end", {
      type: "turn_end",
      message: {
        role: "assistant",
        provider: "test-provider",
        model: "test-model",
        thinkingLevel: "high",
        usage: {
          input: 100,
          cacheRead: 400,
          output: 50,
          reasoning: 10,
          cost: { total: 0.5, cacheRead: 0.2, cacheWrite: 0.1, output: 0.05 },
        },
      },
    });
    await fire(runtime, "agent_end", { type: "agent_end", messages: [] });

    const sidecar = join(home, ".pi", "agent", "parity-meter", "tool-schemas.json");
    const ledger = join(home, ".pi", "agent", "parity.jsonl");
    assert.ok(existsSync(sidecar), "sidecar must exist after session_start");
    assert.ok(existsSync(ledger), "ledger must exist after agent_end");

    const rows = readRows(ledger) as ParityRow[];
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.deepEqual(validateValue(row, ROW_JSON_SCHEMA), []);
    assert.equal(row.session_id, "session-live-1");
    assert.equal(row.session_file, "2026-10-23T10-00-00_session-live-1.jsonl");
    assert.equal(row.provider, "test-provider");
    assert.equal(row.model, "test-model");
    assert.equal(row.thinking, "high");
    assert.equal(row.req, 1);
    assert.equal(row.avg_input, 500);
    assert.equal(row.avg_cache_read, 400);
    assert.equal(row.avg_output, 50);
    assert.equal(row.reasoning_share, 0.2);
    assert.equal(row.cost_total, 0.5);
    assert.equal(row.cost_cache_share, 0.6);
    assert.equal(row.cost_output_share, 0.1);
    assert.equal(row.tool_seq_len, 2);
    assert.equal(row.protocol_errors?.total, 1);
    assert.equal(row.protocol_errors?.tool_name_not_in_schema, 1);
    assert.equal(row.attribution, "full");
    assert.equal(row.schema_snapshot, true);

    assert.equal(runtime.appended.length, 1);
    assert.equal(runtime.appended[0].customType, "parity-meter");
    const payload = runtime.appended[0].data as { session_id: string; rows: ParityRow[] };
    assert.equal(payload.session_id, row.session_id);
    assert.equal(payload.rows.length, 1);

    await fire(runtime, "agent_end", { type: "agent_end", messages: [] });
    assert.equal(readRows(ledger).length, 1, "a second agent_end must not add a row");
    assert.equal(runtime.appended.length, 1, "a second agent_end must not add a custom entry");
  } finally {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousProfile);
    rmSync(home, { recursive: true, force: true });
  }
});

test("session_start rebuilds counters from the branch", async () => {
  const home = mkdtempSync(join(tmpdir(), "parity-meter-home-"));
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  try {
    const branch = [
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "test-provider",
          model: "test-model",
          thinkingLevel: "high",
          usage: { input: 10, cacheRead: 0, output: 5, cost: { total: 0.1 } },
          content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "test-provider",
          model: "test-model",
          thinkingLevel: "high",
          usage: { input: 10, cacheRead: 0, output: 5, cost: { total: 0.1 } },
          content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }],
        },
      },
    ];
    const runtime = fakeRuntime({ branch });
    parityMeter(runtime.pi);

    await fire(runtime, "session_start", { type: "session_start", reason: "resume" });
    await fire(runtime, "agent_end", { type: "agent_end", messages: [] });

    const rows = readRows(join(home, ".pi", "agent", "parity.jsonl")) as ParityRow[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].req, 2);
    assert.equal(rows[0].tool_seq_len, 2);
    assert.equal(rows[0].protocol_errors?.repeat_read_unchanged, 1);
  } finally {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousProfile);
    rmSync(home, { recursive: true, force: true });
  }
});

test("late-registered tool present only in the agent_end snapshot produces zero ghosts", async () => {
  // Calibration spec, user story 1 and acceptance criterion 1: the live catch counted
  // `subagent_supervisor` as a ghost because the start snapshot predated its registration.
  await withTempHome(async (home) => {
    const runtime = fakeRuntime({
      tools: (callIndex) => (callIndex === 0 ? [READ_TOOL] : [READ_TOOL, SUPERVISOR_TOOL]),
    });
    parityMeter(runtime.pi);

    await fire(runtime, "session_start", { type: "session_start", reason: "startup" });
    await fire(runtime, "tool_call", {
      type: "tool_call",
      toolName: "subagent_supervisor",
      input: { prompt: "look at the diff" },
    });
    await fire(runtime, "turn_end", assistantTurn());
    await fire(runtime, "agent_end", { type: "agent_end", messages: [] });

    assert.equal(runtime.toolSnapshotCalls(), 2, "a second snapshot must be taken at agent_end");
    const rows = readRows(join(home, ".pi", "agent", "parity.jsonl")) as ParityRow[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].protocol_errors?.tool_name_not_in_schema, 0);
    assert.equal(rows[0].protocol_errors?.total, 0);
    assert.equal(rows[0].rules_version, 2);

    const sidecar = readToolSchemaSnapshot(join(home, ".pi", "agent", "parity-meter", "tool-schemas.json"));
    assert.deepEqual(Object.keys(sidecar?.tools ?? {}).sort(), ["read", "subagent_supervisor"]);
  });
});

test("a tool absent from both snapshots stays a ghost", async () => {
  await withTempHome(async (home) => {
    const runtime = fakeRuntime();
    parityMeter(runtime.pi);

    await fire(runtime, "session_start", { type: "session_start", reason: "startup" });
    await fire(runtime, "tool_call", { type: "tool_call", toolName: "ghost_tool", input: {} });
    await fire(runtime, "turn_end", assistantTurn());
    await fire(runtime, "agent_end", { type: "agent_end", messages: [] });

    const rows = readRows(join(home, ".pi", "agent", "parity.jsonl")) as ParityRow[];
    assert.equal(rows[0].protocol_errors?.tool_name_not_in_schema, 1);
  });
});

test("a 39s repeat read counts and a 1000s repeat does not", async () => {
  // Calibration spec, user story 2 and acceptance criterion 2: 39s was the true positive,
  // 4.5h was the rational re-read, 900s is the declared boundary.
  await withTempHome(async (home) => {
    let now = 0;
    setClockForTests(() => now);
    const runtime = fakeRuntime();
    parityMeter(runtime.pi);
    const readCall = { type: "tool_call", toolName: "read", input: { path: "a.ts" } };

    await fire(runtime, "session_start", { type: "session_start", reason: "startup" });
    await fire(runtime, "tool_call", readCall);
    now = 39_000;
    await fire(runtime, "tool_call", readCall);
    now = 39_000 + 1_000_000;
    await fire(runtime, "tool_call", readCall);
    await fire(runtime, "turn_end", assistantTurn());
    await fire(runtime, "agent_end", { type: "agent_end", messages: [] });

    const rows = readRows(join(home, ".pi", "agent", "parity.jsonl")) as ParityRow[];
    assert.equal(rows[0].protocol_errors?.repeat_read_unchanged, 1);
  });
});

test("a read beyond the window resets the anchor for the next read", async () => {
  await withTempHome(async (home) => {
    let now = 0;
    setClockForTests(() => now);
    const runtime = fakeRuntime();
    parityMeter(runtime.pi);
    const readCall = { type: "tool_call", toolName: "read", input: { path: "a.ts" } };

    await fire(runtime, "session_start", { type: "session_start", reason: "startup" });
    await fire(runtime, "tool_call", readCall);
    now = 1_000_000; // 1000s: beyond the window, not counted, becomes the new anchor
    await fire(runtime, "tool_call", readCall);
    now = 1_030_000; // 30s after the reset anchor: counted
    await fire(runtime, "tool_call", readCall);
    await fire(runtime, "turn_end", assistantTurn());
    await fire(runtime, "agent_end", { type: "agent_end", messages: [] });

    const rows = readRows(join(home, ".pi", "agent", "parity.jsonl")) as ParityRow[];
    assert.equal(rows[0].protocol_errors?.repeat_read_unchanged, 1);
  });
});

test("a failing second snapshot is an extension error, never a silent fallback", async () => {
  await withTempHome(async (home) => {
    const runtime = fakeRuntime({
      tools: (callIndex) => {
        if (callIndex > 0) throw new Error("pi API exploded");
        return [READ_TOOL];
      },
    });
    parityMeter(runtime.pi);

    await fire(runtime, "session_start", { type: "session_start", reason: "startup" });
    await fire(runtime, "tool_call", { type: "tool_call", toolName: "read", input: { path: "a.ts" } });
    await fire(runtime, "turn_end", assistantTurn());

    await assert.rejects(
      () => fire(runtime, "agent_end", { type: "agent_end", messages: [] }),
      /agent_end tool schema snapshot failed/,
    );
    assert.equal(
      existsSync(join(home, ".pi", "agent", "parity.jsonl")),
      false,
      "no row may be written on a single-snapshot fallback",
    );
    assert.equal(runtime.appended.length, 0);
  });
});
