import type { RalphDecision, RalphState, VerifyResult, RalphPhase } from "./types.ts";

export interface PlanResult {
  decision: RalphDecision;
  reason: string;
}

export function decideAfterVerify(state: RalphState, result: VerifyResult): PlanResult {
  if (result.testsPassed && result.acceptanceMet && (result.visualTestsPassed || result.visualTestsRun === false)) {
    return { decision: "done", reason: "Tests pass, acceptance criteria met, and visual output is valid or not required." };
  }

  if (state.iteration >= state.maxIterations) {
    return { decision: "abort", reason: `Max iterations (${state.maxIterations}) reached.` };
  }

  if (result.humanReviewNeeded || result.severity === "high") {
    return { decision: "human", reason: result.summary || "Video tester flagged issues requiring human review." };
  }

  if (result.structuralChange) {
    return { decision: "human", reason: "Structural or risky change needed." };
  }

  if (result.liveTestFailed || (result.visualTestsRun === true && !result.visualTestsPassed)) {
    return { decision: "human", reason: "Live/visual test failed; human review required." };
  }

  if (result.unclearCause) {
    return { decision: "diagnose", reason: "Failure cause unclear; run diagnostics." };
  }

  // Motion/behavioral issues → retry TDD with specific guidance
  if (
    result.category === "mouse" ||
    result.category === "scroll" ||
    (result.recommendations && result.recommendations.length > 0)
  ) {
    return {
      decision: "retry",
      reason: `Video tester found ${result.category} issues: ${result.recommendations?.join("; ") || result.summary}`,
    };
  }

  if (result.testsPassed && !result.acceptanceMet) {
    return { decision: "plan", reason: "Tests pass but acceptance criteria not fully met; revisit plan." };
  }

  if (!result.testsPassed && result.failures.length > 0) {
    return { decision: "retry", reason: "Tests fail with known failures; retry TDD." };
  }

  return { decision: "human", reason: "Unexpected verification state; human review required." };
}

export function nextPhase(decision: RalphDecision): RalphPhase {
  switch (decision) {
    case "done":
      return "done";
    case "abort":
      return "aborted";
    case "human":
      return "human";
    case "retry":
      return "tdd";
    case "diagnose":
      return "plan"; // diagnostics feed back into plan
    case "plan":
      return "plan";
    case "explore":
      return "explore";
    case "tdd":
      return "tdd";
  }
}

export function shouldPauseAfterDecision(decision: RalphDecision): boolean {
  return decision === "human" || decision === "done" || decision === "abort";
}
