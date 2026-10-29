import type { RalphState, TddMode } from "./types.ts";

export function pickTddMode(state: RalphState): TddMode {
  const criteria = state.acceptanceCriteria.length;
  const iteration = state.iteration;
  const hasPriorFailure = state.iterations.some(
    (it) => it.phase === "verify" && it.output?.testsPassed === false,
  );

  if (criteria >= 3 && iteration === 1 && !hasPriorFailure) {
    return {
      mode: "strict",
      reason: "Clear acceptance criteria and no prior failure: strict Red-Green-Refactor.",
    };
  }

  if (criteria >= 1 || iteration > 1) {
    return {
      mode: "medium",
      reason: "Some criteria known or not first iteration: write test alongside code.",
    };
  }

  return {
    mode: "low",
    reason: "Unclear task: explore before committing to a test.",
  };
}

export function shouldExploreBeforeTdd(mode: TddMode): boolean {
  return mode.mode === "low";
}
