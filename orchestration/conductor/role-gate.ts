import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ConductorSettings } from "./types.ts";

const ROLE_GATE_LOG_FILE = "tmp/conductor/role-gate.log";

const subagentSessionRoles = new Map<string, string>();

const DEFAULT_ROLE_ALLOWLISTS: Record<string, string[]> = {
	explore: ["read", "web_search", "web_read", "write"],
	plan: ["read", "web_search", "web_read", "write"],
	coder: ["read", "edit", "write", "bash"],
	tester: ["read", "bash", "get_test_profile"],
	fixer: ["read", "edit", "write", "bash"],
};

function getAllowedTools(role: string, settings: ConductorSettings): string[] | undefined {
	const fromSettings = settings.conductor?.roles?.[role]?.allowedTools;
	if (fromSettings && fromSettings.length > 0) {
		return fromSettings;
	}
	return DEFAULT_ROLE_ALLOWLISTS[role];
}

function normalizeToolName(toolName: string): string {
	// MCP tools may arrive prefixed as `server__toolName`; strip the server prefix.
	return toolName.split("__").pop() ?? toolName;
}

async function logBlock(role: string, toolName: string, reason: string): Promise<void> {
	try {
		await mkdir("tmp/conductor", { recursive: true });
		const ts = new Date().toISOString();
		await appendFile(ROLE_GATE_LOG_FILE, `[${ts}] BLOCKED role=${role} tool=${toolName} reason=${reason}\n`, "utf-8");
	} catch {
		// best-effort logging
	}
}

export function registerSubagentSession(sessionId: string, role: string): void {
	subagentSessionRoles.set(sessionId, role);
}

export function registerRoleGate(pi: ExtensionAPI, settings: ConductorSettings): void {
	pi.on("tool_call", async (event, _ctx: ExtensionContext) => {
		const eventWithMetadata = event as typeof event & {
			metadata?: { sessionId?: string };
			sessionId?: string;
		};
		const sessionId = eventWithMetadata.metadata?.sessionId ?? eventWithMetadata.sessionId;
		if (!sessionId) {
			return undefined;
		}

		const role = subagentSessionRoles.get(sessionId);
		if (!role) {
			// Not a Conductor-managed subagent session: stay transparent.
			return undefined;
		}

		const normalizedTool = normalizeToolName(event.toolName);
		const allowedTools = getAllowedTools(role, settings);

		if (!allowedTools) {
			const reason = `Role '${role}' has no configured allowlist`;
			await logBlock(role, normalizedTool, reason);
			return { block: true, reason };
		}

		if (!allowedTools.includes(normalizedTool)) {
			const reason = `Role '${role}' is not allowed to use '${normalizedTool}'`;
			await logBlock(role, normalizedTool, reason);
			return { block: true, reason };
		}

		return undefined;
	});
}
