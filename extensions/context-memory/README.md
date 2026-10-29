# context-memory

Pi extension that carries session context across turns as auditable segments instead of prompt rewrites.

A coding session loses its working memory the moment it ends: agreements, active tasks, and the reasons behind a reminder vanish with the transcript. This extension treats session context as a transferable artifact. Each turn is reduced to one append-only decision line, and each reminder injection is a small custom entry on the session branch — both replayable, both reconstructible by a fresh session. A companion extension, `session-transfer`, can then lift those segments into a document or a live branch in the next session; this one owns only the production side.

This is an early-stage prototype; the spec lives outside this repository at `.docs/SPECS/harness-core/context-memory-prototype.md`.

## Install

Prerequisites: Node.js with TypeScript stripping (`--experimental-strip-types`), the pi coding agent runtime.

Copy the extension directory into the agent's extension folder:

```bash
cp -r extensions/context-memory ~/.pi/agent/extensions/context-memory
```

Expected result: `~/.pi/agent/extensions/context-memory/index.ts` and `detector.ts` are present, and the pi runtime loads the extension on the next session start.

## Usage

The extension fires a context reminder only when all three hold (`detector.ts::decide`):

1. The todo board (`.pi/todo/state.json`) has a task with `status: "in_progress"`.
2. A tool target of the last tool call intersects a constraint `subjectPath` on a path-segment boundary, in either direction (`src/api` owns `src/api/v1/x.ts`; touching `src` reaches `src/api`; `src/apiary` does not).
3. That constraint has not fired in the last 20 turns (`DEFAULT_COOLDOWN_TURNS`).

Each fire appends one short section to `systemPromptOptions.sections["context-memory"]` — the author's prompt is never replaced, and `forceSystemPrompt` is never called.

Worked check against the pure detector:

```bash
cd extensions/context-memory
node --experimental-strip-types tests/detector.test.ts
```

Result at build: 25 tests, 25 pass, 0 fail.

### Segments written per turn

Every turn, fire or no-fire, writes one line to `.pi/context-memory/decisions.jsonl` with `turn`, `reason`, `constraint_id`, `matched_target`, `active_task_id`, `tool_targets`, `cooldown_turns`, `reminder_tokens`, and `constraints_considered` — so a replay can audit the silence instead of guessing at it. On a fire, a second segment is appended to the session branch with custom type `context-memory-fire`, carrying `constraintId`, `turn`, `matchedTarget`, and the reminder text. On session start the cooldown is rebuilt from those fire entries, so a reload does not reset the silence.

The silence reasons are machine-named, in fixed order: `no-active-task`, `no-constraints`, `no-tool-target`, `no-path-intersection`, `cooldown`.

### Reminder format

Reminders are phrased as facts about the agreement, not commands, and are trimmed to a hard budget of 80 tokens (`REMINDER_TOKEN_BUDGET`):

```
Agreement: API layer stays untouched
Subject path: src/api
Active task: T-14
```

## Configuration

Constraints come from two sources, deduped by id with the seed file winning:

| Source | Shape |
|---|---|
| `.pi/context-memory/constraints.json` | `{ "constraints": [{ "constraint_id", "subject_path", "text" }] }` |
| Session branch entries | custom type `context-memory-agreement` with the same payload fields |

The file ships empty: no constraint fires before one is seeded. Locked prototype defaults, carried into the next extension unchanged on a pass verdict:

| Key | Default |
|---|---|
| `cooldownTurns` | 20 |
| `reminderTokenBudget` | 80 |
| `pathMatchGranularity` | path-segment prefix, both directions |
| `activeTaskSource` | `.pi/todo/state.json`, status `in_progress` |
| `injection` | `systemPromptOptions.sections["context-memory"]` |

`TODO_STATE_DIR` env var overrides the todo board directory (used by the sibling todo board).

## Troubleshooting

- **Symptom: no reminder fires.** Cause is in the last `decisions.jsonl` line: `reason=no-active-task` (board has no `in_progress` task), `reason=no-path-intersection` (tool target missed the constraint path — check path keys and shell commands), or `constraints_considered` empty (agreement never seeded).
- **Symptom: reminder repeats too often or not enough.** Cooldown is per constraint id; a second fire inside 20 turns is blocked by design. Turn counting uses user prompts, not model steps — a long single-turn session gets no second reminder.
- **Symptom: a shell command hides its target.** `cd src/api && touch x` defeats the token scan; `rm src/api/x.ts` is caught.

## Contributing

Prototype stage; the author verdict on the replay criteria (fire in both drift scenarios, zero fires in the 20-turn control window, reminder ≤ 80 tokens) is pending and reserved for human judgment. Run the tests before any detector change:

```bash
node --experimental-strip-types tests/detector.test.ts
```

File issues in the host monorepo, `agent-governance`.

## License

[MIT](../../LICENSE)
