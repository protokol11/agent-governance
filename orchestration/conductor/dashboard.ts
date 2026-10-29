import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ChainRunState } from "./types.ts";
import { formatStatus } from "./state.ts";

export function updateDashboard(ctx: ExtensionCommandContext, state: ChainRunState | null): void {
	if (!ctx.hasUI) return;
	const text = state ? formatStatus(state) : "idle | no active run";
	ctx.ui.setStatus("conductor", text);
}

export function notifyStatus(
	ctx: ExtensionCommandContext,
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, level);
}
