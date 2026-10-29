import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createRalphState, saveRalphState, loadRalphState, restoreActiveRalphRunId, formatRalphStatus } from "./state.ts";
import { runRalphPhase, updateRalphDashboard, isRalphTerminal } from "./loop.ts";
import { notifyRalph } from "./notify.ts";
import { notifyStatus } from "../dashboard.ts";
import { pingSubagent } from "../runner.ts";
import type { RalphState, RalphRunOptions, RalphAutonomyLevel } from "./types.ts";

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

export function registerRalphCommand(pi: ExtensionAPI) {
	pi.registerCommand("ralph", {
		description:
			"Ralph adaptive loop: /ralph run [--auto] [--project <path>] <goal>, /ralph continue, /ralph status, /ralph abort, /ralph pause",
		getArgumentCompletions: (prefix) => {
			const subcommands = ["run", "continue", "status", "abort", "pause"];
			return subcommands
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const { subcommand, args: subArgs } = parseCommand(args);

			try {
				switch (subcommand) {
					case "run":
						await handleRalphRun(pi, ctx, subArgs);
						return;
					case "continue":
						await handleRalphContinue(pi, ctx);
						return;
					case "abort":
						await handleRalphAbort(pi, ctx);
						return;
					case "pause":
						await handleRalphPause(pi, ctx);
						return;
					case "status":
					default:
						await handleRalphStatus(pi, ctx);
						return;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notifyStatus(ctx, `Ralph error: ${message}`, "error");
				throw error;
			}
		},
	});
}

function parseRalphArgs(args: string[]): { goal: string; options: RalphRunOptions } {
	const autoIndex = args.indexOf("--auto");
	const autoApprove = autoIndex !== -1;
	if (autoApprove) {
		args.splice(autoIndex, 1);
	}

	const projectIndex = args.indexOf("--project");
	let targetProjectPath: string | undefined;
	if (projectIndex !== -1 && projectIndex + 1 < args.length) {
		targetProjectPath = stripQuotes(args[projectIndex + 1]);
		args.splice(projectIndex, 2);
	}

	const autonomyIndex = args.indexOf("--autonomy");
	let autonomyLevel: RalphAutonomyLevel | undefined;
	if (autonomyIndex !== -1 && autonomyIndex + 1 < args.length) {
		const raw = stripQuotes(args[autonomyIndex + 1]);
		if (
			raw === "recommend" ||
			raw === "execute-with-review" ||
			raw === "execute-and-report" ||
			raw === "human-approval-required"
		) {
			autonomyLevel = raw;
		}
		args.splice(autonomyIndex, 2);
	}

	const goal = stripQuotes(args.join(" "));
	return { goal, options: { autoApprove, targetProjectPath, autonomyLevel } };
}

async function handleRalphRun(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string[],
): Promise<void> {
	if (args.length === 0) {
		notifyStatus(ctx, "Usage: /ralph run [--auto] [--autonomy <level>] [--project <target-project-path>] <goal>", "warning");
		return;
	}

	const { goal, options } = parseRalphArgs(args);
	const ping = await pingSubagent(pi.events);
	if (!ping.success) {
		notifyStatus(ctx, `Ralph: pi-subagents RPC not ready: ${ping.error.message}`, "error");
		return;
	}

	const state = createRalphState(goal, options);
	await saveRalphState(ctx.cwd, pi, state);
	updateRalphDashboard(ctx, state);
	notifyRalph(ctx, { state, event: "started" });
	notifyStatus(ctx, `Ralph: started loop for "${goal}"${state.autoApprove ? " (auto-approve)" : ""}`, "info");

	await runRalphPhase(pi, ctx, state);
}

async function handleRalphContinue(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const runId = restoreActiveRalphRunId(ctx.sessionManager);
	if (!runId) {
		notifyStatus(ctx, "No active Ralph loop. Use /ralph run <goal>", "warning");
		return;
	}

	const state = await loadRalphState(ctx.cwd, runId);
	if (!state) {
		notifyStatus(ctx, `Ralph loop ${runId} not found`, "error");
		return;
	}

	if (isRalphTerminal(state)) {
		notifyStatus(ctx, `Ralph loop is ${state.status}`, "info");
		updateRalphDashboard(ctx, state);
		return;
	}

	state.status = "running";
	state.pauseRequested = false;
	await saveRalphState(ctx.cwd, pi, state);
	updateRalphDashboard(ctx, state);

	await runRalphPhase(pi, ctx, state);
}

async function handleRalphPause(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const runId = restoreActiveRalphRunId(ctx.sessionManager);
	if (!runId) {
		notifyStatus(ctx, "No active Ralph loop to pause.", "warning");
		return;
	}

	const state = await loadRalphState(ctx.cwd, runId);
	if (!state || isRalphTerminal(state)) {
		notifyStatus(ctx, `Ralph loop is ${state?.status ?? "not found"}`, "info");
		return;
	}

	state.pauseRequested = true;
	await saveRalphState(ctx.cwd, pi, state);
	updateRalphDashboard(ctx, state);
	notifyStatus(ctx, `Ralph: will pause at the next decision point.`, "info");
}

async function handleRalphAbort(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const runId = restoreActiveRalphRunId(ctx.sessionManager);
	if (!runId) {
		notifyStatus(ctx, "No active Ralph loop to abort.", "warning");
		return;
	}

	const state = await loadRalphState(ctx.cwd, runId);
	if (state) {
		state.status = "aborted";
		state.phase = "aborted";
		await saveRalphState(ctx.cwd, pi, state);
		updateRalphDashboard(ctx, state);
		notifyRalph(ctx, { state, event: "abort" });
	}
	notifyStatus(ctx, `Ralph loop ${runId} aborted.`, "warning");
}

async function handleRalphStatus(
	_pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const runId = restoreActiveRalphRunId(ctx.sessionManager);
	let state: RalphState | null = null;
	if (runId) {
		state = await loadRalphState(ctx.cwd, runId);
	}
	if (!state) {
		notifyStatus(ctx, "Ralph: idle | no active loop", "info");
		updateRalphDashboard(ctx, null);
		return;
	}
	const text = formatRalphStatus(state);
	notifyStatus(ctx, `Ralph: ${text}`, "info");
	updateRalphDashboard(ctx, state);
}

