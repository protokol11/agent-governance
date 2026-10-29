// core/gate-hook.ts — the cp-review gate's impure edge, minus pi imports.
//
// index.ts binds this to the tool_call event with the real registry; tests
// bind stubs. Structural types only — no @earendil-works/pi-coding-agent
// value import, so node --test can load this module standalone.
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { judge } from "./judge.ts";
import { appendJudgment, appendRefusal, refusalForEscalation } from "./ledger.ts";
import { toClassifierQuestions } from "./cp-review.ts";
import { parseCorpus, shouldCps } from "./cp-corpus.ts";
import { buildQuestions, planGateDecision, runLints, verdictsFromAnswers } from "./cp-gate.ts";
import type { CpCorpus } from "./cp-corpus.ts";

export const DEFAULT_CORPUS_PATH = join(
  homedir(),
  ".agents",
  "skills",
  "principles-render",
  "rendered",
  "cp-corpus.json"
);
/** The cell's trained context. Larger payloads skip review — loudly, not silently. */
export const PAYLOAD_CAP = 4000;
const LEDGER_DIR = ".pi";
const LEDGER_FILE = "judgments.jsonl";

/** The slice of the extension context the gate touches. */
export interface CpGateCtx {
  cwd: string;
  hasUI: boolean;
  signal: AbortSignal | undefined;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    confirm(title: string, message: string): Promise<boolean>;
  };
  modelRegistry: {
    findOfType(
      type: "classifier",
      provider: string,
      id: string
    ): { provider: string; id: string } | undefined;
    classify(
      model: { provider: string; id: string },
      context: { state: unknown; questions: Record<string, unknown> },
      options: { signal?: AbortSignal }
    ): Promise<{
      stopReason: string;
      errorMessage?: string;
      provider: string;
      model: string;
      answers: Record<string, { type: string; probability?: number }>;
    }>;
  };
}

export interface CpGateEvent {
  toolName: string;
  input: unknown;
}

// Corpus cache keyed by resolved path: one read per process per corpus, and
// tests can point CP_CORPUS_PATH at fixtures without cross-contamination.
const corpusCache = new Map<string, { corpus: CpCorpus | null; error: string | null }>();
export function loadCorpus(): { corpus: CpCorpus | null; error: string | null } {
  const path = process.env.CP_CORPUS_PATH ?? DEFAULT_CORPUS_PATH;
  const cached = corpusCache.get(path);
  if (cached) return cached;
  let entry: { corpus: CpCorpus | null; error: string | null };
  try {
    entry = { corpus: parseCorpus(readFileSync(path, "utf-8")), error: null };
  } catch (e) {
    // Own-infra failure degrades open with a notice; never a silent clean.
    entry = { corpus: null, error: (e as Error).message };
  }
  corpusCache.set(path, entry);
  return entry;
}

export function ledgerPath(cwd: string): string {
  return join(cwd, LEDGER_DIR, LEDGER_FILE);
}

const CLASSIFIER_REF = { type: "classifier" as const, provider: "rlcd-local", id: "cell-coder-1.5b" };

/** Resolve the cell and build judge() classifier deps. One binding, two callers
 * (the judge tool's cp-review route and the gate hook) — DRY re-check. */
export function cpClassifyDeps(
  registry: CpGateCtx["modelRegistry"],
  signal: AbortSignal | undefined
): { modelId: string; deps: Parameters<typeof judge>[3] } | { error: string } {
  const classifier = registry.findOfType("classifier", CLASSIFIER_REF.provider, CLASSIFIER_REF.id);
  if (!classifier) {
    return { error: "cp-review classifier unavailable (start the RLCD sidecar or request human review)" };
  }
  const modelId = `${CLASSIFIER_REF.provider}/${CLASSIFIER_REF.id}`;
  return {
    modelId,
    deps: {
      modelId,
      classifierModelId: modelId,
      callModel: async () => {
        throw new Error("classifier route must not call the generative model");
      },
      classify: async (s: unknown, qs: Record<string, import("./types.ts").Question>) => {
        const response = await registry.classify(
          classifier,
          { state: s, questions: toClassifierQuestions(qs) },
          { signal }
        );
        return {
          stopReason: response.stopReason,
          errorMessage: response.errorMessage,
          model: `${response.provider}/${response.model}`,
          answers: response.answers,
        };
      },
    },
  };
}

/**
 * The write/edit gate (spec cp-review-gate-hook). Returns undefined to allow,
 * or {block, reason} to stop the tool. Composes with the scope-lock hook —
 * scope authorization is not a CP clean bill.
 */
