import type { ChainRunState } from "./types.ts";
import { previousArtifactPath } from "./artifacts.ts";

export function buildTaskForStep(
	cwd: string,
	state: ChainRunState,
	stepIndex: number,
	extra?: string,
	context?: string,
): { role: string; task: string; outputPath: string } {
	const role = state.steps[stepIndex];
	const outputPath = outputPathForRole(cwd, state.theme, stepIndex, role);
	const prevArtifact = previousArtifactPath(cwd, state.theme, stepIndex, state.steps);
	const baseTask = basePromptForRole(role, state.theme, prevArtifact);
	const parts = [baseTask];
	if (context) {
		parts.push(`## Project context\n\n${context}`);
	}
	if (extra) {
		parts.push(`## Additional instructions\n\n${extra}`);
	}
	const task = parts.join("\n\n");
	return { role, task, outputPath };
}

function outputPathForRole(cwd: string, theme: string, stepIndex: number, role: string): string {
	const fileName = (() => {
		switch (role) {
			case "explore":
				return "AUDIT.md";
			case "plan":
				return "plan.md";
			case "coder":
				return "code.md";
			case "tester":
				return "report.json";
			case "fixer":
				return "fix.md";
			default:
				return `${role}.md`;
		}
	})();
	return `${cwd}/tmp/conductor/${theme}/${fileName}`;
}

function basePromptForRole(role: string, theme: string, previousArtifact?: string): string {
	switch (role) {
		case "explore":
			return `Read relevant code and docs and produce an AUDIT.md with stack, file map, and hotspots for: ${theme}. Write the final artifact to the path below. Be concise and evidence-based.`;
		case "plan":
			return `Given the previous AUDIT.md${previousArtifact ? ` at ${previousArtifact}` : ""}, produce a focused plan.md for: ${theme}. Write the final artifact to the path below. Keep scope tight and testable.`;
		case "coder":
			return `Implement the plan${previousArtifact ? ` at ${previousArtifact}` : ""} for: ${theme}. Write tests where appropriate. Write a summary of changes and verification steps to the artifact path below. Do not widen scope.`;
		case "tester":
			return `Run tests for: ${theme}. You will receive a category and target project path in the task. If they are absent, default to category="full-flow" and projectPath to the current working directory. Use get_test_profile to resolve the exact test command and flags, run it, and produce a strict report.json with { testsPassed, acceptanceMet, visualTestsPassed, failures[], flags[], summary, humanReviewNeeded, category, profileName, isFallback, fallbackReason, command, exitCode, artifacts[], residualRisks[], recommendations[], next_agent } to the path below. Be strict about evidence; never infer a passing visual test from other passing tests.`;
		case "fixer":
			return `Address the tester report${previousArtifact ? ` at ${previousArtifact}` : ""} for: ${theme}. Write the fix summary to the artifact path below.`;
		default:
			return `Work on: ${theme}. Write your final artifact to the path below.`;
	}
}

export function buildOutputInstruction(path: string): string {
	return `\n\n**Output:**\nWrite your final artifact to exactly this path: ${path}\nThis path is authoritative for this run. Ignore any other output filename or path mentioned elsewhere. This is an implementation task: do it now.`;
}
