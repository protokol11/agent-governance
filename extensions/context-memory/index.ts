/**
 * context-memory prototype extension.
 *
 * Appends one short reminder section to `systemPromptOptions.sections` when the rule
 * detector fires. The author's prompt is never replaced: no `systemPrompt` return, no
 * `forceSystemPrompt`, no `customPrompt` mutation (author constraint n18-d4).
 *
 * Every turn writes one decision line to `.pi/context-memory/decisions.jsonl`, fire or not,
 * so the replay can audit the silence instead of guessing at it (RTL-09).
 *
 * Spec: `.docs/SPECS/harness-core/context-memory-prototype.md`.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  FIRE_CUSTOM_TYPE,
  collectConstraints,
  decide,
  readActiveTask,
  readAgreements,
  readFireTurns,
  toolTargetsOf,
  type Constraint,
  type DetectorDecision,
} from "./detector.ts";

const SECTION_NAME = "context-memory";
const SIDECAR_DIR = ".pi/context-memory";
const DECISIONS_FILE = "decisions.jsonl";
const SEED_FILE = "constraints.json";
const TODO_STATE_DIR = ".pi/todo";
const TODO_STATE_FILE = "state.json";

/** Repo-relative paths under `root`, overridable by env for the sibling todo board. */
function todoStatePath(root: string): string {
  const dir = process.env.TODO_STATE_DIR;
  return dir === undefined || dir === ""
    ? join(root, TODO_STATE_DIR, TODO_STATE_FILE)
    : resolve(root, dir, TODO_STATE_FILE);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Absent or corrupt reads as "nothing to see": the prototype must not break a session
    // over a missing sibling board.
    return null;
  }
}

function appendDecision(path: string, line: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
}

interface DecisionLine extends Record<string, unknown> {
  ts: string;
  session_id: string;
  turn: number;
  decision: "fire" | "no-fire";
  reason: string;
  constraint_id: string | null;
  matched_target: string | null;
  active_task_id: string | null;
  tool_targets: string[];
  cooldown_turns: number;
  reminder_tokens: number | null;
  reminder: string | null;
  constraints_considered: string[];
}

function toLine(decision: DetectorDecision, sessionId: string, constraints: Constraint[]): DecisionLine {
  return {
    ts: new Date().toISOString(),
    session_id: sessionId,
    turn: decision.turn,
    decision: decision.fire ? "fire" : "no-fire",
    reason: decision.reason,
    constraint_id: decision.constraintId,
    matched_target: decision.matchedTarget,
    active_task_id: decision.activeTaskId,
    tool_targets: decision.toolTargets,
    cooldown_turns: decision.cooldownTurns,
    reminder_tokens: decision.reminderTokens,
    reminder: decision.reminder,
    constraints_considered: constraints.map((constraint) => constraint.id),
  };
}

export default function contextMemory(pi: ExtensionAPI): void {
  let turn = 0;
  let toolTargets: string[] = [];
  const lastFireTurns: Record<string, number> = {};
  let root = process.cwd();
  let sessionId = "unknown";
  let warned = false;

  function warn(ctx: ExtensionContext, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (!warned && ctx.hasUI) {
      warned = true;
      ctx.ui.notify(`context-memory: ${message}`, "warning");
    }
  }

  function decisionsPath(): string {
    return join(root, SIDECAR_DIR, DECISIONS_FILE);
  }

  function loadConstraints(branch: readonly unknown[]): Constraint[] {
    const seed = readJson(join(root, SIDECAR_DIR, SEED_FILE));
    return collectConstraints(seed, readAgreements(branch));
  }

  pi.on("session_start", (_event, ctx) => {
    root = ctx.cwd;
    sessionId = ctx.sessionManager.getSessionId();
    const branch = ctx.sessionManager.getBranch();
    // Rebuild the cooldown from the branch, so a reload does not turn silence into noise.
    Object.assign(lastFireTurns, readFireTurns(branch));
    let maxTurn = 0;
    for (const value of Object.values(lastFireTurns)) maxTurn = Math.max(maxTurn, value);
    turn = maxTurn;
    toolTargets = [];
  });

  pi.on("tool_call", (event) => {
    // The detector reacts to the tool call that just happened. The hook runs before the
    // next agent start, so the last target of the previous turn is the live signal.
    const input = (event as { input?: unknown }).input;
    toolTargets = toolTargetsOf(event.toolName, input);
  });

  pi.on("before_agent_start", (event, ctx) => {
    turn += 1;
    try {
      const branch = ctx.sessionManager.getBranch();
      const constraints = loadConstraints(branch);
      const activeTaskId = readActiveTask(readJson(todoStatePath(root)));
      const decision = decide({ turn, activeTaskId, toolTargets, constraints, lastFireTurns });

      appendDecision(decisionsPath(), toLine(decision, sessionId, constraints));

      if (!decision.fire || decision.reminder === null) return;

      lastFireTurns[decision.constraintId as string] = turn;
      // Section mutation only: the author keeps the prompt, the transcript keeps the delta.
      event.systemPromptOptions.sections[SECTION_NAME] = decision.reminder;
      pi.appendEntry(FIRE_CUSTOM_TYPE, {
        constraintId: decision.constraintId,
        turn,
        matchedTarget: decision.matchedTarget,
        reminder: decision.reminder,
      });
    } catch (error) {
      warn(ctx, error);
    }
  });
}
