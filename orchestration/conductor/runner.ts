import { randomUUID } from "node:crypto";
import { readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { SpawnSubagentOptions, SubagentRpcReply } from "./types.ts";
import { registerSubagentSession } from "./role-gate.ts";

const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";

const SPAWN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for the single RPC reply
const STEP_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes for a step to finish
const POLL_INTERVAL_MS = 2000;

const LOG_FILE = "tmp/conductor/conductor-debug.log";

async function logDebug(message: string): Promise<void> {
	try {
		const ts = new Date().toISOString();
		await appendFile(LOG_FILE, `[${ts}] ${message}\n`, "utf-8");
	} catch {
		// best effort
	}
}

export { logDebug };

export interface SpawnDetails {
	text?: string;
	runId?: string;
	id?: string;
	asyncId?: string;
	asyncDir?: string;
	details?: {
		mode?: string;
		runId?: string;
		id?: string;
		asyncId?: string;
		asyncDir?: string;
		results?: unknown[];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		[key: string]: any;
	};
}

export function extractSpawnIds(data: SpawnDetails): { runId: string; asyncDir?: string } {
	const runId =
		data.runId ??
		data.id ??
		data.asyncId ??
		data.details?.runId ??
		data.details?.id ??
		data.details?.asyncId ??
		"unknown";
	const asyncDir = data.asyncDir ?? data.details?.asyncDir;
	return { runId, asyncDir };
}

export function spawnSubagent(
	events: EventBus,
	options: SpawnSubagentOptions,
): Promise<SubagentRpcReply<SpawnDetails>> {
	const requestId = randomUUID();

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error(`Subagent RPC spawn timed out after ${SPAWN_TIMEOUT_MS / 1000}s`));
		}, SPAWN_TIMEOUT_MS);

		function handler(reply: unknown) {
			clearTimeout(timeout);
			cleanup();
			resolve(reply as SubagentRpcReply<SpawnDetails>);
		}

		const cleanup = () => {
			try {
				unsubscribe();
			} catch {
				// best effort
			}
		};

		const unsubscribe = events.on(`${RPC_REPLY_PREFIX}${requestId}`, handler);

		void logDebug(`spawnSubagent request: ${requestId} agent=${options.agent}`);
		events.emit(RPC_REQUEST_EVENT, {
			version: 1,
			requestId,
			method: "spawn",
			params: {
				agent: options.agent,
				task: options.task,
				context: options.context ?? "fresh",
				async: true,
				clarify: false,
				output: options.output,
				model: options.model,
			},
		});
	});
}

export function pingSubagent(events: EventBus): Promise<SubagentRpcReply<unknown>> {
	const requestId = randomUUID();

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error("Subagent RPC ping timed out after 10s"));
		}, 10_000);

		function handler(reply: unknown) {
			clearTimeout(timeout);
			cleanup();
			resolve(reply as SubagentRpcReply<unknown>);
		}

		const cleanup = () => {
			try {
				unsubscribe();
			} catch {
				// best effort
			}
		};

		const unsubscribe = events.on(`${RPC_REPLY_PREFIX}${requestId}`, handler);

		events.emit(RPC_REQUEST_EVENT, {
			version: 1,
			requestId,
			method: "ping",
		});
	});
}

export interface AsyncCompletionInfo {
	runId: string;
	status: "completed" | "failed" | "paused" | "detached";
	summary?: string;
	error?: string;
	asyncDir?: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	details?: Record<string, any>;
}

interface StatusJson {
	state?: "queued" | "running" | "complete" | "failed" | "paused";
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	error?: any;
	summary?: string;
}

interface SubagentArtifactMeta {
	runId?: string;
	agent?: string;
	exitCode?: number;
	success?: boolean;
	transcriptPath?: string;
}

async function readStatusJson(asyncDir: string): Promise<StatusJson | null> {
	try {
		const raw = await readFile(`${asyncDir}/status.json`, "utf-8");
		return JSON.parse(raw) as StatusJson;
	} catch {
		return null;
	}
}

