import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadChains, getChain, listChains } from "./chains.ts";
import {
	createRunState,
	saveRunState,
	loadRunState,
	restoreActiveRunId,
	getCurrentStep,
	isTerminal,
	formatStatus,
} from "./state.ts";
import { ensureArtifactDir, loadProjectContext } from "./artifacts.ts";
import { buildTaskForStep, buildOutputInstruction } from "./report.ts";
import { pingSubagent, spawnSubagent, waitForAsyncSubagent, extractSpawnIds, logDebug } from "./runner.ts";
import { registerSubagentSession } from "./role-gate.ts";
import { updateDashboard, notifyStatus } from "./dashboard.ts";

function parseCommand(args: string): { subcommand: string; args: string[] } {
	const parts = args.trim().split(/\s+/);
	return { subcommand: parts[0] ?? "status", args: parts.slice(1) };
}

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1);
	}
	if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export function registerRunCommand(pi: ExtensionAPI) {
	pi.registerCommand("conductor", {
		description:
			"Conductor orchestration: /conductor run <chain> <theme>, /conductor next, /conductor status",
		getArgumentCompletions: (prefix) => {
			const subcommands = ["agent", "run", "next", "redo", "status", "abort"];
			return subcommands
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const { subcommand, args: subArgs } = parseCommand(args);

			try {
				switch (subcommand) {
					case "run":
						await handleRun(pi, ctx, subArgs);
						return;
					case "next":
						await handleNext(pi, ctx);
						return;
					case "redo":
						await handleRedo(pi, ctx, subArgs);
						return;
					case "abort":
						await handleAbort(pi, ctx);
						return;
					case "agent":
						await handleAgent(pi, ctx, subArgs);
						return;
					case "status":
					default:
						await handleStatus(pi, ctx);
						return;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notifyStatus(ctx, `Conductor error: ${message}`, "error");
				throw error;
			}
		},
	});
}

async function handleRun(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string[],
): Promise<void> {
	if (args.length < 2) {
		notifyStatus(ctx, "Usage: /conductor run <chain> <theme>", "warning");
		return;
	}

	const chainName = stripQuotes(args[0]);
	const theme = stripQuotes(args.slice(1).join(" "));
	const cwd = ctx.cwd;

	const ping = await pingSubagent(pi.events);
	if (!ping.success) {
		notifyStatus(ctx, `Conductor: pi-subagents RPC not ready: ${ping.error.message}`, "error");
		return;
	}

	const chains = await loadChains(cwd);
	const chain = getChain(chains, chainName);
	const state = createRunState(chainName, theme, chain.steps);

	await ensureArtifactDir(cwd, theme);
	await saveRunState(cwd, pi, state);
	updateDashboard(ctx, state);

	notifyStatus(ctx, `Conductor: started ${chainName} for "${theme}"`, "info");

	await runCurrentStep(pi, ctx, state);
}

async function handleNext(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const runId = restoreActiveRunId(ctx.sessionManager);
	if (!runId) {
		notifyStatus(ctx, "No active Conductor run. Use /conductor run <chain> <theme>", "warning");
		return;
	}

	const state = await loadRunState(ctx.cwd, runId);
	if (!state) {
		notifyStatus(ctx, `Conductor run ${runId} not found`, "error");
		return;
	}

	if (isTerminal(state)) {
		notifyStatus(ctx, `Conductor run ${state.chain} is ${state.status}`, "info");
		updateDashboard(ctx, state);
		return;
	}

	const current = getCurrentStep(state);
	if (!current || current.status !== "done") {
		notifyStatus(ctx, `Current step (${current?.role ?? "-"}) is not done yet.`, "warning");
		updateDashboard(ctx, state);
		return;
	}

	if (state.currentStepIndex >= state.steps.length - 1) {
		state.status = "done";
		await saveRunState(ctx.cwd, pi, state);
		updateDashboard(ctx, state);
		notifyStatus(ctx, `Conductor: ${state.chain} complete.`, "info");
		return;
	}

	state.currentStepIndex += 1;
	state.status = "running";
	await saveRunState(ctx.cwd, pi, state);
	updateDashboard(ctx, state);

	await runCurrentStep(pi, ctx, state);
}

export { handleNext };

async function handleRedo(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string[],
): Promise<void> {
	const runId = restoreActiveRunId(ctx.sessionManager);
	if (!runId) {
		notifyStatus(ctx, "No active Conductor run.", "warning");
		return;
	}

	const state = await loadRunState(ctx.cwd, runId);
	if (!state) {
		notifyStatus(ctx, `Conductor run ${runId} not found`, "error");
		return;
	}

	if (isTerminal(state)) {
		notifyStatus(ctx, `Run ${state.chain} is ${state.status}.`, "warning");
		return;
	}

	const extra = args.join(" ");
	const step = getCurrentStep(state);
	if (step) {
		step.status = "redo";
		step.error = undefined;
	}
	state.status = "running";
	await saveRunState(ctx.cwd, pi, state);
	updateDashboard(ctx, state);

	await runCurrentStep(pi, ctx, state, extra);
}

async function handleAbort(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const runId = restoreActiveRunId(ctx.sessionManager);
	if (!runId) {
		notifyStatus(ctx, "No active Conductor run to abort.", "warning");
		return;
	}

	const state = await loadRunState(ctx.cwd, runId);
	if (state) {
		state.status = "aborted";
		await saveRunState(ctx.cwd, pi, state);
		updateDashboard(ctx, state);
	}
	notifyStatus(ctx, `Conductor run ${runId} aborted.`, "warning");
}

async function handleStatus(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const runId = restoreActiveRunId(ctx.sessionManager);
	let state = null;
	if (runId) {
		state = await loadRunState(ctx.cwd, runId);
	}
	if (!state) {
		notifyStatus(ctx, "Conductor: idle | no active run", "info");
		updateDashboard(ctx, null);
		return;
	}
	const text = formatStatus(state);
	notifyStatus(ctx, `Conductor: ${text}`, "info");
	updateDashboard(ctx, state);
}

async function handleAgent(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string[],
): Promise<void> {
	const agent = args[0] ?? "worker";
	const task = args.slice(1).join(" ") || `Conductor proof-of-concept task for ${agent}`;
	const outputPath = `${ctx.cwd}/tmp/conductor/poc-${agent}-${Date.now()}.md`;
	const projectContext = await loadProjectContext(ctx.cwd, agent);
	const fullTask = projectContext ? `${projectContext}\n\n${task}` : task;

	const ping = await pingSubagent(pi.events);
	if (!ping.success) {
		notifyStatus(ctx, `Conductor: pi-subagents RPC not ready: ${ping.error.message}`, "error");
		return;
	}

	notifyStatus(ctx, `Conductor: spawning subagent ${agent}...`, "info");
	const result = await spawnSubagent(pi.events, { agent, task: fullTask, output: outputPath });
	if (!result.success) {
		notifyStatus(ctx, `Conductor: spawn failed: ${result.error.message}`, "error");
		return;
	}

	const data = result.data;
	const { runId, asyncDir: _spawnDir } = extractSpawnIds(data);
	notifyStatus(ctx, `Conductor: spawned ${agent} (${runId}). Output: ${outputPath}`, "info");
}

export interface SubagentStepResult {
	status: "completed" | "failed";
	outputPath: string;
	error?: string;
	subagentRunId?: string;
}

export async function runSubagentStep(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	role: string,
	theme: string,
	task: string,
	outputPath: string,
): Promise<SubagentStepResult> {
	const projectContext = await loadProjectContext(ctx.cwd, role);
	const fullTask = projectContext ? `${projectContext}\n\n${task}` : task;
	const fullTaskWithOutput = `${fullTask}${buildOutputInstruction(outputPath)}`;

	notifyStatus(ctx, `Conductor: running ${role} for "${theme}"...`, "info");

	const result = await spawnSubagent(pi.events, {
		agent: role,
		task: fullTaskWithOutput,
		context: "fresh",
	});

	void logDebug(
		`spawn result: success=${result.success} data=${JSON.stringify(result.success ? result.data : result.error)}`,
	);

	if (!result.success) {
		return {
			status: "failed",
			outputPath,
			error: result.error.message,
		};
	}

	const data = result.data;
	const { runId, asyncDir } = extractSpawnIds(data);

	const sessionId =
		(result as { sessionId?: string }).sessionId ??
		(data as { sessionId?: string }).sessionId ??
		runId;
	if (sessionId && sessionId !== "unknown") {
		registerSubagentSession(sessionId, role);
	}

	if (runId === "unknown" || !runId) {
		return {
			status: "failed",
			outputPath,
			error: "Subagent spawn response did not contain a valid runId",
		};
	}

	try {
		const completion = await waitForAsyncSubagent(pi.events, ctx.cwd, role, runId, asyncDir);
		if (completion.status === "completed") {
			return { status: "completed", outputPath, subagentRunId: runId };
		}
		return {
			status: "failed",
			outputPath,
			error: completion.error || completion.status,
			subagentRunId: runId,
		};
	} catch (error) {
		return {
			status: "failed",
			outputPath,
			error: error instanceof Error ? error.message : String(error),
			subagentRunId: runId,
		};
	}
}

async function runCurrentStep(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	state: import("./types.ts").ChainRunState,
	extraInstructions?: string,
): Promise<void> {
	const stepIndex = state.currentStepIndex;
	const role = state.steps[stepIndex];
	const stepState = getCurrentStep(state);
	if (!stepState) return;

	stepState.status = "running";
	stepState.startedAt = new Date().toISOString();
	stepState.error = undefined;
	await saveRunState(ctx.cwd, pi, state);
	updateDashboard(ctx, state);

	const projectContext = await loadProjectContext(ctx.cwd, role);
	const { task, outputPath } = buildTaskForStep(ctx.cwd, state, stepIndex, extraInstructions, projectContext);
	const fullTask = `${task}${buildOutputInstruction(outputPath)}`;

	notifyStatus(ctx, `Conductor: running ${role} for "${state.theme}"...`, "info");

	const result = await spawnSubagent(pi.events, {
		agent: role,
		task: fullTask,
		context: "fresh",
	});

	void logDebug(`spawn result: success=${result.success} data=${JSON.stringify(result.success ? result.data : result.error)}`);

	if (!result.success) {
		stepState.status = "failed";
		stepState.finishedAt = new Date().toISOString();
		stepState.error = result.error.message;
		state.status = "paused";
		await saveRunState(ctx.cwd, pi, state);
		updateDashboard(ctx, state);
		notifyStatus(ctx, `Conductor: ${role} failed: ${result.error.message}`, "error");
		return;
	}

	const data = result.data;
	const { runId, asyncDir } = extractSpawnIds(data);

	const sessionId =
		(result as { sessionId?: string }).sessionId ??
		(data as { sessionId?: string }).sessionId ??
		runId;
	if (sessionId && sessionId !== "unknown") {
		registerSubagentSession(sessionId, role);
	}

	if (runId === "unknown" || !runId) {
		stepState.status = "failed";
		stepState.finishedAt = new Date().toISOString();
		stepState.error = "Subagent spawn response did not contain a valid runId";
		state.status = "paused";
		await saveRunState(ctx.cwd, pi, state);
		updateDashboard(ctx, state);
		notifyStatus(ctx, `Conductor: ${role} spawn response missing runId`, "error");
		return;
	}
	stepState.subagentRunId = runId;
	await saveRunState(ctx.cwd, pi, state);

	try {
		const completion = await waitForAsyncSubagent(pi.events, ctx.cwd, role, runId, asyncDir);
		stepState.finishedAt = new Date().toISOString();
		stepState.artifact = outputPath;
		if (completion.status === "completed") {
			stepState.status = "done";
			state.status = "paused";
			await saveRunState(ctx.cwd, pi, state);
			updateDashboard(ctx, state);
			notifyStatus(
				ctx,
				`Conductor: ${role} done. Run /conductor next to continue (${stepIndex + 1}/${state.steps.length}).`,
				"info",
			);
		} else {
			stepState.status = "failed";
			stepState.error = completion.error || completion.status;
			state.status = "paused";
			await saveRunState(ctx.cwd, pi, state);
			updateDashboard(ctx, state);
			notifyStatus(
				ctx,
				`Conductor: ${role} finished with status ${completion.status}. ${completion.error || ""}`,
				"warning",
			);
		}
	} catch (error) {
		stepState.status = "failed";
		stepState.finishedAt = new Date().toISOString();
		stepState.error = error instanceof Error ? error.message : String(error);
		state.status = "paused";
		await saveRunState(ctx.cwd, pi, state);
		updateDashboard(ctx, state);
		notifyStatus(ctx, `Conductor: ${role} wait failed: ${stepState.error}`, "error");
	}
}
