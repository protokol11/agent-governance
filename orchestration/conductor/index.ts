import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { registerRunCommand } from "./commands.ts";
import { registerRalphCommand } from "./ralph/commands.ts";
import { registerRoleGate } from "./role-gate.ts";
import { restoreActiveRunId, loadRunState, formatStatus } from "./state.ts";
import { restoreActiveRalphRunId, loadRalphState, formatRalphStatus } from "./ralph/state.ts";
import type { ConductorSettings } from "./types.ts";
import { registerTesterProfileTool } from "./tester-profile.ts";
import { checkJunctions, formatJunctionWarning } from "./junction-check.ts";

const REPO_ROOT = join(realpathSync(__dirname), "..", "..", ".."); // resolve junction to real path

function loadSettings(): ConductorSettings {
	try {
		const raw = readFileSync(join(process.cwd(), ".pi/settings.json"), "utf-8");
		return JSON.parse(raw) as ConductorSettings;
	} catch {
		return {};
	}
}

export default function registerConductorExtension(pi: ExtensionAPI) {
	registerRunCommand(pi);
	registerRalphCommand(pi);
	registerRoleGate(pi, loadSettings());
	registerTesterProfileTool(pi);

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		const cmdCtx = ctx as ExtensionCommandContext;

		// Junction sanity check (non-blocking)
		try {
			const results = await checkJunctions(REPO_ROOT);
			const warning = formatJunctionWarning(results);
			if (warning && cmdCtx.hasUI) {
				cmdCtx.ui.notify(warning, "warning");
			}
		} catch {
			// best effort
		}

		if (cmdCtx.hasUI) {
			const conductorRunId = restoreActiveRunId(cmdCtx.sessionManager);
			let conductorText = "idle | no active run";
			if (conductorRunId) {
				const state = await loadRunState(cmdCtx.cwd, conductorRunId);
				if (state) {
					conductorText = formatStatus(state);
				}
			}
			cmdCtx.ui.setStatus("conductor", conductorText);

			const ralphRunId = restoreActiveRalphRunId(cmdCtx.sessionManager);
			let ralphText = "idle | no active loop";
			if (ralphRunId) {
				const ralphState = await loadRalphState(cmdCtx.cwd, ralphRunId);
				if (ralphState) {
					ralphText = formatRalphStatus(ralphState);
				}
			}
			cmdCtx.ui.setStatus("ralph", ralphText);
		}
	});
}
