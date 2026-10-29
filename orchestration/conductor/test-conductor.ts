import assert from "node:assert";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { loadChains, getChain, listChains } from "./chains.ts";
import { createRunState, saveRunState, loadRunState, formatStatus, restoreActiveRunId } from "./state.ts";
import { artifactPath, sanitizeSlug, ensureArtifactDir, loadProjectContext } from "./artifacts.ts";
import { buildTaskForStep } from "./report.ts";
import { extractSpawnIds, waitForAsyncSubagent, asCompletionStatus } from "./runner.ts";
import { registerRoleGate, registerSubagentSession } from "./role-gate.ts";

const TEST_CWD = process.cwd();
const TEST_TMP = join(TEST_CWD, "tmp-conductor-test");

async function setup() {
	await mkdir(join(TEST_TMP, ".pi"), { recursive: true });
	const chainsPath = join(TEST_TMP, ".pi", "conductor-chains.json");
	await writeFile(
		chainsPath,
		JSON.stringify({ chains: { "tiktok-chain": ["explore", "coder", "tester"] } }),
	);
}

async function cleanup() {
	await rm(TEST_TMP, { recursive: true, force: true });
}

async function testChains() {
	const chains = await loadChains(TEST_TMP);
	const chainNames = listChains(chains);
	assert(chainNames.includes("explore-plan-coder-tester"), "base chain missing");
	assert(chainNames.includes("plan-coder-tester"), "base chain missing");
	assert(chainNames.includes("coder-tester-loop"), "base chain missing");
	assert(chainNames.includes("tiktok-chain"), "project chain missing");
	const chain = getChain(chains, "explore-plan-coder-tester");
	assert.deepStrictEqual(chain.steps, ["explore", "plan", "coder", "tester"]);
	const projectChain = getChain(chains, "tiktok-chain");
	assert.deepStrictEqual(projectChain.steps, ["explore", "coder", "tester"]);
	console.log("✓ chains load and resolve");
}

async function testState() {
	const state = createRunState("explore-plan-coder-tester", "test theme", ["explore", "plan"]);
	assert.strictEqual(state.chain, "explore-plan-coder-tester");
	assert.strictEqual(state.currentStepIndex, 0);
	assert.strictEqual(state.stepStates.length, 2);
	assert.strictEqual(state.status, "running");
	console.log("✓ createRunState");

	const mockPi = { appendEntry: (_type: string, _data: unknown) => {} };
	await saveRunState(TEST_TMP, mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, state);
	const loaded = await loadRunState(TEST_TMP, state.runId);
	assert.ok(loaded);
	assert.strictEqual(loaded.chain, state.chain);
	console.log("✓ save/load RunState");

	const status = formatStatus(loaded);
	assert.match(status, /explore-plan-coder-tester/);
	console.log("✓ formatStatus");
}

async function testArtifacts() {
	const slug = sanitizeSlug("Test Theme 123!");
	assert.strictEqual(slug, "test-theme-123");

	await ensureArtifactDir(TEST_TMP, "test-theme");
	const path = artifactPath(TEST_TMP, "test-theme", "0", "explore");
	assert.ok(path.endsWith("AUDIT.md"), `expected AUDIT.md, got ${path}`);
	console.log("✓ artifact paths");
}

async function testReport() {
	const state = createRunState("explore-plan-coder-tester", "test theme", ["explore", "plan", "coder"]);
	const { task, outputPath } = buildTaskForStep(TEST_TMP, state, 0);
	assert.ok(task.includes("Read relevant code"), `unexpected explore task: ${task}`);
	assert.ok(outputPath.endsWith("AUDIT.md"));

	const planTask = buildTaskForStep(TEST_TMP, state, 1);
	assert.ok(planTask.task.includes("plan.md"));
	assert.ok(planTask.outputPath.endsWith("plan.md"));
	console.log("✓ report prompts");
}

