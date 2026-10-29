import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RalphState, RalphDecision } from "./types.ts";

type NotifyLevel = "info" | "warning" | "error";

export interface NotifyOptions {
  state: RalphState;
  event: "started" | "iteration" | "human" | "done" | "abort" | "stuck";
  decision?: RalphDecision;
  reason?: string;
}

export function formatRalphNotification(options: NotifyOptions): { message: string; level: NotifyLevel } {
  const { state, event, decision, reason } = options;
  const slug = state.runId;

  switch (event) {
    case "started":
      return {
        message: `Ralph started: ${state.goal} (${slug})`,
        level: "info",
      };
    case "iteration":
      return {
        message: `Ralph iter ${state.iteration} (${state.phase}): ${state.goal}`,
        level: "info",
      };
    case "human":
      return {
        message: `Ralph paused for human: ${state.goal}. Reason: ${reason ?? decision ?? "unknown"}`,
        level: "warning",
      };
    case "done":
      return {
        message: `Ralph done: ${state.goal}`,
        level: "info",
      };
    case "abort":
      return {
        message: `Ralph aborted: ${state.goal}. Reason: ${reason ?? decision ?? "max iterations or error"}`,
        level: "error",
      };
    case "stuck":
      return {
        message: `Ralph stuck: ${state.goal} (${state.phase}). Check ralph/${slug}/state.json`,
        level: "warning",
      };
  }
}

export function notifyRalph(
  ctx: ExtensionCommandContext | null,
  options: NotifyOptions,
): void {
  const { message, level } = formatRalphNotification(options);

  if (ctx?.hasUI) {
    ctx.ui.notify(message, level);
  } else {
    console.log(`[ralph:${level}] ${message}`);
  }

  // Telegram extension integration stub: emit event when Telegram extension is present.
  // ctx?.events?.emit("telegram:ralph", { message, level });
}
