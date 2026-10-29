import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ChainRunState, StepState } from "./types.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_DIR = "tmp/conductor";
const STATE_ENTRY_TYPE = "conductor-state";

export function statePath(cwd: string, runId: string): string {
	return join(cwd, STATE_DIR, runId, "state.json");
}

export function makeRunId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createRunState(chain: string, theme: string, steps: string[]): ChainRunState {
	const runId = makeRunId();
	const now = new Date().toISOString();
	return {
		runId,
		chain,
		theme,
		steps,
		currentStepIndex: 0,
		status: "running",
		stepStates: steps.map((role) => ({ role, status: "pending" })),
		createdAt: now,
		updatedAt: now,
	};
}

export async function saveRunState(
	cwd: string,
	pi: ExtensionAPI,
	state: ChainRunState,
): Promise<void> {
	state.updatedAt = new Date().toISOString();
	const path = statePath(cwd, state.runId);
	await mkdir(join(cwd, STATE_DIR, state.runId), { recursive: true });
	await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
	pi.appendEntry(STATE_ENTRY_TYPE, { runId: state.runId, status: state.status, updatedAt: state.updatedAt });
}

export async function loadRunState(cwd: string, runId: string): Promise<ChainRunState | null> {
	try {
		const raw = await readFile(statePath(cwd, runId), "utf-8");
		return JSON.parse(raw) as ChainRunState;
	} catch {
		return null;
	}
}

export function restoreActiveRunId(sessionManager: ExtensionContext["sessionManager"]): string | null {
	try {
		const entries = sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (
				entry?.type === "custom" &&
				"customType" in entry &&
				entry.customType === STATE_ENTRY_TYPE &&
				"data" in entry &&
				entry.data &&
				typeof entry.data === "object" &&
				"runId" in (entry.data as Record<string, unknown>) &&
				typeof (entry.data as Record<string, unknown>).runId === "string"
			) {
				return (entry.data as Record<string, unknown>).runId as string;
			}
		}
	} catch {
		// best effort
	}
	return null;
}

export function getCurrentStep(state: ChainRunState): StepState | undefined {
	return state.stepStates[state.currentStepIndex];
}

export function isTerminal(state: ChainRunState): boolean {
	return state.status === "done" || state.status === "aborted";
}

export function formatStatus(state: ChainRunState): string {
	const step = state.currentStepIndex + 1;
	const total = state.steps.length;
	const role = state.steps[state.currentStepIndex] ?? "-";
	return `${state.chain} | step ${step}/${total} (${role}) | ${state.status}`;
}
