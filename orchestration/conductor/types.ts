import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface ConductorState {
	activeRunId: string | null;
}

export interface SpawnSubagentOptions {
	agent: string;
	task: string;
	context?: "fresh" | "fork";
	output?: string;
	model?: string;
	thinking?: string;
}

export type SubagentRpcReply<T = unknown> =
	| {
			version: 1;
			requestId: string;
			method?: string;
			success: true;
			data: T;
	  }
	| {
			version: 1;
			requestId: string;
			method?: string;
			success: false;
			error: {
				code: string;
				message: string;
			};
	  };

export interface ConductorExtensionContext extends ExtensionCommandContext {
	// Marker type for conductor-specific context helpers.
}

export interface ChainDefinition {
	steps: string[];
}

export interface ChainsConfig {
	chains: Record<string, string[]>;
}

export interface StepState {
	role: string;
	status: "pending" | "running" | "done" | "failed" | "redo";
	artifact?: string;
	subagentRunId?: string;
	startedAt?: string;
	finishedAt?: string;
	error?: string;
}

export interface ChainRunState {
	runId: string;
	chain: string;
	steps: string[];
	theme: string;
	currentStepIndex: number;
	status: "running" | "paused" | "done" | "aborted";
	stepStates: StepState[];
	createdAt: string;
	updatedAt: string;
}

export interface ConductorSettings {
	conductor?: {
		roles?: Record<string, { allowedTools?: string[] }>;
	};
}

export interface ParsedCommandArgs {
	subcommand: string;
	args: string[];
}
