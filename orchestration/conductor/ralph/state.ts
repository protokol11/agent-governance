import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RalphState, RalphIteration, RalphRunOptions } from "./types.ts";
import { sanitizeSlug } from "../artifacts.ts";

const RALPH_DIR = "ralph";
const STATE_ENTRY_TYPE = "ralph-state";

export function makeRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function ralphStateDir(cwd: string, runId: string): string {
  return join(cwd, RALPH_DIR, runId);
}

export function ralphStatePath(cwd: string, runId: string): string {
  return join(ralphStateDir(cwd, runId), "state.json");
}

export function iterationPath(cwd: string, runId: string, iteration: number): string {
  return join(ralphStateDir(cwd, runId), "iterations", `${iteration.toString().padStart(3, "0")}_${iteration}.json`);
}

export function createRalphState(goal: string, opts: RalphRunOptions = {}): RalphState {
  const now = new Date().toISOString();
  return {
    runId: makeRunId(),
    goal,
    targetProjectPath: opts.targetProjectPath,
    status: "running",
    phase: "define",
    iteration: 1,
    maxIterations: opts.maxIterations ?? 10,
    autoApprove: opts.autoApprove ?? false,
    autonomyLevel: opts.autonomyLevel ?? (opts.autoApprove ? "execute-and-report" : "execute-with-review"),
    pauseRequested: false,
    activeSubagentSession: null,
    lastDecision: null,
    commits: [],
    artifacts: [],
    acceptanceCriteria: [],
    iterations: [],
    createdAt: now,
    updatedAt: now,
  };
}

export async function saveRalphState(
  cwd: string,
  pi: ExtensionAPI,
  state: RalphState,
): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const dir = ralphStateDir(cwd, state.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(ralphStatePath(cwd, state.runId), JSON.stringify(state, null, 2), "utf-8");
  pi.appendEntry(STATE_ENTRY_TYPE, { runId: state.runId, status: state.status, updatedAt: state.updatedAt });
}

export async function saveRalphIteration(
  cwd: string,
  iteration: RalphIteration,
): Promise<void> {
  const iterDir = join(ralphStateDir(cwd, iteration.runId), "iterations");
  await mkdir(iterDir, { recursive: true });
  await writeFile(
    iterationPath(cwd, iteration.runId, iteration.iteration),
    JSON.stringify(iteration, null, 2),
    "utf-8",
  );
}

export async function loadRalphState(cwd: string, runId: string): Promise<RalphState | null> {
  try {
    const raw = await readFile(ralphStatePath(cwd, runId), "utf-8");
    return JSON.parse(raw) as RalphState;
  } catch {
    return null;
  }
}

export function restoreActiveRalphRunId(sessionManager: {
  getEntries: () => { type?: string; customType?: string; data?: unknown }[];
}): string | null {
  try {
    const entries = sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (
        entry?.type === "custom" &&
        entry.customType === STATE_ENTRY_TYPE &&
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

export function goalSlug(goal: string): string {
  return sanitizeSlug(goal).slice(0, 40);
}

export function formatRalphStatus(state: RalphState): string {
  return `${goalSlug(state.goal)} | iter ${state.iteration}/${state.maxIterations} | ${state.phase} | ${state.status}`;
}
