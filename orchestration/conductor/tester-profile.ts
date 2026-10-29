import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveTestProfile, profileParamsSchema, type ResolvedProfile } from "./tester-profile-logic.ts";

export const getTestProfileTool = defineTool({
	name: "get_test_profile",
	label: "Get Test Profile",
	description:
		"Resolve a test command profile for a target project category from .pi/profiles/tester.json.",
	promptSnippet:
		"Use get_test_profile to look up the correct test command, args, and metadata for a category before running tests.",
	promptGuidelines: [
		"Call get_test_profile with the target project path and category.",
		"Pass runId, account, and any other substitution variables in the context object.",
		"If the returned profile has isFallback: true, record the fallbackReason in the report and consider escalating to human when the default profile is unsafe.",
	],
	parameters: profileParamsSchema as any,
	async execute(_toolCallId, params) {
		const { projectPath, category, context = {} } = params as {
			projectPath: string;
			category: string;
			context?: Record<string, string>;
		};

		const resolved: ResolvedProfile = resolveTestProfile({ projectPath, category, context });
		return {
			content: [{ type: "text", text: JSON.stringify(resolved, null, 2) }],
			details: resolved,
		};
	},
});

export function registerTesterProfileTool(pi: ExtensionAPI): void {
	pi.registerTool(getTestProfileTool);
}
