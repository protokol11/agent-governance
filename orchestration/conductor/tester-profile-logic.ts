import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProfileConfig {
	categoryMapping?: Record<string, string>;
	defaultProfile?: string;
	profiles?: Record<string, TestProfile>;
}

export interface TestProfile {
	cmd: string;
	args?: string[];
	env?: Record<string, string>;
	workingDirectory?: string;
	timeout?: number;
	liveAlways?: boolean;
	humanReviewNeeded?: boolean;
	description?: string;
	categories?: string[];
	reportPath?: string;
	artifactGlobs?: string[];
}

export interface ResolvedProfile {
	profileName: string;
	cmd: string;
	args: string[];
	env: Record<string, string>;
	workingDirectory: string | null;
	timeout: number;
	liveAlways: boolean;
	humanReviewNeeded: boolean;
	description: string;
	categories: string[];
	reportPath: string;
	artifactGlobs: string[];
	isFallback: boolean;
	fallbackReason: string | null;
}

export const DEFAULT_PROFILE: TestProfile = {
	cmd: "echo",
	args: ["No test profile configured for category {{category}}"],
	env: {},
	timeout: 300,
	liveAlways: false,
	humanReviewNeeded: true,
	description: "Fallback profile used when no profile file or matching profile is found.",
	categories: [],
	reportPath: "tmp/tester-report.json",
	artifactGlobs: [],
};

export const profileParamsSchema = {
	type: "object",
	properties: {
		projectPath: {
			type: "string",
			description: "Absolute path to the target project root.",
		},
		category: {
			type: "string",
			description: "Coarse test category (e.g., auth, scroll, full-flow).",
		},
		context: {
			type: "object",
			additionalProperties: { type: "string" },
			description: "Optional key/value map for template substitution (runId, account, etc.).",
		},
	},
	required: ["projectPath", "category"],
} as const;

export interface ResolveTestProfileParams {
	projectPath: string;
	category: string;
	context?: Record<string, string>;
}

export function resolveTestProfile(params: ResolveTestProfileParams): ResolvedProfile {
	const { projectPath, category, context = {} } = params;
	const ctx = { ...context, category, projectPath };

	let config: ProfileConfig;
	try {
		const raw = readFileSync(join(projectPath, ".pi/profiles/tester.json"), "utf-8");
		config = JSON.parse(raw) as ProfileConfig;
	} catch (error) {
		const fallback = resolveDefaultProfile(ctx);
		fallback.fallbackReason = `profile_read_error: ${error instanceof Error ? error.message : String(error)}`;
		return fallback;
	}

	const mapping = config.categoryMapping ?? {};
	const requestedName = mapping[category] ?? category;
	const profiles = config.profiles ?? {};
	const defaultName = config.defaultProfile ?? "default";

	let profile = profiles[requestedName];
	let profileName = requestedName;
	let isFallback = false;

	if (!profile) {
		profile = profiles[defaultName];
		if (profile) {
			profileName = defaultName;
			isFallback = true;
		}
	}

	if (!profile) {
		const fallback = resolveDefaultProfile(ctx);
		fallback.fallbackReason = `unknown_profile: ${requestedName}`;
		return fallback;
	}

	const fallbackReason = isFallback ? `unknown_category: ${category} → ${requestedName}` : null;

	return resolveProfile(profileName, profile, isFallback, fallbackReason, ctx);
}

function resolveProfile(
	profileName: string,
	profile: TestProfile,
	isFallback: boolean,
	fallbackReason: string | null,
	context: Record<string, string>,
): ResolvedProfile {
	return {
		profileName,
		cmd: substitute(profile.cmd, context),
		args: (profile.args ?? []).map((arg) => substitute(arg, context)),
		env: Object.fromEntries(
			Object.entries(profile.env ?? {}).map(([key, value]) => [key, substitute(value, context)]),
		),
		workingDirectory: profile.workingDirectory ? substitute(profile.workingDirectory, context) : null,
		timeout: profile.timeout ?? 300,
		liveAlways: profile.liveAlways ?? false,
		humanReviewNeeded: profile.humanReviewNeeded ?? false,
		description: substitute(profile.description ?? "", context),
		categories: profile.categories ?? [],
		reportPath: substitute(profile.reportPath ?? "tmp/tester-report.json", context),
		artifactGlobs: (profile.artifactGlobs ?? []).map((g) => substitute(g, context)),
		isFallback,
		fallbackReason,
	};
}

function resolveDefaultProfile(context: Record<string, string>): ResolvedProfile {
	return resolveProfile("default", DEFAULT_PROFILE, true, "missing_profile_file", context);
}

function substitute(value: string, context: Record<string, string>): string {
	return value.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (_, key) => context[key] ?? `{{${key}}}`);
}
