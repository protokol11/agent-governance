import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RalphState, RalphPhase, RalphIteration, VerifyResult } from "./types.ts";
import { decideAfterVerify, nextPhase } from "./planner.ts";
import { notifyRalph } from "./notify.ts";
import { saveRalphState, saveRalphIteration, formatRalphStatus } from "./state.ts";
import { runSubagentStep } from "../commands.ts";
import { notifyStatus } from "../dashboard.ts";
import { analyzeSession, findVideoSessions } from "../../video-backed-live-tester/index.ts";
import type { DiscoveredSession } from "../../video-backed-live-tester/session-discovery.ts";
import type { VideoTesterReport } from "../../video-backed-live-tester/types.ts";
import { logDebug } from "../runner.ts";

const execAsync = promisify(exec);

const RALPH_ARTIFACT_ROOT = "tmp/conductor/ralph";
const VISUAL_TEST_TIMEOUT_MS = 120_000;

export async function runRalphPhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  initialState: RalphState,
): Promise<RalphState> {
  let state = initialState;

  if (state.status === "paused") {
    state.status = "running";
    await saveRalphState(ctx.cwd, pi, state);
  }

  while (true) {
    const phase = state.phase;

    if (phase === "done" || phase === "aborted" || phase === "human") {
      return state;
    }

    notifyRalph(ctx, { state, event: "iteration" });
    const nextState = await runSinglePhase(pi, ctx, state);
    state = nextState;

    if (shouldPauseAfterPhase(state)) {
      return state;
    }
  }
}

async function runSinglePhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: RalphState,
): Promise<RalphState> {
  switch (state.phase) {
    case "define":
      return await runDefinePhase(pi, ctx, state);
    case "explore":
      return await runSubagentPhase(pi, ctx, state, "explore", buildExploreTask, "AUDIT.md");
    case "plan":
      return await runSubagentPhase(pi, ctx, state, "plan", buildPlanTask, "plan.md");
    case "tdd":
      return await runSubagentPhase(pi, ctx, state, "coder", buildCoderTask, "code.md");
    case "verify":
      return await runSubagentPhase(pi, ctx, state, "tester", buildTesterTask, "report.json");
    case "decide":
      return await runDecidePhase(pi, ctx, state);
    case "human":
    case "done":
    case "aborted":
      return state;
  }
}

function shouldPauseAfterPhase(state: RalphState): boolean {
  if (state.status === "done" || state.status === "aborted" || state.phase === "human") {
    return true;
  }
  if (state.phase === "decide") {
    // Pause at decide unless auto-approve is on and no pause was requested.
    return !(state.autoApprove && !state.pauseRequested);
  }
  // All other phases (define, explore, plan, tdd, verify) run automatically.
  return false;
}

async function runDefinePhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: RalphState,
): Promise<RalphState> {
  const criteria = deriveAcceptanceCriteria(state.goal);
  state.acceptanceCriteria = criteria;

  await logIteration(ctx, state, "define", { criteria }, { next: "plan" });

  state.phase = "plan";
  state.status = "running";
  await saveRalphState(ctx.cwd, pi, state);
  notifyRalph(ctx, { state, event: "iteration" });
  notifyStatus(
    ctx,
    `Ralph: define complete. Criteria: ${criteria.join("; ")}. Continuing to plan...`,
    "info",
  );
  return state;
}

async function runSubagentPhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: RalphState,
  role: "explore" | "plan" | "coder" | "tester",
  buildTask: (state: RalphState, outputPath: string) => string,
  outputFile: string,
): Promise<RalphState> {
  const theme = goalSlug(state.goal);
  const artifactDir = join(ctx.cwd, RALPH_ARTIFACT_ROOT, theme);
  const outputPath = join(artifactDir, outputFile);
  await mkdir(artifactDir, { recursive: true });

  const task = buildTask(state, outputPath);
  state.activeSubagentSession = `sub-${role.slice(0, 3)}: ${theme}`;
  await saveRalphState(ctx.cwd, pi, state);

  const result = await runSubagentStep(pi, ctx, role, theme, task, outputPath);

  if (result.status === "completed") {
    state.artifacts.push(outputPath);
    if (role === "tester") {
      await crossCheckVisualTest(ctx.cwd, artifactDir, theme);
      await runVideoTester(ctx, state, artifactDir, theme);
    }
    await logIteration(
      ctx,
      state,
      role as RalphPhase,
      { task },
      { outputPath },
      null,
      result.subagentRunId ?? null,
    );
    state.activeSubagentSession = null;
    state.phase = nextPhaseAfterSubagent(role);
    state.status = "running";
    await saveRalphState(ctx.cwd, pi, state);
    notifyStatus(ctx, `Ralph: ${role} done, continuing to ${state.phase}...`, "info");
  } else {
    state.activeSubagentSession = null;
    await logIteration(
      ctx,
      state,
      role as RalphPhase,
      { task },
      {},
      result.error ?? null,
      result.subagentRunId ?? null,
    );
    state.phase = "decide";
    state.status = "running";
    await saveRalphState(ctx.cwd, pi, state);
    notifyStatus(ctx, `Ralph: ${role} failed: ${result.error ?? "unknown"}`, "error");
  }

  return state;
}

