# context-memory — prototype notes

Spec: `.docs/SPECS/harness-core/context-memory-prototype.md`.
Prototype question (verbatim): "does the rule detector fire at the right moments with acceptable silence in between?"

Status: built and unit-tested. Author verdict: PENDING.

## Verdict criteria declared before the build (RSI-08)

Source: spec, Implementation Decisions 4, quoted verbatim.

> the mechanic passes if, in the author's replay of two scripted drift scenarios, the reminder fires in both, fires zero times in the 20-turn control window, and the reminder text is ≤80 tokens.

Split into three checks, each with its own pass/fail cell.

| # | Criterion (verbatim fragment) | Result |
|---|---|---|
| 1 | "the reminder fires in both" | PENDING |
| 2 | "fires zero times in the 20-turn control window" | PENDING |
| 3 | "the reminder text is ≤80 tokens" | PENDING |

Verdict line (human, verbatim, left empty until the author rules):

```
Verdict: PENDING
```

The agent does not fill this in (HUMAN-JUDGMENT-FINAL).

## What is built

1. `detector.ts` — pure rule function `decide()`. No pi imports and no I/O.
2. `index.ts` — `before_agent_start` hook. Adds one section under `systemPromptOptions.sections`.
3. `tests/detector.test.ts` — 25 table-driven cases.
4. `.pi/context-memory/decisions.jsonl` — one line per turn, fire or no-fire, with a reason.

Rule: fire when all three hold.

1. The todo board has an `in_progress` task.
2. A tool target of the last tool call intersects a constraint `subjectPath` on a path segment boundary.
3. That constraint did not fire in the last 20 turns.

## Locked parameters (prototype defaults)

```json
{
  "cooldownTurns": 20,
  "reminderTokenBudget": 80,
  "pathMatchGranularity": "path-segment prefix, both directions",
  "activeTaskSource": ".pi/todo/state.json, status in_progress",
  "constraintSources": ["AGENTS.md", "CONTEXT.md", ".docs/PLAN.md", "context-memory-agreement entries", ".pi/context-memory/constraints.json seed"],
  "injection": "systemPromptOptions.sections['context-memory']",
  "forceSystemPrompt": false
}
```

The first three values carry into `context-memory-extension` on a pass. They change only after the verdict (RSI-08: no post-hoc criteria).

## Competing hypotheses for a missed fire (FOG-OF-WAR)

Listed before any parameter change. A missed fire in the replay is one of these, and the log names which.

1. **Detector gap.** The tool target missed the constraint path: wrong path key, shell command without a path token, or a relative path that normalizes differently. Trace column: `tool_targets` plus `reason=no-path-intersection`.
2. **Constraint not recorded.** No constraint matched because the author's agreement never entered the seed file or the session branch. Trace column: `constraints_considered` empty or missing the id.
3. **Board gap.** No `in_progress` task, so the detector stayed silent by design. Trace column: `reason=no-active-task`.

The decisions log separates the three without a rerun.

## Replay procedure

1. Seed the agreement in `.pi/context-memory/constraints.json` (`{constraints: [{constraint_id, subject_path, text}]}`) or as a `context-memory-agreement` session entry. The file ships empty, so no constraint fires before the author seeds one.
2. Mark a task `in_progress` on the todo board.
3. Run drift scenario 1: touch a file under the constraint `subjectPath`. Expect one fire.
4. Run drift scenario 2: touch the parent directory of the constraint `subjectPath`. Expect one fire.
5. Run the control window: 20 turns of work outside the constraint path. Expect zero fires.
6. Read `.pi/context-memory/decisions.jsonl` and fill the table above.

## Verification run

```bash
cd extensions/context-memory
node --experimental-strip-types tests/detector.test.ts
```

Result at build: 25 tests, 25 pass, 0 fail.

Wiring smoke run (temp cwd, fake pi runtime): turn 1 fired, reminder 18 tokens, second turn silenced by `reason=cooldown`, handler returned `undefined`, so the author prompt stayed untouched. `grep -rn forceSystemPrompt extensions/context-memory` hits this file and the guard comment in `index.ts`, never a call.

## Residual risks

1. Turn counting uses user prompts, not model steps. A long single-turn session gets no second reminder.
2. A shell command hides paths the detector cannot see: `cd src/api && touch x`. The token scan catches the first form only.
3. The token estimate counts words and punctuation marks, not provider tokens. The two units differ by a few per cent on short prose.
4. The detector reads the board on every turn: one file read per prompt.
