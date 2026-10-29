// core/seed.ts — the resume seed injected into the rotated child session.
// Pure: no pi imports, no I/O.
//
// The seed MUST carry an explicit implementation trigger when the handoff asks
// for implementation. `judgment`'s scope-lock rule-judge scans the branch's user
// messages for TRIGGERS ("implement", "сделай", …); a fresh session's branch
// holds only this seed, so an untriggered seed makes the semantic judge the
// authority and scope-lock denies even a user-confirmed scope. See
// judgment/core/scope.ts (detectTrigger / TRIGGERS).

/** Extract `next_session_mode` from a handoff's YAML frontmatter text, if present. */
export function readNextSessionMode(frontmatterText: string): string | undefined {
  const match = /^next_session_mode:\s*"?([a-zA-Z]+)"?/m.exec(frontmatterText);
  return match ? match[1].toLowerCase() : undefined;
}

/** Extract `sessionId` from a handoff's YAML frontmatter text, if present. */
export function readHandoffSessionId(frontmatterText: string): string | undefined {
  const match = /^sessionId:\s*"?([^"\n]+?)"?\s*$/m.exec(frontmatterText);
  return match ? match[1].trim() : undefined;
}

/**
 * Build the seed for the rotated session. Implementation handoffs (the default)
 * yield a seed containing the literal "implement" so the scope-lock rule judge
 * authorizes mutations; review/drill seeds stay read-only by construction.
 */
export function buildSeed(handoffPath: string, nextSessionMode?: string): string {
  const mode = (nextSessionMode ?? "implement").trim().toLowerCase();
  if (mode === "review") {
    return `Resume from handoff: ${handoffPath}. Read it and review the work against the Next concrete steps it describes.`;
  }
  if (mode === "drill") {
    return `Resume from handoff: ${handoffPath}. Read it and drill the Next concrete steps it describes.`;
  }
  return `Resume from handoff: ${handoffPath}. Read it and implement the Next concrete steps it describes.`;
}
