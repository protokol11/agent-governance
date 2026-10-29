/**
 * context-memory detector — pure rules, no pi imports, no I/O inside `decide()`.
 *
 * The detector decides one thing: does this turn deserve a context reminder, and for which
 * constraint. It is deliberately dumb (FOG-OF-WAR): every decision carries a machine reason
 * so the trace explains itself without replaying the model's intent.
 *
 * Spec: `.docs/SPECS/harness-core/context-memory-prototype.md`, Implementation Decision 3.
 * Rule: fire when an active todo task exists AND a tool target intersects a constraint's
 * subject path AND that constraint did not fire in the last `cooldownTurns` turns.
 */

/** Turns of silence per constraint after a fire. Prototype default, locks on the author verdict. */
export const DEFAULT_COOLDOWN_TURNS = 20;

/** Hard ceiling for one reminder. Verdict criterion 3; a fire over budget is a bug, not noise. */
export const REMINDER_TOKEN_BUDGET = 80;

/** Session entry type for a manually seeded agreement (prototype seeds them by hand). */
export const AGREEMENT_CUSTOM_TYPE = "context-memory-agreement";

/** Session entry type written on every fire, used to rebuild the cooldown after a reload. */
export const FIRE_CUSTOM_TYPE = "context-memory-fire";

/** One binding constraint. `subjectPath` is repo-relative and owns everything under it. */
export interface Constraint {
  /** Stable id. Doubles as the cooldown key, so it must not change between sessions. */
  id: string;
  /** Repo-relative directory or file. An empty value never intersects anything. */
  subjectPath: string;
  /** The agreement as a fact, not a command: "API layer stays untouched". */
  text: string;
  /** Where the constraint came from, for the trace. */
  source?: string;
}

/** Why the detector stayed silent, or that it fired. One of these is always in the log. */
export type DetectorReason =
  | "fire"
  | "no-active-task"
  | "no-constraints"
  | "no-tool-target"
  | "no-path-intersection"
  | "cooldown";

export interface DetectorInput {
  /** Turn counter for this session, 1-based, incremented once per user prompt. */
  turn: number;
  /** Active task id from the todo board, or null when the board has none. */
  activeTaskId: string | null;
  /** Repo-relative paths touched by the current or last tool call. */
  toolTargets: readonly string[];
  constraints: readonly Constraint[];
  /** Constraint id to the turn it last fired on. Absent means never fired. */
  lastFireTurns?: Readonly<Record<string, number>>;
  /** Overrides `DEFAULT_COOLDOWN_TURNS`. */
  cooldownTurns?: number;
}

export interface DetectorDecision {
  fire: boolean;
  reason: DetectorReason;
  turn: number;
  activeTaskId: string | null;
  toolTargets: string[];
  constraintId: string | null;
  /** The tool target that matched, for the trace. */
  matchedTarget: string | null;
  /** Reminder text, null when the detector did not fire. */
  reminder: string | null;
  /** Token estimate of `reminder`, null when the detector did not fire. */
  reminderTokens: number | null;
  cooldownTurns: number;
  /** One line for `.pi/context-memory/decisions.jsonl`. */
  detail: string;
}

const PATH_SEPARATORS = /\\/g;

/**
 * Repo-relative, forward slashes, no leading `./`, no trailing slash. Case is preserved:
 * two paths that differ only by case stay distinct, because the prototype runs on a
 * case-preserving filesystem and a wrong match costs noise.
 */
