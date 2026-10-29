// core/session-chain.ts — find the session tree a gate decision belongs to.
// A subagent gets its own session and often its own cwd, so `<cwd>/.pi` is the
// wrong ledger for authorization: the user's allow row lives in the root
// session's project. Walk `parentSession` to the top and take its cwd.
import { closeSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { sessionIdFromParent } from "./scope.ts";

/** The header fields the chain needs. `cwd` is the project the session ran in. */
export interface SessionHeader {
  id?: string;
  cwd?: string;
  parentSession?: string | null;
}

export interface SessionChain {
  /** Project cwd of the topmost readable session, or null when the chain is unreadable. */
  rootCwd: string | null;
  /** Session ids from the direct parent upwards, nearest first. */
  ancestors: string[];
}

/** A session file this deep means a runaway chain, not a real tree. */
export const MAX_CHAIN_DEPTH = 8;
/** The header is line 1; a transcript can be gigabytes, so read a bounded slice. */
const HEAD_BYTES = 64 * 1024;

/**
 * `parentSession` is either a session file path or a bare id. Only an absolute
 * `.jsonl` path names a readable session: a bare id would resolve against
 * process.cwd() and read whatever happens to sit there, and a non-JSONL path is
 * not a session file at all.
 */
export function isSessionPath(path: string): boolean {
  return isAbsolute(path) && path.endsWith(".jsonl");
}

/**
 * Read the session header (first JSONL line). Any failure returns null: a chain
 * that cannot be read must fail closed rather than guess an authorization.
 */
export function readSessionHeader(path: string): SessionHeader | null {
  // Refuse an unvalidated argument BEFORE the open, so it never reaches the fs.
  if (!isSessionPath(path)) return null;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    if (n <= 0) return null;
    const text = buf.subarray(0, n).toString("utf8");
    const nl = text.indexOf("\n");
    const first = (nl >= 0 ? text.slice(0, nl) : text).trim();
    if (!first) return null;
    const parsed = JSON.parse(first) as SessionHeader & { type?: string };
    if (parsed.type !== "session") return null;
    return parsed;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The read already failed or succeeded; a close error changes nothing.
      }
    }
  }
}

/**
 * Walk `parentSession` upwards and return the root project cwd plus every
 * ancestor id. Stops at a cycle, an unreadable header, or the depth cap, and
 * keeps whatever it already learned: a shallow chain still authorizes.
 */
export function resolveSessionChain(
  parentSession: string | null | undefined,
  readHeader: (path: string) => SessionHeader | null = readSessionHeader
): SessionChain {
  const ancestors: string[] = [];
  const seen = new Set<string>();
  let rootCwd: string | null = null;
  let next: string | null | undefined = parentSession;
  for (let depth = 0; next && depth < MAX_CHAIN_DEPTH; depth++) {
    const id = sessionIdFromParent(next);
    if (!id || seen.has(id)) break;
    seen.add(id);
    ancestors.push(id);
    // Same guard as readSessionHeader, applied before the reader is invoked: a
    // bare id or non-JSONL path must not cost a read attempt at all.
    const header = isSessionPath(next) ? readHeader(next) : null;
    if (!header) break;
    // Only an absolute cwd names a project. A relative one (or a hostile header)
    // would resolve against OUR cwd and point the gate at a foreign ledger.
    if (typeof header.cwd === "string" && isAbsolute(header.cwd)) rootCwd = header.cwd;
    next = header.parentSession ?? null;
  }
  return { rootCwd, ancestors };
}
