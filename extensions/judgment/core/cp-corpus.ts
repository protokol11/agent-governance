// core/cp-corpus.ts — the CP corpus the gate reviews diffs against.
//
// Source of truth: principles-render emits rendered/cp-corpus.json from the
// to-violations catalog (render.mjs owns YAML parsing; DRY). This module only
// validates a JSON string into typed entries — no fs, no pi import.
import type { Question } from "./types.ts";

export const CP_SEVERITIES = ["must", "should"] as const;
export type CpSeverity = (typeof CP_SEVERITIES)[number];

export interface CpEntry {
  id: string;
  severity: CpSeverity;
  statement: string;
}

export interface CpCorpus {
  generated_from?: string;
  cps: CpEntry[];
}

/** Parse and validate a corpus JSON string. Throws naming the offending entry. */
export function parseCorpus(json: string): CpCorpus {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`cp-corpus: invalid JSON (${(e as Error).message})`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("cp-corpus: top level must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.cps)) throw new Error("cp-corpus: missing cps array");
  const cps: CpEntry[] = obj.cps.map((entry, i) => {
    const where = `cps[${i}]`;
    if (!entry || typeof entry !== "object") throw new Error(`cp-corpus: ${where} not an object`);
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || !e.id) throw new Error(`cp-corpus: ${where} missing id`);
    if (!CP_SEVERITIES.includes(e.severity as CpSeverity)) {
      throw new Error(`cp-corpus: ${e.id} bad severity ${String(e.severity)}`);
    }
    if (typeof e.statement !== "string" || !e.statement.trim()) {
      throw new Error(`cp-corpus: ${e.id} missing statement`);
    }
    return { id: e.id, severity: e.severity as CpSeverity, statement: e.statement };
  });
  const seen = new Set<string>();
  for (const cp of cps) {
    if (seen.has(cp.id)) throw new Error(`cp-corpus: duplicate id ${cp.id}`);
    seen.add(cp.id);
  }
  return {
    generated_from: typeof obj.generated_from === "string" ? obj.generated_from : undefined,
    cps,
  };
}

export function mustCps(corpus: CpCorpus): CpEntry[] {
  return corpus.cps.filter((c) => c.severity === "must");
}

export function shouldCps(corpus: CpCorpus): CpEntry[] {
  return corpus.cps.filter((c) => c.severity === "should");
}

/** Kept import-side: Question is the wire shape buildQuestions emits. */
export type { Question };
