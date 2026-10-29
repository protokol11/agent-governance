import assert from "node:assert";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRalphState, saveRalphState, loadRalphState, formatRalphStatus, restoreActiveRalphRunId, goalSlug } from "./ralph/state.ts";
import { decideAfterVerify } from "./ralph/planner.ts";
import { readVerifyResult } from "./ralph/loop.ts";
import { pickTddMode } from "./ralph/tdd.ts";

const TEST_TMP = join(process.cwd(), "tmp-ralph-test");

async function setup() {
  await mkdir(TEST_TMP, { recursive: true });
}

async function cleanup() {
  await rm(TEST_TMP, { recursive: true, force: true });
}

async function testCreateRalphState() {
  const state = createRalphState("port Minecraft to TypeScript", { maxIterations: 10 });
  assert.strictEqual(state.goal, "port Minecraft to TypeScript");
  assert.strictEqual(state.phase, "define");
  assert.strictEqual(state.status, "running");
  assert.strictEqual(state.iteration, 1);
  assert.strictEqual(state.maxIterations, 10);
  assert.strictEqual(state.autoApprove, false);
  console.log("✓ createRalphState");
}

async function testAutoApproveState() {
  const state = createRalphState("auto goal", { autoApprove: true });
  assert.strictEqual(state.autoApprove, true);
  assert.strictEqual(state.autonomyLevel, "execute-and-report");
  console.log("✓ createRalphState autoApprove");
}

async function testAutonomyLevelDefault() {
  const state = createRalphState("default autonomy");
  assert.strictEqual(state.autonomyLevel, "execute-with-review");
  console.log("✓ createRalphState default autonomy");
}

async function testAutonomyLevelExplicit() {
  const state = createRalphState("explicit autonomy", { autonomyLevel: "human-approval-required" });
  assert.strictEqual(state.autonomyLevel, "human-approval-required");
  console.log("✓ createRalphState explicit autonomy");
}

async function testSaveLoadRalphState() {
  const state = createRalphState("test goal");
  const mockPi = { appendEntry: (_type: string, _data: unknown) => {} };
  await saveRalphState(TEST_TMP, mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, state);

  const loaded = await loadRalphState(TEST_TMP, state.runId);
  assert.ok(loaded);
  assert.strictEqual(loaded.goal, state.goal);
  assert.strictEqual(loaded.phase, state.phase);
  console.log("✓ save/load RalphState");
}

async function testRestoreActiveRalphRunId() {
  const state = createRalphState("restore");
  const mockPi = { appendEntry: (_type: string, _data: unknown) => {} };
  await saveRalphState(TEST_TMP, mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, state);

  const sessionManager = {
    getEntries: () => [
      { type: "custom", customType: "conductor-state", data: { runId: "other", status: "paused" } },
      { type: "custom", customType: "ralph-state", data: { runId: state.runId, status: "running" } },
    ],
  };
  const restored = restoreActiveRalphRunId(sessionManager as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext["sessionManager"]);
  assert.strictEqual(restored, state.runId);
  console.log("✓ restoreActiveRalphRunId");
}

async function testReadVerifyResultMissingVisual() {
  const state = createRalphState("test goal");
  const mockPi = { appendEntry: (_type: string, _data: unknown) => {} };
  await saveRalphState(TEST_TMP, mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, state);

  const theme = goalSlug(state.goal);
  const reportDir = join(TEST_TMP, "tmp", "conductor", "ralph", theme);
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    join(reportDir, "report.json"),
    JSON.stringify({ testsPassed: true, acceptanceMet: true, summary: "ok" }),
    "utf-8",
  );

  const result = await readVerifyResult(TEST_TMP, state);
  assert.strictEqual(result.testsPassed, true);
  assert.strictEqual(result.acceptanceMet, true);
  assert.strictEqual(result.visualTestsPassed, false);
  assert.strictEqual(result.visualTestsRun, false);
  assert.strictEqual(result.liveTestFailed, false);
  console.log("✓ readVerifyResult missing visual defaults to false and not failed");
}

async function testReadVerifyResultExplicitPass() {
  const state = createRalphState("test goal");
  const mockPi = { appendEntry: (_type: string, _data: unknown) => {} };
  await saveRalphState(TEST_TMP, mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, state);

  const theme = goalSlug(state.goal);
  const reportDir = join(TEST_TMP, "tmp", "conductor", "ralph", theme);
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    join(reportDir, "report.json"),
    JSON.stringify({ testsPassed: true, acceptanceMet: true, visualTestsPassed: true, visualTestsRun: true, summary: "ok" }),
    "utf-8",
  );

  const result = await readVerifyResult(TEST_TMP, state);
  assert.strictEqual(result.visualTestsPassed, true);
  assert.strictEqual(result.visualTestsRun, true);
  console.log("✓ readVerifyResult explicit visual pass");
}

