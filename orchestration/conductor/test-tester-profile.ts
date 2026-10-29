import assert from "node:assert";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveTestProfile, type ResolvedProfile } from "./tester-profile-logic.ts";

const TEST_TMP = join(process.cwd(), "tmp-tester-profile-test");

async function setup() {
	await mkdir(TEST_TMP, { recursive: true });
}

async function cleanup() {
	await rm(TEST_TMP, { recursive: true, force: true });
}

async function writeProfile(profile: unknown) {
	const piDir = join(TEST_TMP, ".pi", "profiles");
	await mkdir(piDir, { recursive: true });
	await writeFile(join(piDir, "tester.json"), JSON.stringify(profile, null, 2), "utf-8");
}

async function removeProfile() {
	try {
		await rm(join(TEST_TMP, ".pi", "profiles", "tester.json"), { force: true });
	} catch {
		// ignore
	}
}

async function callTool(category: string, context?: Record<string, string>) {
	return resolveTestProfile({
		projectPath: TEST_TMP,
		category,
		context,
	});
}

async function testResolvesMappedProfile() {
	await writeProfile({
		categoryMapping: { auth: "auth-flow", scroll: "ux-animation" },
		defaultProfile: "full-flow",
		profiles: {
			"auth-flow": {
				cmd: "npm",
				args: ["run", "test:auth", "--runId={{runId}}"],
				env: { ACCOUNT: "{{account}}" },
				workingDirectory: "{{projectPath}}",
				timeout: 120,
				liveAlways: true,
				humanReviewNeeded: false,
				description: "Auth tests for {{account}}",
				categories: ["api", "state"],
				reportPath: "reports/{{runId}}-auth.json",
				artifactGlobs: ["videos/{{account}}_*.webm"],
			},
			"full-flow": {
				cmd: "npm",
				args: ["run", "test:full"],
				liveAlways: true,
				humanReviewNeeded: true,
				description: "Full flow",
				categories: ["ui", "movement", "input", "modal", "anti-bot", "api", "state"],
				reportPath: "reports/full-flow.json",
			},
		},
	});

	const result = await callTool("auth", { runId: "run-42", account: "alice" });

	assert.strictEqual(result.profileName, "auth-flow");
	assert.strictEqual(result.isFallback, false);
	assert.strictEqual(result.fallbackReason, null);
	assert.strictEqual(result.cmd, "npm");
	assert.deepStrictEqual(result.args, ["run", "test:auth", "--runId=run-42"]);
	assert.deepStrictEqual(result.env, { ACCOUNT: "alice" });
	assert.strictEqual(result.workingDirectory, TEST_TMP);
	assert.strictEqual(result.timeout, 120);
	assert.strictEqual(result.liveAlways, true);
	assert.strictEqual(result.humanReviewNeeded, false);
	assert.strictEqual(result.description, "Auth tests for alice");
	assert.deepStrictEqual(result.categories, ["api", "state"]);
	assert.strictEqual(result.reportPath, "reports/run-42-auth.json");
	assert.deepStrictEqual(result.artifactGlobs, ["videos/alice_*.webm"]);

	console.log("✓ resolves mapped profile with substitution");
}

async function testFallsBackToDefaultProfile() {
	await writeProfile({
		categoryMapping: { scroll: "ux-animation" },
		defaultProfile: "full-flow",
		profiles: {
			"full-flow": {
				cmd: "npm",
				args: ["run", "test:full"],
				liveAlways: true,
				humanReviewNeeded: true,
				description: "Full flow",
				categories: ["full-flow"],
				reportPath: "reports/full-flow.json",
			},
		},
	});

	const result = await callTool("scroll");

	assert.strictEqual(result.profileName, "full-flow");
	assert.strictEqual(result.isFallback, true);
	assert.match(result.fallbackReason ?? "", /unknown_category/);
	assert.strictEqual(result.cmd, "npm");
	assert.deepStrictEqual(result.args, ["run", "test:full"]);
	assert.strictEqual(result.workingDirectory, null);

	console.log("✓ falls back to default profile for unknown mapped category");
}

async function testFallsBackWhenProfileFileMissing() {
	await removeProfile();

	const result = await callTool("auth", { runId: "run-1" });

	assert.strictEqual(result.profileName, "default");
	assert.strictEqual(result.isFallback, true);
	assert.match(result.fallbackReason ?? "", /profile_read_error/);
	assert.strictEqual(result.cmd, "echo");
	assert.strictEqual(result.humanReviewNeeded, true);

	console.log("✓ falls back to built-in default when profile file missing");
}

async function testFallsBackWhenNoProfilesConfigured() {
	await writeProfile({
		categoryMapping: {},
	});

	const result = await callTool("anything");

	assert.strictEqual(result.profileName, "default");
	assert.strictEqual(result.isFallback, true);
	assert.match(result.fallbackReason ?? "", /unknown_profile/);

	console.log("✓ falls back to built-in default when no profiles configured");
}

async function testContextIncludesCategoryAndProjectPath() {
	await writeProfile({
		defaultProfile: "default",
		profiles: {
			default: {
				cmd: "echo",
				args: ["{{category}}", "{{projectPath}}"],
				description: "Default for {{category}}",
				reportPath: "reports/default.json",
			},
		},
	});

	const result = await callTool("infra");

	assert.deepStrictEqual(result.args, ["infra", TEST_TMP]);
	assert.strictEqual(result.description, "Default for infra");

	console.log("✓ context always includes category and projectPath");
}

async function main() {
	await setup();
	try {
		await testResolvesMappedProfile();
		await testFallsBackToDefaultProfile();
		await testFallsBackWhenProfileFileMissing();
		await testFallsBackWhenNoProfilesConfigured();
		await testContextIncludesCategoryAndProjectPath();
		console.log("\nAll tester-profile unit tests passed.");
	} finally {
		await cleanup();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