async function runDecidePhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: RalphState,
): Promise<RalphState> {
  const verifyResult = await readVerifyResult(ctx.cwd, state);
  const plan = decideAfterVerify(state, verifyResult);
  state.lastDecision = plan.decision;

  await logIteration(
    ctx,
    state,
    "decide",
    { verifyResult },
    { decision: plan.decision, reason: plan.reason },
  );

  if (plan.decision === "done") {
    state.status = "done";
    state.phase = "done";
    notifyRalph(ctx, { state, event: "done" });
  } else if (plan.decision === "abort") {
    state.status = "aborted";
    state.phase = "aborted";
    notifyRalph(ctx, { state, event: "abort", reason: plan.reason });
  } else if (plan.decision === "human") {
    state.status = "paused";
    state.phase = "human";
    state.pauseRequested = false;
    notifyRalph(ctx, { state, event: "human", decision: plan.decision, reason: plan.reason });
  } else {
    state.phase = nextPhase(plan.decision);
    state.status = "running";
    state.iteration += 1;
    state.pauseRequested = false;
  }

  await saveRalphState(ctx.cwd, pi, state);
  updateRalphDashboard(ctx, state);

  if (state.phase === "decide" || state.phase === "human") {
    notifyStatus(
      ctx,
      `Ralph: decision ${plan.decision} — ${plan.reason}. Run /ralph continue to proceed.`,
      "info",
    );
  }

  return state;
}

export async function readVerifyResult(cwd: string, state: RalphState): Promise<VerifyResult> {
  const theme = goalSlug(state.goal);
  const reportPath = join(cwd, RALPH_ARTIFACT_ROOT, theme, "report.json");
  try {
    const raw = await readFile(reportPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const data = parsed as Record<string, unknown>;
      const visualTestsRun = data.visualTestsRun === true;
      const visualTestsPassed = data.visualTestsPassed === true && visualTestsRun;
      const liveTestFailed = (visualTestsRun && !visualTestsPassed) || data.liveTestFailed === true;
      return {
        testsPassed: data.testsPassed === true,
        acceptanceMet: data.acceptanceMet === true,
        visualTestsPassed,
        visualTestsRun,
        failures: Array.isArray(data.failures) ? (data.failures as string[]) : [],
        flags: Array.isArray(data.flags) ? (data.flags as string[]) : [],
        summary: typeof data.summary === "string" ? data.summary : "",
        liveTestFailed,
        unclearCause: data.unclearCause === true,
        structuralChange: data.structuralChange === true,
        humanReviewNeeded: data.humanReviewNeeded === true,
        severity: normalizeSeverity(data.severity),
        category: typeof data.category === "string" ? data.category : undefined,
        next_agent: normalizeNextAgent(data.next_agent),
        recommendations: Array.isArray(data.recommendations) ? (data.recommendations as string[]) : undefined,
        evidence_links: Array.isArray(data.evidence_links) ? (data.evidence_links as string[]) : undefined,
        behavioralMetrics: data.behavioralMetrics as Record<string, number | Record<string, number>> | undefined,
        videoReports: Array.isArray(data.videoReports) ? (data.videoReports as Array<Record<string, unknown>>) : undefined,
      };
    }
  } catch {
    // missing or malformed report
  }
  return {
    testsPassed: false,
    acceptanceMet: false,
    visualTestsPassed: false,
    failures: ["No verify report found or malformed report.json"],
    flags: [],
    summary: "No verify report found.",
    unclearCause: true,
  };
}

function normalizeSeverity(value: unknown): VerifyResult["severity"] {
  if (value === "low" || value === "medium" || value === "high" || value === "none") return value;
  return undefined;
}