async function testReadVerifyResultExplicitFail() {
  const state = createRalphState("test goal");
  const mockPi = { appendEntry: (_type: string, _data: unknown) => {} };
  await saveRalphState(TEST_TMP, mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, state);

  const theme = goalSlug(state.goal);
  const reportDir = join(TEST_TMP, "tmp", "conductor", "ralph", theme);
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    join(reportDir, "report.json"),
    JSON.stringify({ testsPassed: true, acceptanceMet: true, visualTestsPassed: false, visualTestsRun: true, summary: "blank canvas" }),
    "utf-8",
  );

  const result = await readVerifyResult(TEST_TMP, state);
  assert.strictEqual(result.visualTestsPassed, false);
  assert.strictEqual(result.visualTestsRun, true);
  assert.strictEqual(result.liveTestFailed, true);
  const decision = decideAfterVerify(state, result);
  assert.strictEqual(decision.decision, "human");
  console.log("✓ readVerifyResult explicit visual fail routes to human");
}

async function testDecideAfterVerify() {
  const state = createRalphState("test goal");
  state.acceptanceCriteria = ["Tests pass."];

  const done = decideAfterVerify(state, { testsPassed: true, acceptanceMet: true, visualTestsPassed: true, failures: [], flags: [], summary: "" });
  assert.strictEqual(done.decision, "done");

  const retry = decideAfterVerify(state, { testsPassed: false, acceptanceMet: false, visualTestsPassed: true, failures: ["x"], flags: [], summary: "" });
  assert.strictEqual(retry.decision, "retry");

  const visualFail = decideAfterVerify(state, { testsPassed: true, acceptanceMet: true, visualTestsPassed: false, failures: [], flags: [], summary: "" });
  assert.strictEqual(visualFail.decision, "human");

  const unitOnly = decideAfterVerify(state, { testsPassed: true, acceptanceMet: true, visualTestsPassed: false, visualTestsRun: false, failures: [], flags: [], summary: "" });
  assert.strictEqual(unitOnly.decision, "done");

  state.iteration = 11;
  const abort = decideAfterVerify(state, { testsPassed: false, acceptanceMet: false, visualTestsPassed: true, failures: [], flags: [], summary: "" });
  assert.strictEqual(abort.decision, "abort");
  console.log("✓ decideAfterVerify");
}

async function testPickTddMode() {
  const strictState = createRalphState("test goal");
  strictState.acceptanceCriteria = ["a", "b", "c"];
  const strict = pickTddMode(strictState);
  assert.strictEqual(strict.mode, "strict");

  const mediumState = createRalphState("test goal");
  mediumState.acceptanceCriteria = ["a"];
  mediumState.iteration = 2;
  const medium = pickTddMode(mediumState);
  assert.strictEqual(medium.mode, "medium");

  const lowState = createRalphState("test goal");
  const low = pickTddMode(lowState);
  assert.strictEqual(low.mode, "low");
  console.log("✓ pickTddMode");
}

async function testFormatRalphStatus() {
  const state = createRalphState("port Minecraft Classic to TypeScript web", { maxIterations: 10 });
  state.iteration = 3;
  state.phase = "tdd";
  const status = formatRalphStatus(state);
  assert.match(status, /port-minecraft-classic-to-typescript-web/);
  assert.match(status, /iter 3\/10/);
  assert.match(status, /tdd/);
  console.log("✓ formatRalphStatus");
}

async function testRalphStatePersistence() {
  const state = createRalphState("persist");
  const mockPi = { appendEntry: (_type: string, _data: unknown) => {} };
  await saveRalphState(TEST_TMP, mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, state);

  const path = join(TEST_TMP, "ralph", state.runId, "state.json");
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw);
  assert.strictEqual(parsed.goal, "persist");
  console.log("✓ RalphState persistence files");
}

async function main() {
  await setup();
  try {
    await testCreateRalphState();
    await testAutoApproveState();
    await testAutonomyLevelDefault();
    await testAutonomyLevelExplicit();
    await testSaveLoadRalphState();
    await testRestoreActiveRalphRunId();
    await testReadVerifyResultMissingVisual();
    await testReadVerifyResultExplicitPass();
    await testReadVerifyResultExplicitFail();
    await testDecideAfterVerify();
    await testPickTddMode();
    await testFormatRalphStatus();
    await testRalphStatePersistence();
    console.log("\nAll Ralph unit tests passed.");
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
