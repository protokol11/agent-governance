// session-transfer core — the on-demand observer (key 2). Pure: prompt building
// and verdict parsing. The model call is injected by index.ts, so this is testable.

export interface ObserverVerdict {
  candidate: boolean;
  reason: string;
  focus: string;
}

export const OBSERVER_SYSTEM =
  "You decide whether an AI coding session is at a GOOD point to hand off to a fresh session. " +
  "A GOOD point: a coherent chunk of work just finished, state is written to files, and little would " +
  "be lost by continuing in a new session seeded from a handoff. " +
  "A BAD point: mid-edit, an unfinished mechanical loop, an open question awaiting the user, or work " +
  "that clearly continues in the next few steps. " +
  'Respond with ONLY a JSON object: {"candidate": boolean, "reason": string, "focus": string}. ' +
  "`focus` is a short phrase naming what the next session should continue.";

export function buildObserverUser(recentTranscript: string): string {
  return `Recent session transcript (oldest → newest):\n\n${recentTranscript}\n\nIs now a good transfer point? JSON only.`;
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fence ? fence[1].trim() : trimmed;
}

/** Parse a model response into a verdict, tolerating code fences and surrounding prose. */
export function parseVerdict(raw: string): ObserverVerdict | null {
  if (!raw) return null;
  let text = stripFences(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) text = text.slice(start, end + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.candidate !== "boolean") return null;
  return {
    candidate: o.candidate,
    reason: typeof o.reason === "string" ? o.reason : "",
    focus: typeof o.focus === "string" ? o.focus : "",
  };
}