export async function cpGateHook(
  event: CpGateEvent,
  ctx: CpGateCtx
): Promise<{ block?: boolean; reason?: string } | undefined> {
  if (event.toolName !== "write" && event.toolName !== "edit") return;
  // Default OFF (2026-10-12, post-live-smoke): per-edit cell latency is ~2 min,
  // unworkable as a default until the batch endpoint ships (spec decision).
  // The gate is opt-in tooling: CP_REVIEW_GATE=on arms it for a session.
  const gateEnabled = ["on", "1", "true"].includes(String(process.env.CP_REVIEW_GATE ?? "").toLowerCase());
  // The payload under review: what the tool will put on disk.
  const input = (event.input ?? {}) as { content?: string; edits?: Array<{ newText?: string }> };
  const content =
    event.toolName === "write"
      ? String(input.content ?? "")
      : (input.edits ?? []).map((e) => e.newText ?? "").join("\n");

  const { corpus, error: corpusErr } = loadCorpus();
  const lintHits = runLints(content);
  let classifyError: string | null = null;
  let verdicts: ReturnType<typeof verdictsFromAnswers>["verdicts"] = [];
  // judgment id per question key, aligned like judge()'s judgment_ids, so an
  // override refusal links the classifier row it overrides (ledger invariant:
  // every refusal references an existing judgment_id — a dangling link once
  // bricked every readLedger caller, blocking all writes; see status 2026-10-12).
  let judgmentIds = new Map<string, string>();
  // Classify only when the gate can act on the answer — oversized and
  // infra-down payloads degrade open WITHOUT burning a classification.
  const willClassify = gateEnabled && content.length <= PAYLOAD_CAP && !corpusErr && corpus && lintHits.length === 0;
  if (willClassify) {
    const binding = cpClassifyDeps(ctx.modelRegistry, ctx.signal);
    if ("error" in binding) {
      classifyError = binding.error;
    } else {
      const { questions, state } = buildQuestions(content, shouldCps(corpus));
      const result = await judge(state, questions, { appendJudgment: (r) => appendJudgment(ledgerPath(ctx.cwd), r) }, binding.deps);
      if (result.errors.length) classifyError = result.errors.join("; ");
      else {
        verdicts = verdictsFromAnswers(result.answers).verdicts;
        judgmentIds = new Map(Object.keys(questions).map((k, i) => [k, result.judgment_ids[i]]));
      }
    }
  }

  const decision = planGateDecision({
    gateEnabled,
    contentLength: content.length,
    cap: PAYLOAD_CAP,
    infraError: corpusErr,
    lintHits,
    classifyError,
    verdicts,
    hasUI: ctx.hasUI,
  });
  if (decision.action === "allow") return;
  if (decision.action === "notice") {
    // Own-infra/oversized stand-down is told, not enforced (PS-FIXER-03).
    ctx.ui.notify(decision.reason, "warning");
    return;
  }
  if (decision.action === "block") {
    return { block: true, reason: decision.reason };
  }
  // confirm: classifier-failure escalation or verdict override. The human is
  // the only judge here (HUMAN-JUDGMENT-FINAL); an override is a priced
  // refusal against the gate predicate — fuel for rule-lifecycle.
  if (!ctx.hasUI) {
    return { block: true, reason: `${decision.reason} (no UI: request human review)` };
  }
  const approved = await ctx.ui.confirm("cp-review gate", decision.reason);
  if (!approved) return { block: true, reason: "cp-review gate: user rejected the override" };
  // The refusal must link a real judgment row. Verdict override: the row of the
  // top violated CP. Classifier-failure escalation: no classification exists,
  // so record the confirm fact itself as a rule judgment (scope-lock pattern).
  let refusalJudgmentId = "";
  if (decision.violated?.length) {
    const top = decision.violated[0];
    refusalJudgmentId = judgmentIds.get(`cp-review:${top.cp_id}`) ?? "";
  }
  if (!refusalJudgmentId) {
    refusalJudgmentId = `cp-gate-${Date.now()}`;
    appendJudgment(ledgerPath(ctx.cwd), {
      judgment_id: refusalJudgmentId,
      ts: new Date().toISOString(),
      state_hash: "cp-review-gate:escalation",
      question_id: "cp-review-gate:escalation",
      type: "noul",
      instructions: "cp-review gate escalated (classifier failure or no verdict row); user approved the write.",
      criteria: null,
      value: "yes",
      confidence: 1,
      model: "rule:cp-gate-confirm",
      provenance: "code",
      outcome: true,
    });
  }
  const refusal = refusalForEscalation(
    { action: "escalate", value: null, costs: { yes: null, no: null, escalate: null } },
    {
      judgment_id: refusalJudgmentId,
      rule_id: "cp-review-gate:operating-point",
      witness: content.slice(0, 200),
      ts: new Date().toISOString(),
    }
  );
  if (refusal) appendRefusal(ledgerPath(ctx.cwd), refusal);
  return;
}