async function testRestoreActiveRunId() {
	const state = createRunState("explore-plan-coder-tester", "restore", ["explore"]);
	const mockPi = { appendEntry: (_type: string, _data: unknown) => {} };
	await saveRunState(TEST_TMP, mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, state);

	const sessionManager = {
		getEntries: () => [
			{ type: "custom", customType: "conductor-state", data: { runId: "other", status: "paused" } },
			{ type: "custom", customType: "conductor-state", data: { runId: state.runId, status: "running" } },
		],
	};
	const restored = restoreActiveRunId(sessionManager as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext["sessionManager"]);
	assert.strictEqual(restored, state.runId);
	console.log("✓ restoreActiveRunId");
}

async function testExtractSpawnIds() {
	assert.strictEqual(extractSpawnIds({ details: { runId: "A", asyncId: "B" } }).runId, "A");
	assert.strictEqual(extractSpawnIds({ details: { asyncId: "B" } }).runId, "B");
	assert.strictEqual(extractSpawnIds({ runId: "C" }).runId, "C");
	assert.strictEqual(extractSpawnIds({ id: "D" }).runId, "D");
	assert.strictEqual(extractSpawnIds({ asyncId: "E" }).runId, "E");
	assert.strictEqual(extractSpawnIds({}).runId, "unknown");
	console.log("✓ extractSpawnIds");
}

async function testWaitForAsyncSubagent() {
	const events = new EventEmitter() as unknown as import("@earendil-works/pi-coding-agent").EventBus;
	const runId = "run-123";
	setTimeout(() => {
		events.emit("subagent:async-complete", {
			id: runId,
			runId,
			state: "complete",
			success: true,
			asyncDir: "C:\\tmp\\mock",
		});
	}, 50);
	const result = await waitForAsyncSubagent(events, process.cwd(), "explore", runId);
	assert.strictEqual(result.status, "completed");
	console.log("✓ waitForAsyncSubagent success");

	const events2 = new EventEmitter() as unknown as import("@earendil-works/pi-coding-agent").EventBus;
	setTimeout(() => {
		events2.emit("subagent:async-complete", {
			id: "run-456",
			runId: "run-456",
			success: false,
			asyncDir: "C:\\tmp\\mock",
		});
	}, 50);
	const result2 = await waitForAsyncSubagent(events2, process.cwd(), "explore", "run-456");
	assert.strictEqual(result2.status, "failed");
	console.log("✓ waitForAsyncSubagent failure maps to failed");
}

async function testAsCompletionStatus() {
	assert.strictEqual(asCompletionStatus(true, "complete"), "completed");
	assert.strictEqual(asCompletionStatus(true, undefined), "completed");
	assert.strictEqual(asCompletionStatus(false, "complete"), "failed");
	assert.strictEqual(asCompletionStatus(false, undefined), "failed");
	assert.strictEqual(asCompletionStatus(undefined, "failed"), "failed");
	assert.strictEqual(asCompletionStatus(undefined, "paused"), "paused");
	assert.strictEqual(asCompletionStatus(undefined, "complete"), "completed");
	assert.strictEqual(asCompletionStatus(undefined, undefined), "detached");
	console.log("✓ asCompletionStatus mappings");
}

async function testWaitForAsyncSubagentTimeoutCleansInterval() {
	const events = new EventEmitter() as unknown as import("@earendil-works/pi-coding-agent").EventBus;
	const active = new Set<ReturnType<typeof setInterval>>();
	const originalSetInterval = global.setInterval.bind(global);
	const originalClearInterval = global.clearInterval.bind(global);
	global.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
		const id = originalSetInterval(handler, timeout, ...args);
		active.add(id);
		return id;
	}) as typeof global.setInterval;
	global.clearInterval = (id: ReturnType<typeof setInterval> | undefined) => {
		if (id) active.delete(id);
		return originalClearInterval(id);
	};
	try {
		await assert.rejects(
			waitForAsyncSubagent(events, process.cwd(), "explore", "run-timeout", undefined, 50),
			/timed out/,
		);
		assert.strictEqual(active.size, 0, "polling interval should be cleared after timeout");
		console.log("✓ waitForAsyncSubagent timeout cleans interval");
	} finally {
		global.setInterval = originalSetInterval;
		global.clearInterval = originalClearInterval;
		for (const id of active) originalClearInterval(id);
	}
}

