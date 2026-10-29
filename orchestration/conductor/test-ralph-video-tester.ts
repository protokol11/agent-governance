import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readVerifyResult } from "./ralph/loop.ts";
import { decideAfterVerify } from "./ralph/planner.ts";
import type { RalphState } from "./ralph/types.ts";

function assert(condition: boolean, message: string) {
	if (!condition) {
		console.error(`FAIL: ${message}`);
		process.exit(1);
	}
	console.log(`PASS: ${message}`);
}

async function main() {
	console.log("--- Ralph + video tester integration tests ---");

	const tmp = await mkdtemp(join(tmpdir(), "ralph-video-tester-"));
	try {
		const theme = "tiktok-warmup";
		const artifactDir = join(tmp, "tmp", "conductor", "ralph", theme);
		await mkdir(artifactDir, { recursive: true });

		const report = {
			testsPassed: false,
			acceptanceMet: false,
			visualTestsPassed: false,
			failures: ["Live test flagged issues"],
			flags: ["mouse robotic", "scroll uniform"],
			summary: "Video tester flagged behavioral issues.",
			liveTestFailed: true,
			humanReviewNeeded: true,
			severity: "high",
			category: "mouse",
			next_agent: "coder",
			recommendations: ["Add curve to mouse movements"],
			evidence_links: ["videos/accountA_2026-07-21_19-52-08.webm"],
			videoReports: [
				{
					account: "accountA",
					visualTestsPassed: false,
					humanReviewNeeded: true,
					severity: "high",
					category: "mouse",
					flags: [{ category: "mouse", severity: "high", note: "straight line" }],
				},
			],
		};
		await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2), "utf-8");

		const state: RalphState = {
			runId: "ralph-123",
			goal: "tiktok warmup",
			status: "running",
			phase: "decide",
			iteration: 1,
			maxIterations: 5,
			autoApprove: false,
			pauseRequested: false,
			activeSubagentSession: null,
			lastDecision: null,
			commits: [],
			artifacts: [],
			acceptanceCriteria: ["Warmup completes without flags."],
			iterations: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		const verifyResult = await readVerifyResult(tmp, state);
		assert(verifyResult.humanReviewNeeded === true, "humanReviewNeeded should be true");
		assert(verifyResult.severity === "high", "severity should be high");
		assert(verifyResult.category === "mouse", "category should be mouse");
		assert(verifyResult.next_agent === "coder", "next_agent should be coder");
		assert(
			Array.isArray(verifyResult.videoReports) && verifyResult.videoReports.length === 1,
			"videoReports should contain one report",
		);
		assert(
			verifyResult.recommendations?.includes("Add curve to mouse movements") === true,
			"recommendations should be parsed",
		);

		const decision = decideAfterVerify(state, verifyResult);
		assert(decision.decision === "human", `decision should be human, got ${decision.decision}`);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}

	console.log("--- All Ralph + video tester integration tests passed ---");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