function normalizeNextAgent(value: unknown): VerifyResult["next_agent"] {
  if (
    value === "coder" ||
    value === "tester" ||
    value === "diagnose" ||
    value === "human" ||
    value === "none"
  ) {
    return value;
  }
  return undefined;
}

async function runVideoTester(
  ctx: ExtensionCommandContext,
  state: RalphState,
  artifactDir: string,
  theme: string,
): Promise<void> {
  const videoDir = join(ctx.cwd, "videos", theme);
  let sessions: DiscoveredSession[] = [];
  try {
    sessions = await findVideoSessions(ctx.cwd, theme);
  } catch (error) {
    void logDebug(`runVideoTester: discovery failed: ${String(error)}`);
    return;
  }

  if (sessions.length === 0) {
    void logDebug(`runVideoTester: no video sessions found in ${videoDir}`);
    return;
  }

  const videoReports: VideoTesterReport[] = [];
  for (const session of sessions) {
    try {
      const report = await analyzeSession(session, ctx.cwd);
      videoReports.push(report);
    } catch (error) {
      void logDebug(`runVideoTester: analysis failed for ${session.videoPath}: ${String(error)}`);
    }
  }

  if (videoReports.length === 0) return;

  const reportPath = join(artifactDir, "report.json");
  let report: Record<string, unknown> = {};
  try {
    const raw = await readFile(reportPath, "utf-8");
    report = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // report missing or malformed; start fresh
  }

  // Merge video reports into the main verify report.
  report.videoReports = videoReports as unknown as Record<string, unknown>[];
  const anyFailed = videoReports.some((r) => !r.visualTestsPassed);
  const anyHumanReview = videoReports.some((r) => r.humanReviewNeeded);
  const topSeverity = videoReports.some((r) => r.severity === "high")
    ? "high"
    : videoReports.some((r) => r.severity === "medium")
      ? "medium"
      : videoReports.some((r) => r.severity === "low")
        ? "low"
        : "none";

  if (anyFailed) {
    report.visualTestsPassed = false;
    report.testsPassed = false;
    report.acceptanceMet = false;
    report.liveTestFailed = true;
  }

  if (anyHumanReview) {
    report.humanReviewNeeded = true;
  }

  report.severity = topSeverity;
  report.summary = `Video tester analyzed ${videoReports.length} session(s). ${videoReports.filter((r) => !r.visualTestsPassed).length} flagged.`;

  const failures = Array.isArray(report.failures) ? (report.failures as string[]) : [];
  for (const r of videoReports) {
    for (const f of r.flags) {
      const msg = `[${r.account}] ${f.category} (${f.severity}): ${f.note}`;
      if (!failures.includes(msg)) failures.push(msg);
    }
  }
  report.failures = failures;

  try {
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");
  } catch (error) {
    void logDebug(`runVideoTester: failed to write report: ${String(error)}`);
  }
}

async function crossCheckVisualTest(cwd: string, artifactDir: string, theme: string): Promise<void> {
  const reportPath = join(artifactDir, "report.json");
  let report: Record<string, unknown> = {};
  try {
    const raw = await readFile(reportPath, "utf-8");
    report = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // report missing or malformed; we will create a minimal one
  }

  const visualResult = await runVisualTest(cwd);
  report.visualTestsPassed = visualResult.passed;
  if (!visualResult.passed) {
    report.testsPassed = false;
    report.acceptanceMet = false;
    report.liveTestFailed = true;
    const failures = Array.isArray(report.failures) ? (report.failures as string[]) : [];
    const errorMsg = visualResult.error
      ? `Visual test failed (cross-check): ${visualResult.error}`
      : "Visual test failed (cross-check): npm run test:visual exited non-zero.";
    if (!failures.includes(errorMsg)) {
      failures.push(errorMsg);
    }
    report.failures = failures;
  }

  try {
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");
  } catch (error) {
    void logDebug(`crossCheckVisualTest: failed to write report: ${String(error)}`);
  }
}