async function testRoleGate() {
	const settings = { conductor: { roles: {} } };

	const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers[name] = handler;
		},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;

	registerRoleGate(pi, settings as import("./types.ts").ConductorSettings);
	registerSubagentSession("session-123", "tester");

	const ctx = {} as import("@earendil-works/pi-coding-agent").ExtensionContext;

	const blocked = await handlers.tool_call(
		{ type: "tool_call", toolCallId: "tc-1", toolName: "write", input: {}, metadata: { sessionId: "session-123" } },
		ctx,
	);
	assert.ok(blocked, "write should be blocked for tester");
	assert.strictEqual((blocked as { block?: boolean }).block, true);
	assert.match((blocked as { reason?: string }).reason ?? "", /tester.*write/);

	const allowed = await handlers.tool_call(
		{ type: "tool_call", toolCallId: "tc-2", toolName: "read", input: {}, metadata: { sessionId: "session-123" } },
		ctx,
	);
	assert.strictEqual(allowed, undefined, "read should be allowed for tester");

	const transparent = await handlers.tool_call(
		{ type: "tool_call", toolCallId: "tc-3", toolName: "write", input: {}, metadata: { sessionId: "unknown-session" } },
		ctx,
	);
	assert.strictEqual(transparent, undefined, "unknown session should not be blocked");

	const mcpBlocked = await handlers.tool_call(
		{ type: "tool_call", toolCallId: "tc-4", toolName: "some_server__write", input: {}, metadata: { sessionId: "session-123" } },
		ctx,
	);
	assert.ok(mcpBlocked, "MCP-prefixed write should be blocked for tester");
	assert.strictEqual((mcpBlocked as { block?: boolean }).block, true);

	console.log("✓ role gate blocks, allows, and stays transparent for unknown sessions");
}

async function testLoadProjectContext() {
	const ctxDir = join(TEST_TMP, "ctx-test");
	const piDir = join(ctxDir, ".pi");
	await mkdir(piDir, { recursive: true });
	await writeFile(
		join(piDir, "orchestrator-context.md"),
		[
			"<!-- role: all -->",
			"All roles see this.",
			"<!-- role: coder -->",
			"Coder only.",
			"<!-- role: tester,coder -->",
			"Tester and coder.",
		].join("\n"),
	);

	const allContext = await loadProjectContext(ctxDir);
	assert.ok(allContext.includes("All roles see this."), "missing all-section");
	assert.ok(allContext.includes("Coder only."), "coder section missing for all");

	const coderContext = await loadProjectContext(ctxDir, "coder");
	assert.ok(coderContext.includes("All roles see this."), "all missing for coder");
	assert.ok(coderContext.includes("Coder only."), "coder-only missing");
	assert.ok(coderContext.includes("Tester and coder."), "shared missing for coder");

	const testerContext = await loadProjectContext(ctxDir, "tester");
	assert.ok(testerContext.includes("All roles see this."), "all missing for tester");
	assert.ok(!testerContext.includes("Coder only."), "tester should not see coder-only");
	assert.ok(testerContext.includes("Tester and coder."), "shared missing for tester");

	console.log("✓ loadProjectContext role filtering");
}

async function main() {
	await setup();
	try {
		await testChains();
		await testState();
		await testArtifacts();
		await testReport();
		await testRestoreActiveRunId();
		await testLoadProjectContext();
		await testExtractSpawnIds();
		await testAsCompletionStatus();
		await testWaitForAsyncSubagent();
		await testWaitForAsyncSubagentTimeoutCleansInterval();
		await testRoleGate();
		console.log("\nAll conductor unit tests passed.");
	} finally {
		await cleanup();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
