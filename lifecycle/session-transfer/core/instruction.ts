// core/instruction.ts — the transfer instruction channel (ADR-0036).
//
// The transfer instruction is NOT user-role prose. It rides the system prompt
// as a `before_agent_start` guideline, while the turn is started by a neutral,
// language-free marker so the model never mirrors an English "user" request
// (the live bug that switched the whole session to English).
//
// Consume-once by construction: `buildGuidelines` always returns an empty
// pending slot, so a stale instruction can never leak into a later real prompt.
import { guidelineFor, type Band, type ContextUsageLike } from "./gate.ts";

/** Neutral, language-free token that starts the transfer turn. */
export const TRANSFER_MARKER = "[session-transfer]";

/**
 * Guidelines to append for one `before_agent_start`: the band wrap-up (when
 * hot) first, then the pending transfer instruction (when armed). The returned
 * `pending` is always `null` — the instruction is consumed exactly once.
 */
export function buildGuidelines(
  band: Band,
  usage: ContextUsageLike | undefined,
  pending: string | null,
): { guidelines: string[]; pending: null } {
  const guidelines: string[] = [];
  const wrapUp = guidelineFor(band, usage);
  if (wrapUp !== null) guidelines.push(wrapUp);
  if (pending !== null) guidelines.push(pending);
  return { guidelines, pending: null };
}

/**
 * ADR-0037: `/transfer` packages the session without moving it. This instruction
 * runs the three existing steps and stops — no rotation, no FSM entry.
 */
export function packagingPrompt(sessionId: string): string {
  return [
    "TRANSFER PACKAGING requested. Do exactly this, then stop:",
    `1. Run the \`hands-off\` skill to write a handoff under \`.docs/handoff/\`; its frontmatter MUST contain \`sessionId: ${sessionId}\` and \`next_session_mode\`.`,
    "2. Run the \`update-docs\` skill to write the session status and update \`.docs/CURRENT_STATUS.md\`.",
    "3. Run the \`name_session\` tool with a verb-led slug for this session's topic.",
    "Do not rotate or create a new session. Do not start new work.",
  ].join("\n");
}