async function runVisualTest(cwd: string): Promise<{ passed: boolean; error?: string }> {
  try {
    await execAsync("npm run test:visual", { cwd, timeout: VISUAL_TEST_TIMEOUT_MS });
    return { passed: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { passed: false, error: message };
  }
}

function nextPhaseAfterSubagent(role: "explore" | "plan" | "coder" | "tester"): RalphPhase {
  switch (role) {
    case "explore":
      return "plan";
    case "plan":
      return "tdd";
    case "coder":
      return "verify";
    case "tester":
      return "decide";
  }
}

export function buildExploreTask(state: RalphState, outputPath: string): string {
  return `Explore the target project for: ${state.goal}. Autonomy level: ${state.autonomyLevel}. Follow your skill map to invoke skills such as reference-first when the codebase is unfamiliar. Produce an AUDIT.md with stack, file map, and hotspots to ${outputPath}. Be concise and evidence-based.`;
}

export function buildPlanTask(state: RalphState, outputPath: string): string {
  return `Given the goal and any prior AUDIT.md, produce a focused plan.md for: ${state.goal}. Autonomy level: ${state.autonomyLevel}. Follow your skill map to invoke skills such as generate-alternatives for design choices and reference-first for reconnaissance. Acceptance criteria: ${state.acceptanceCriteria.join("; ")}. Write the plan to ${outputPath}. Keep scope tight and testable.`;
}

export function buildCoderTask(state: RalphState, outputPath: string): string {
  return `Implement the goal: ${state.goal}. Autonomy level: ${state.autonomyLevel}. Follow your skill map to invoke skills such as tdd for red-green-refactor and verification-gate for factual claims. Write tests where appropriate. Write a summary of changes and verification steps to ${outputPath}. Do not widen scope.`;
}

export function buildTesterTask(state: RalphState, outputPath: string): string {
  const projectPath = state.targetProjectPath;
  if (!projectPath) {
    throw new Error(
      "Ralph tester step requires a target project path. Restart with: /ralph run [--auto] --project <target-project-path> <goal>",
    );
  }

  const category = "full-flow";

  return `Run tests for: ${state.goal}.

Inputs:
- category: ${category}
- projectPath: ${projectPath}
- runId: ${state.runId}
- reportPath: ${outputPath}

Workflow:
1. Call get_test_profile with:
   { "projectPath": "${projectPath}", "category": "${category}", "context": { "runId": "${state.runId}", "projectPath": "${projectPath}", "category": "${category}" } }
2. Inspect the profile. If isFallback is true, record fallbackReason and escalate to human if the default profile is unsafe.
3. Run the returned command with bash in workingDirectory (or projectPath if null). Respect timeout. Capture exit code, stdout, stderr.
4. Collect artifacts matching artifactGlobs.
5. Produce a strict report.json with { testsPassed, acceptanceMet, visualTestsPassed, visualTestsRun, failures[], flags[], summary, humanReviewNeeded, category, profileName, isFallback, fallbackReason, command, exitCode, artifacts[], residualRisks[], recommendations[], next_agent } to exactly ${outputPath}.

Rules:
- Do not invoke the video-backed live tester extension directly.
- Set visualTestsRun: true only if the command actually verified visuals; otherwise set visualTestsRun: false.
- Set visualTestsPassed: true only if the command verified visuals and they passed. If visualTestsRun is false, visualTestsPassed must be false.
- Never infer a passing visual test from other passing tests.
- Treat every claim as a hypothesis until verified by tool output.`;
}

function deriveAcceptanceCriteria(goal: string): string[] {
  const criteria: string[] = [];
  const lower = goal.toLowerCase();
  if (lower.includes("test")) criteria.push("Tests pass.");
  if (lower.includes("render") || lower.includes("display")) criteria.push("UI/output is visible.");
  if (lower.includes("port") || lower.includes("migrate")) criteria.push("Core behavior preserved.");
  if (criteria.length === 0) criteria.push("Goal is implemented as specified.");
  return criteria;
}

function goalSlug(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9\-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

async function logIteration(
  ctx: ExtensionCommandContext,
  state: RalphState,
  phase: RalphPhase,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  error: string | null = null,
  subagentSession: string | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  const iteration: RalphIteration = {
    runId: state.runId,
    iteration: state.iteration,
    phase,
    input,
    output,
    artifacts: state.artifacts.slice(),
    subagentSession,
    error,
    startedAt: now,
    finishedAt: now,
  };
  state.iterations.push(iteration);
  await saveRalphIteration(ctx.cwd, iteration);
}

export function updateRalphDashboard(ctx: ExtensionCommandContext, state: RalphState | null): void {
  if (!ctx.hasUI) return;
  const text = state ? formatRalphStatus(state) : "idle | no active loop";
  ctx.ui.setStatus("ralph", text);
}

export function isRalphTerminal(state: RalphState): boolean {
  return state.status === "done" || state.status === "aborted";
}

export function shouldPauseForHuman(state: RalphState): boolean {
  return state.phase === "human";
}