async function readArtifactMeta(
	cwd: string,
	runId: string,
	role: string,
): Promise<SubagentArtifactMeta | null> {
	const candidates = [
		join(cwd, ".pi-subagents", "artifacts", `${runId}_${role}_meta.json`),
		join(cwd, ".pi-subagents", "artifacts", `${runId}_${role}_0_meta.json`),
	];
	for (const path of candidates) {
		try {
			const raw = await readFile(path, "utf-8");
			const parsed = JSON.parse(raw) as SubagentArtifactMeta;
			void logDebug(`artifact-meta found: ${path} exitCode=${parsed.exitCode} success=${parsed.success}`);
			return parsed;
		} catch {
			// try next
		}
	}
	return null;
}

export function waitForAsyncSubagent(
	events: EventBus,
	cwd: string,
	role: string,
	asyncId: string,
	asyncDir?: string,
	timeoutMs = STEP_TIMEOUT_MS,
): Promise<AsyncCompletionInfo> {
	return new Promise((resolve, reject) => {
		if (!asyncId || asyncId === "unknown") {
			void logDebug(`waitForAsyncSubagent rejected: invalid asyncId=${asyncId} role=${role}`);
			reject(new Error(`Cannot wait for async subagent: invalid asyncId ${asyncId}`));
			return;
		}

		let done = false;
		const timeout = setTimeout(() => {
			if (done) return;
			done = true;
			if (pollTimer) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
			clearResources();
			reject(new Error(`Async subagent ${asyncId} timed out after ${timeoutMs / 1000}s`));
		}, timeoutMs);

		let pollTimer: ReturnType<typeof setInterval> | null = null;

		function finalize(info: AsyncCompletionInfo) {
			if (done) return;
			done = true;
			clearTimeout(timeout);
			if (pollTimer) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
			clearResources();
			resolve(info);
		}

		function handler(event: unknown) {
			const data = event as {
				id?: string;
				runId?: string;
				asyncId?: string;
				state?: string;
				success?: boolean;
				summary?: string;
				error?: string;
				asyncDir?: string;
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				details?: Record<string, any>;
			};
			const eventAsyncId = data.runId ?? data.id ?? data.asyncId;
			void logDebug(
				`async-complete event: id=${data.id} runId=${data.runId} asyncId=${asyncId} state=${data.state} success=${data.success}`,
			);
			if (eventAsyncId !== asyncId) return;
			finalize({
				runId: data.runId ?? asyncId,
				status: asCompletionStatus(data.success, data.state),
				summary: data.summary,
				error: data.error,
				asyncDir: data.asyncDir,
				details: data.details,
			});
		}

		async function poll() {
			if (done) return;
			try {
				const meta = await readArtifactMeta(cwd, asyncId, role);
				if (meta && (typeof meta.exitCode === "number" || typeof meta.success === "boolean")) {
					const succeeded = meta.success === true || meta.exitCode === 0;
					finalize({
						runId: asyncId,
						status: asCompletionStatus(succeeded, succeeded ? "complete" : "failed"),
						summary: undefined,
						error: succeeded ? undefined : `exitCode=${meta.exitCode}`,
						asyncDir,
					});
					return;
				}
			} catch (error) {
				void logDebug(`poll error: ${error instanceof Error ? error.message : String(error)}`);
			}

			// Legacy status.json fallback
			if (asyncDir) {
				try {
					const status = await readStatusJson(asyncDir);
					if (!status) return;
					void logDebug(`poll status.json: ${asyncId} state=${status.state}`);
					if (status.state === "complete" || status.state === "failed" || status.state === "paused") {
						finalize({
							runId: asyncId,
							status: asCompletionStatus(status.state === "complete", status.state),
							summary: status.summary,
							error: typeof status.error === "string" ? status.error : status.state,
							asyncDir,
						});
					}
				} catch (error) {
					void logDebug(`status.json poll error: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}

		const clearResources = () => {
			try {
				unsubscribe();
			} catch {
				// best effort
			}
		};

		const unsubscribe = events.on(ASYNC_COMPLETE_EVENT, handler);
		pollTimer = setInterval(poll, POLL_INTERVAL_MS);
		void logDebug(`waitForAsyncSubagent started: asyncId=${asyncId} role=${role} cwd=${cwd}`);
		void poll();
	});
}

export function asCompletionStatus(success?: boolean, state?: string): AsyncCompletionInfo["status"] {
	if (success === true) return "completed";
	if (success === false) return "failed";
	if (state === "failed") return "failed";
	if (state === "paused") return "paused";
	if (state === "complete") return "completed";
	return "detached";
}