export function normalizePath(raw: string): string {
  const slashed = raw.replace(PATH_SEPARATORS, "/").trim();
  const trimmed = slashed.replace(/^(\.\/)+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
  return trimmed === "." ? "" : trimmed;
}

/**
 * Segment-boundary prefix match in both directions: `src/api` owns `src/api/v1/x.ts`,
 * and touching the parent `src` also reaches `src/api`. `src/apiary` shares no segment
 * boundary with `src/api`, so it does not intersect.
 */
export function pathsIntersect(a: string, b: string): boolean {
  const left = normalizePath(a);
  const right = normalizePath(b);
  if (left === "" || right === "") return false;
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** Rough token estimate: word runs and single punctuation marks each count as one token. */
export function estimateTokens(text: string): number {
  const matches = text.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu);
  return matches ? matches.length : 0;
}

function trimToBudget(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;
  const words = text.trim().split(/\s+/);
  while (words.length > 1 && estimateTokens(`${words.join(" ")} …`) > budget) {
    words.pop();
  }
  return `${words.join(" ")} …`;
}

/**
 * Reminder phrasing: a fact about the agreement. No imperative mood, because a command
 * reads as nagging and invites the model to argue with the prompt instead of the work.
 */
export function buildReminder(constraint: Constraint, activeTaskId: string | null): string {
  const lines = [`Agreement: ${constraint.text}`, `Subject path: ${constraint.subjectPath}`];
  if (activeTaskId !== null && activeTaskId !== "") {
    lines.push(`Active task: ${activeTaskId}`);
  }
  return trimToBudget(lines.join("\n"), REMINDER_TOKEN_BUDGET);
}

interface TaskLike {
  id?: unknown;
  task_id?: unknown;
  status?: unknown;
  state?: unknown;
}

function taskIdOf(task: TaskLike): string | null {
  for (const value of [task.id, task.task_id]) {
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function tasksOf(board: unknown): TaskLike[] {
  if (Array.isArray(board)) return board as TaskLike[];
  if (board === null || typeof board !== "object") return [];
  const record = board as Record<string, unknown>;
  for (const value of [record.tasks, (record.board as Record<string, unknown> | undefined)?.tasks]) {
    if (Array.isArray(value)) return value as TaskLike[];
  }
  return [];
}

/**
 * Active task from the todo-state board, tolerantly: the sibling board may be absent,
 * corrupt, or shaped as a cache `{tasks: []}` or a bare array. A board that is not
 * readable reads as "no active task", which keeps the detector silent rather than noisy.
 */
export function readActiveTask(board: unknown): string | null {
  for (const task of tasksOf(board)) {
    const status = task.status ?? task.state;
    if (status !== "in_progress") continue;
    const id = taskIdOf(task);
    if (id !== null) return id;
  }
  return null;
}

interface Candidate {
  constraint: Constraint;
  matchedTarget: string;
  matchedSubjectLength: number;
}

function pickCandidate(
  constraints: readonly Constraint[],
  toolTargets: readonly string[],
): Candidate | null {
  let best: Candidate | null = null;
  for (const constraint of constraints) {
    const subjectLength = normalizePath(constraint.subjectPath).length;
    for (const target of toolTargets) {
      if (!pathsIntersect(target, constraint.subjectPath)) continue;
      const candidate: Candidate = { constraint, matchedTarget: target, matchedSubjectLength: subjectLength };
      if (best === null) {
        best = candidate;
        continue;
      }
      // Most specific subject path wins. Equal specificity falls back to the id, so the
      // same input always yields the same decision.
      if (subjectLength > best.matchedSubjectLength) {
        best = candidate;
      } else if (subjectLength === best.matchedSubjectLength && constraint.id < best.constraint.id) {
        best = candidate;
      }
    }
  }
  return best;
}

/** Cooldown blocks a second reminder for the same constraint, not for other constraints. */
export function cooldownBlocks(
  turn: number,
  lastFireTurn: number | undefined,
  cooldownTurns: number,
): boolean {
  if (lastFireTurn === undefined) return false;
  if (!Number.isFinite(lastFireTurn)) return false;
  return turn - lastFireTurn <= cooldownTurns;
}

/**
 * The whole rule. Fixed order of checks, so the reason in the log names the first failing
 * condition and the trace stays readable across runs.
 */
export function decide(input: DetectorInput): DetectorDecision {
  const cooldownTurns = input.cooldownTurns ?? DEFAULT_COOLDOWN_TURNS;
  const toolTargets = input.toolTargets.map((target) => normalizePath(target)).filter((target) => target !== "");
  const base: DetectorDecision = {
    fire: false,
    reason: "no-active-task",
    turn: input.turn,
    activeTaskId: input.activeTaskId,
    toolTargets,
    constraintId: null,
    matchedTarget: null,
    reminder: null,
    reminderTokens: null,
    cooldownTurns,
    detail: "",
  };

  const silent = (reason: DetectorReason, constraintId: string | null = null): DetectorDecision => {
    const detail =
      constraintId === null
        ? `turn=${input.turn} no-fire reason=${reason}`
        : `turn=${input.turn} no-fire reason=${reason} constraint=${constraintId}`;
    return { ...base, reason, constraintId, detail };
  };

  if (input.activeTaskId === null || input.activeTaskId === "") return silent("no-active-task");
  if (input.constraints.length === 0) return silent("no-constraints");
  if (toolTargets.length === 0) return silent("no-tool-target");

  const candidate = pickCandidate(input.constraints, toolTargets);
  if (candidate === null) return silent("no-path-intersection");

  const { constraint, matchedTarget } = candidate;
  const lastFireTurn = input.lastFireTurns?.[constraint.id];
  if (cooldownBlocks(input.turn, lastFireTurn, cooldownTurns)) {
    return silent("cooldown", constraint.id);
  }

  const reminder = buildReminder(constraint, input.activeTaskId);
  const reminderTokens = estimateTokens(reminder);
  return {
    ...base,
    fire: true,
    reason: "fire",
    constraintId: constraint.id,
    matchedTarget,
    reminder,
    reminderTokens,
    detail:
      `turn=${input.turn} fire constraint=${constraint.id} task=${input.activeTaskId} ` +
      `target=${matchedTarget} tokens=${reminderTokens}`,
  };
}

interface AgreementLike {
  constraint_id?: unknown;
  subject_path?: unknown;
  text?: unknown;
  source?: unknown;
}

/** Manual seed shape for `.pi/context-memory/constraints.json`: `{constraints: [...]}`. */
function constraintFromSeed(raw: unknown, index: number): Constraint | null {
  if (raw === null || typeof raw !== "object") return null;
  const seed = raw as AgreementLike;
  if (typeof seed.text !== "string" || seed.text.trim() === "") return null;
  const id =
    typeof seed.constraint_id === "string" && seed.constraint_id !== ""
      ? seed.constraint_id
      : `c${index + 1}`;
  const subjectPath = typeof seed.subject_path === "string" ? seed.subject_path : "";
  const source = typeof seed.source === "string" ? seed.source : "seed";
  return { id, subjectPath, text: seed.text.trim(), source };
}

/**
 * Constraints from the seed file and from session agreement entries, deduped by id.
 * The seed wins a duplicate id: the author's seeded text outranks a stray session entry.
 */
export function collectConstraints(seed: unknown, agreementData: readonly unknown[]): Constraint[] {
  const byId = new Map<string, Constraint>();
  const seedItems = Array.isArray(seed)
    ? seed
    : ((seed as { constraints?: unknown } | null)?.constraints as unknown[] | undefined) ?? [];
  const addIfAbsent = (constraint: Constraint | null): void => {
    if (constraint === null || byId.has(constraint.id)) return;
    byId.set(constraint.id, constraint);
  };
  seedItems.forEach((raw, index) => addIfAbsent(constraintFromSeed(raw, index)));
  for (const data of agreementData) addIfAbsent(constraintFromSeed(data, byId.size));
  return [...byId.values()];
}

/**
 * Tool targets of one tool call. Path-shaped arguments cover the file tools. For a shell
 * command every path-looking token counts, because `rm src/api/x.ts` is the same drift as
 * `edit src/api/x.ts`.
 */
export function toolTargetsOf(toolName: string, input: unknown): string[] {
  if (input === null || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const targets: string[] = [];
  for (const key of ["path", "file_path", "filePath", "target", "cwd"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") targets.push(value);
  }
  for (const key of ["paths", "files"]) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item !== "") targets.push(item);
    }
  }
  const command = record.command;
  if (toolName === "bash" || toolName === "powershell") {
    const text = typeof command === "string" ? command : "";
    for (const token of text.split(/\s+/)) {
      const cleaned = token.replace(/^["']|["']$/g, "");
      if (cleaned.includes("/") || cleaned.includes("\\")) targets.push(cleaned);
    }
  }
  return [...new Set(targets)];
}

/** Cooldown state rebuilt from the session branch, so a reload does not reset the silence. */
export function readFireTurns(branch: readonly unknown[]): Record<string, number> {
  const fired: Record<string, number> = {};
  for (const entry of branch) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (record.type !== "custom" || record.customType !== FIRE_CUSTOM_TYPE) continue;
    const data = record.data as { constraintId?: unknown; turn?: unknown } | null | undefined;
    if (typeof data?.constraintId !== "string" || typeof data?.turn !== "number") continue;
    const previous = fired[data.constraintId];
    fired[data.constraintId] = previous === undefined ? data.turn : Math.max(previous, data.turn);
  }
  return fired;
}

/** Agreement payloads from the session branch, in branch order. */
export function readAgreements(branch: readonly unknown[]): unknown[] {
  const payloads: unknown[] = [];
  for (const entry of branch) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (record.type !== "custom" || record.customType !== AGREEMENT_CUSTOM_TYPE) continue;
    if (record.data !== undefined) payloads.push(record.data);
  }
  return payloads;
}
