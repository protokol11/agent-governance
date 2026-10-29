// judgment — typed, calibrated decisions for pi agents (slice 1).
// One caller seam: tool `judge(state, questions)`; resolutions via
// `resolve_judgment`; pure calibration view via /calibration.
// Ledger: append-only JSONL under <cwd>/<config-dir>/judgments.jsonl.
// Escalation is a priced third action (see .docs/adr/0033); below minSample
// every decision escalates (cold start).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { appendJudgment, appendRefusal, appendResolution, readJudgments, refusalForEscalation } from "./core/ledger.ts";
import { isCpReviewRequest } from "./core/cp-review.ts";
import { cpClassifyDeps, cpGateHook } from "./core/gate-hook.ts";
import { hashState } from "./core/hash.ts";
import { judge } from "./core/judge.ts";
import { registerJudgmentsCommand } from "./commands.ts";
import {
  SCOPE_COSTS,
  SCOPE_QUESTION,
  buildScopeRecord,
  buildScopeState,
  countScopeResolved,
  detectTrigger,
  extractUserTexts,
  hookCheck,
} from "./core/scope.ts";
import { resolveSessionChain } from "./core/session-chain.ts";
import { decide } from "./core/policy.ts";
import type { JudgmentRecord, Question } from "./core/types.ts";

const JUDGE_TOOL_DESCRIPTION = [
  "Ask the judgment engine a set of TYPED questions (noul = yes/no with probability).",
  "Returns {answers, judgment_ids, errors}. Every answer is recorded to an append-only",
  "ledger with its confidence; resolve outcomes later with resolve_judgment so the",
  "model's calibration can be measured. Questions are linted BEFORE any model call —",
  "a bad question returns errors and costs nothing. Use this instead of freeform",
  "prose gating whenever a decision must be checkable (scope, verify, route).",
].join(" ");

const questionSchema = Type.Object({
  type: Type.Union([Type.Literal("noul"), Type.Literal("choice"), Type.Literal("score")]),
  instructions: Type.String({ description: "What to judge, self-contained" }),
  criteria: Type.Optional(
    Type.Union([Type.Array(Type.String()), Type.Record(Type.String(), Type.String())])
  ),
});

/**
 * The ledger holding this session tree's authorization, plus the ancestor ids
 * that led to it. A root session reads its own project; a child reads the
 * root's, because a subagent inherits the user's approved scope rather than
 * declaring its own (ADR-0047). Both values come from ONE chain resolution, so
 * the ledger a hook reads and the ancestors it checks can never disagree.
 */
function gateLedger(ctx: {
  cwd: string;
  sessionManager: { getHeader(): { parentSession?: string | null } | null | undefined };
}): { ledgerPath: string; ancestors: string[] } {
  const chain = resolveSessionChain(ctx.sessionManager.getHeader()?.parentSession ?? null);
  return {
    ledgerPath: join(chain.rootCwd ?? ctx.cwd, CONFIG_DIR_NAME, "judgments.jsonl"),
    ancestors: chain.ancestors,
  };
}

export default function judgment(pi: ExtensionAPI): void {
  // Scope-lock hook: block mutating tools until a scope judgment is authorized.
  // Deterministic only (DS-SEC-05 rule judge); the model lives in scope_lock.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const env = String(process.env.PI_SCOPE_LOCK ?? "").toLowerCase();
    // A subagent runs in its own session, so its own row cannot exist yet. The
    // orchestrator's row is inherited through the session chain, not through a
    // shared process env: an env flag would also unlock the parent.
    // Authorization lives in the ROOT session's project (ADR-0047): a child runs
    // in its own cwd, so `<cwd>/.pi` would read a foreign, empty ledger and fail
    // closed. The whole ancestor chain matters — a grandchild's direct parent
    // holds no allow row of its own.
    const { ledgerPath, ancestors } = gateLedger(ctx);
    const check = hookCheck(readJudgments(ledgerPath), {
      sessionId: ctx.sessionManager.getSessionId(), // authorization is session-bound (ADR-0045)
      ancestors,
      inherit: env === "inherit", // external CLI agents only: separate process, no session list
      gateEnabled: env !== "off",
    });
    if (check.allow) return;
    return { block: true, reason: check.reason };
  });

  // cp-review gate hook: review the payload before it lands (wave B2).
  // Composes with the scope-lock hook above — scope authorization is not a
  // CP clean bill. Body lives in core/gate-hook.ts (testable without pi).
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    return cpGateHook(event, ctx);
  });

  pi.registerTool({
    name: "scope_lock",
    label: "Scope lock",
    description:
      "Authorize file mutations for this session by declaring your scope. " +
      "Call before the first write/edit. A deterministic trigger check runs first; " +
      "if unclear, the judgment engine asks the model; if still uncertain, the user " + "is asked via a confirmation dialog. Subagents should rely on PI_SCOPE_LOCK=inherit " +
      "set by the orchestrator (access-list inheritance), not call this.",
    parameters: Type.Object({
      declared_scope: Type.String({
        description: "What will be done, what will NOT be touched, and how success is checked",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // Write where the hook reads, or a child's self-authorization would be invisible.
      const { ledgerPath } = gateLedger(ctx);
      const entries = ctx.sessionManager.getBranch();
      const userTexts = extractUserTexts(entries as never);
      const hasTrigger = detectTrigger(userTexts);
      const declaredScope = String(params.declared_scope);
      // Authorization is bound to the work it authorized (ADR-0045), so every
      // row this call writes carries the session it belongs to, plus a bounded
      // excerpt so a pending row stays reviewable without the transcript.
      const sessionId = ctx.sessionManager.getSessionId();
      const stateExcerpt = scopeExcerpt(declaredScope, userTexts);

      // Dual judge (DS-SEC-05): explicit trigger = rule judge decides (p pinned,
      // no model call); otherwise the semantic judge scores the residue.
      let p: number;
      let judgeNote = "";
      const model = ctx.model;
      // The judge appends its own row; capture it instead so this call writes ONE
      // row that carries both the claim (value/confidence) and the gate's
      // decision + session binding. Every branch below appends exactly that row
      // before returning, so nothing is answered without being recorded.
      const judged: JudgmentRecord[] = [];
      // Nothing was judged, so this call writes no row (RTL-09 exception).
      if (!hasTrigger && !model) return textResult("No model available for scope judgment", true);

      const judgmentRes = hasTrigger
        ? null
        : await judge(
            buildScopeState(declaredScope, userTexts),
            { [SCOPE_QUESTION.id]: SCOPE_QUESTION.question as Question },
            { appendJudgment: (r) => judged.push(r) },
            {
              modelId: `${model!.provider}/${model!.id}`,
              callModel: async (system, user) => {
                const message = await ctx.modelRegistry.complete(
                  model!,
                  { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
                  { signal }
                );
                return textOf(message);
              },
            }
          );
      if (judgmentRes) {
        if (judgmentRes.errors.length) {
          // LLM judge broken → degrade to the human, never to silent allow.
          p = 0.5;
          judgeNote = `judge unavailable (${judgmentRes.errors[0]}); asking the user`;
        } else {
          p = judgmentRes.answers[SCOPE_QUESTION.id]?.confidence ?? 0.5;
        }
      } else {
        p = 0.95; // rule judge: explicit trigger is a verifiable signal (SK-10)
      }

      const resolved = countScopeResolved(readJudgments(ledgerPath));
      // Degraded judge (broken/unparseable): skip priced routing — with p=0.5
      // a warm ledger would silently deny; the human stays the only judge.
      const decision = judgeNote
        ? { action: "escalate" as const, value: null, costs: { yes: null, no: null, escalate: null } }
        : decide(p, { ...SCOPE_COSTS, resolvedCount: resolved });

      const source = judged[0];
      // The one row this call writes. `authorized` is the human's answer, or
      // null when nobody was asked — buildScopeRecord turns that into claim
      // truth (outcome) and keeps the gate action in `decision`.
      const appendScopeRow = (
        action: "act" | "escalate" | "allow" | "deny",
        decisionValue: string | null,
        authorized: boolean | null
      ) => {
        const row = buildScopeRecord({
          judgment_id: source?.judgment_id ?? `scope-lock-${Date.now()}`,
          ts: source?.ts ?? new Date().toISOString(),
          state_hash: source?.state_hash ?? hashState(buildScopeState(declaredScope, userTexts)),
          instructions: SCOPE_QUESTION.question.instructions,
          // The claim is "the user authorizes this scope"; the judge's own value
          // and confidence are the claim, not the gate's answer.
          value: source?.value ?? "yes",
          confidence: source?.confidence ?? p,
          model: source?.model ?? (hasTrigger ? "rule:trigger-predicate" : "judge:degraded"),
          // Provenance names the judge that produced the claim, so it must never
          // be inferred from the fallback path. When no semantic judge row exists
          // (degraded judge or rule predicate) the claim is code-made: labeling it
          // "judge" would drop a fabricated ("yes", 0.5) point into the model's
          // calibration curve. A real judge row keeps its own provenance/model.
          provenance: source?.provenance ?? "code",
          decision: { action, value: decisionValue, pricedBy: "scope-lock" },
          authorized,
          sessionId,
          stateExcerpt,
        });
        appendJudgment(ledgerPath, row); // throws on failure — never pass unrecorded
        // Rule-predicate call site (hasTrigger): a priced escalate is a refusal
        // against the trigger predicate, linked to the row just written. The
        // semantic scope-lock branch stays emission-free (slice 1 wiring).
        if (hasTrigger) {
          const refusal = refusalForEscalation(decision, {
            judgment_id: row.judgment_id,
            rule_id: "scope-lock:trigger-predicate",
            witness: declaredScope,
            ts: row.ts,
          });
          if (refusal) appendRefusal(ledgerPath, refusal);
        }
      };

      let authorized: boolean;
      let how: string;
      if (decision.action === "escalate") {
        if (!ctx.hasUI) {
          // Nobody can answer: record the escalated decision with no truth
          // (outcome null) and refuse, so the row stays in the review queue.
          appendScopeRow("escalate", null, null);
          return textResult(
            "Scope lock: cannot authorize without UI. The orchestrator must authorize " +
              "in the parent session and set PI_SCOPE_LOCK=inherit for this agent.",
            true
          );
        }
        // The confirm can throw when the user aborts or the UI cancels. Record
        // the escalated decision first so the captured judge row is never lost
        // (outcome null: nobody answered), then rethrow to the caller.
        try {
          authorized = await ctx.ui.confirm(
            "Scope lock",
            `Authorize this scope?\n\n${declaredScope}\n\n(judgment p=${p.toFixed(2)}, ${resolved} resolved record(s))`
          );
        } catch (error) {
          appendScopeRow("escalate", null, null);
          throw error;
        }
        how = authorized ? "user confirmed" : "user rejected";
        // The human answered: the answer is the gate action AND the truth of
        // the "the user authorizes this" claim, so outcome is written here only.
        appendScopeRow(authorized ? "allow" : "deny", authorized ? "yes" : "no", authorized);
      } else {
        authorized = decision.action === "act" && decision.value === "yes";
        how = decision.reason ?? `act ${decision.value} (p=${p.toFixed(2)})`;
        // Auto decision: no human checked the claim, so outcome stays null.
        appendScopeRow(authorized ? "allow" : "deny", decision.value, null);
      }
      return textResult(
        authorized
          ? `Scope authorized (${how}). Mutations are unlocked for this session.`
          : `Scope NOT authorized (${how}). Mutations remain blocked; clarify scope with the user.`,
        !authorized,
        { authorized, p, resolved, how }
      );
    },
  });

  pi.registerTool({
    name: "judge",
    label: "Judge",
    description: JUDGE_TOOL_DESCRIPTION,
    parameters: Type.Object({
      state: Type.Unknown({ description: "Context the judgment is about (JSON-serializable)" }),
      questions: Type.Record(Type.String(), questionSchema),
      model: Type.Optional(
        Type.String({ description: 'Judge model as "provider/modelId"; default: current session model' })
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const ledgerPath = join(ctx.cwd, CONFIG_DIR_NAME, "judgments.jsonl");
      const registry = ctx.modelRegistry;
      const questions = params.questions as Record<string, Question>;
      const ledger = { appendJudgment: (record: JudgmentRecord) => appendJudgment(ledgerPath, record) };

      // cp-review requests go to the trained cell, never the generative judge.
      // A missing classifier is a routing failure, not a silent fallback.
      if (isCpReviewRequest(questions as Record<string, { type: string }>)) {
        const binding = cpClassifyDeps(registry as never, signal);
        if ("error" in binding) {
          return textResult(binding.error, true);
        }
        const result = await judge(params.state, questions, ledger, binding.deps);
        const classifierSummary = result.errors.length
          ? `errors: ${result.errors.join("; ")}`
          : Object.entries(result.answers)
              .map(([id, a]) => `${id}=${a.value} (confidence=${a.confidence.toFixed(2)})`)
              .join(", ") || "no questions";
        return textResult(
          `judged ${result.judgment_ids.length} question(s). ${classifierSummary}`,
          result.errors.length > 0,
          result
        );
      }

      let model = ctx.model;
      if (params.model) {
        const [provider, ...rest] = String(params.model).split("/");
        model = registry.find(provider, rest.join("/")) ?? undefined;
        if (!model) {
          return textResult(`Unknown model "${params.model}"`, true);
        }
      }
      if (!model) return textResult("No model available for judgment", true);

      const result = await judge(
        params.state,
        params.questions as Record<string, Question>,
        { appendJudgment: (record) => appendJudgment(ledgerPath, record) },
        {
          modelId: `${model.provider}/${model.id}`,
          callModel: async (system, user) => {
            const message = await registry.complete(
              model,
              { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
              { signal }
            );
            return textOf(message);
          },
        }
      );
      const summary = result.errors.length
        ? `errors: ${result.errors.join("; ")}`
        : Object.entries(result.answers)
            .map(([id, a]) => `${id}=${a.value} (confidence=${a.confidence.toFixed(2)})`)
            .join(", ") || "no questions";
      return textResult(`judged ${result.judgment_ids.length} question(s). ${summary}`, false, result);
    },
  });

  pi.registerTool({
    name: "resolve_judgment",
    label: "Resolve judgment",
    description:
      "Record ground truth for a judgment: did the judged claim turn out true (yes) or false (no)? " +
      "Resolutions feed the calibration curve; unresolved judgments never count.",
    parameters: Type.Object({
      judgment_id: Type.String(),
      outcome: Type.Boolean({ description: "true = the judged claim was correct" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const ledgerPath = join(ctx.cwd, CONFIG_DIR_NAME, "judgments.jsonl");
      const ok = appendResolution(ledgerPath, params.judgment_id, params.outcome, new Date().toISOString());
      return textResult(ok ? `resolved ${params.judgment_id} → ${params.outcome}` : "not found", !ok);
    },
  });

  // One seam for all ledger UI: calibration + browse + resolve (PS-02).
  registerJudgmentsCommand(pi);
}

/**
 * What the row was about, kept next to it so a pending decision is reviewable
 * without the transcript: the declared scope plus the last user message. The
 * ledger caps it at 400 chars.
 */
function scopeExcerpt(declaredScope: string, userTexts: string[]): string {
  const tail = userTexts[userTexts.length - 1] ?? "";
  return `${declaredScope}\n\nLast user message:\n${tail}`;
}

function textOf(message: { content?: Array<{ type: string; text?: string }> }): string {
  return (message.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

function textResult(text: string, isError: boolean, details?: unknown) {
  return { content: [{ type: "text" as const, text }], isError, details: details ?? {} };
}
