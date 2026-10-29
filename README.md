# agent-governance

pi extensions built from a scientific-principle catalog — verification over prompting.

## Why

Agents drift. A prompt is a wish; it does not constrain what an agent does next.
This monorepo holds runtime gates instead of prompts, each one derived from a principle
catalog (`to-violations/PRINCIPLES.md`): a pipeline is a sequence of lowering stages
(RTL-01), every phase transition is a gate (RTL-04), trusted tools compute while the LLM
only orchestrates (RTL-08), and every step leaves a trace (RTL-09).

The recurring patterns:

- **Double judges** — calibration and verification run as separate, independent
  primitives, never as one self-reporting step.
- **Append-only ledgers** — JSONL files that record every decision, fire or not, so the
  silence can be audited instead of guessed at.
- **Escalation to a human as a priced third action** — asking the operator costs
  something and is recorded in the ledger; below a minimum sample size every decision
  escalates (cold start), and calibration learns the reliability curve from what
  resolves without a human.

Scope: governance primitives for the pi coding agent. Non-scope: the agent itself, model
providers, and the principle catalog (it lives outside git and is linked below).

## How it works

Mental model: each extension binds a named agent failure mode to a typed gate. The gate
either passes, fails, or abstains (RTL-04); it never edits the agent's intent, it only
measures and constrains. Where a decision must be made, the judgment primitive prices the
uncertainty instead of guessing.

```
agent intent ──▶ typed gate (measure / judge / escalate) ──▶ pass │ fail │ abstain
                     │                                            │
                     └──▶ append-only ledger (RTL-09) ◀───────────┘
```

### Problem → tool

| Cluster | Extension | Problem it gates |
|---|---|---|
| `extensions/` | `judgment` | Typed, calibrated decisions: `judge(state, questions)` tool, append-only judgments ledger, escalation priced as a third action |
| `extensions/` | `memory-gov` | Merged memory surface: `memory` writes candidate lines, `memory_recall` reads trusted entries, grooming asks the judgment primitive |
| `extensions/` | `rule-lifecycle` | Rule changes are versioned and pass a gate instead of drifting silently |
| `extensions/` | `parity-meter` | Measures a session (tool-schema snapshots, protocol errors, usage per turn); the meter never changes arguments, never stops a call |
| `extensions/` | `todo-state` | Thin TS layer over the verified Python todo core; one fold, one source of truth, drift caution against `.docs/PLAN.md` |
| `extensions/` | `ask` | Structured human input: one `ask` tool opening a TUI questionnaire, answers come back as text, malformed arguments rejected before any UI opens |
| `extensions/` | `session-search-lite` | One `session_search` tool over the local SQLite index of past sessions, ranked by BM25 |
| `extensions/` | `context-memory` | Rule detector appends one reminder section; every turn logs a decision line so non-fires stay auditable |
| `lifecycle/` | `session-transfer` | Replaces lossy compaction with a handoff + in-place rotation (`/transfer`, `/transfer-resume`) |
| `lifecycle/` | `session-manager` | Agent names its own session via `name_session` (verb-led kebab-slug) |
| `orchestration/` | `conductor` | Run/ralph commands, role gates, tester profile, run-state restore |
| `orchestration/` | `orchestration-graph` | Parent-facing ops and diagnostics for the dispatch graph; nothing model-facing |
| `extras/` | `paste` | F4 saves a clipboard screenshot and swaps placeholders for real attachments on send |
| `extras/` | `setup-upgrade` | Dry-run reconciler: classifies repo files against the principles-render stamp (`ok` / `missing` / `user-modified`) |
| `extras/` | `cost` | Session-cost view (signs, rates, age) over pi session files — `/yuan`, `/yen`, `/usd` |
| root | `rlcd-local` | Registers a local Python RLCD sidecar classifier (`cell-coder-1.5b`) for System One requests |
| `npm/` | `pi-judgment` | npm-packaged judgment extension: judge tool, ledger, reliability curve, scope-lock gate with dual-judge review |

### Standalone repos and npm packages (wave 1)

Wave-1 extensions are additionally published as individual repos and npm packages; the sources of truth stay in this monorepo.

| Extension | Standalone repo | npm package |
|---|---|---|
| `judgment` | — (monorepo only, for now) | [`@protokol11/pi-judgment`](https://www.npmjs.com/package/@protokol11/pi-judgment) |
| `session-transfer` | [protokol11/pi-session-transfer](https://github.com/protokol11/pi-session-transfer) | [`@protokol11/pi-session-transfer`](https://www.npmjs.com/package/@protokol11/pi-session-transfer) |
| `session-manager` | [protokol11/pi-session-manager](https://github.com/protokol11/pi-session-manager) | [`@protokol11/pi-session-manager`](https://www.npmjs.com/package/@protokol11/pi-session-manager) |
| `memory-gov` | [protokol11/pi-memory-gov](https://github.com/protokol11/pi-memory-gov) | [`@protokol11/pi-memory-gov`](https://www.npmjs.com/package/@protokol11/pi-memory-gov) |
| `todo-state` | [protokol11/pi-todo-state](https://github.com/protokol11/pi-todo-state) | [`@protokol11/pi-todo-state`](https://www.npmjs.com/package/@protokol11/pi-todo-state) |

Wave 2:

| Extension | Standalone repo | npm package |
|---|---|---|
| `cost` (renamed from `yuan`) | [protokol11/pi-cost](https://github.com/protokol11/pi-cost) | [`@protokol11/pi-cost`](https://www.npmjs.com/package/@protokol11/pi-cost) |
| `ask` | [protokol11/pi-ask](https://github.com/protokol11/pi-ask) | [`@protokol11/pi-ask`](https://www.npmjs.com/package/@protokol11/pi-ask) |
| `session-search-lite` | [protokol11/pi-session-search-lite](https://github.com/protokol11/pi-session-search-lite) | [`@protokol11/pi-session-search-lite`](https://www.npmjs.com/package/@protokol11/pi-session-search-lite) |
| `setup-upgrade` | [protokol11/pi-setup-upgrade](https://github.com/protokol11/pi-setup-upgrade) | [`@protokol11/pi-setup-upgrade`](https://www.npmjs.com/package/@protokol11/pi-setup-upgrade) |
| deep-research skill + agent-directory | [protokol11/pi-deep-research](https://github.com/protokol11/pi-deep-research) | [`@protokol11/pi-deep-research`](https://www.npmjs.com/package/@protokol11/pi-deep-research) |

### The pipeline these extensions serve

The author runs a fixed skeleton; the extensions above wrap it with runtime gates:

```
hand-on ──▶ drill-me ──▶ to-spec ──▶ update-docs ──▶ subagent dispatch
   ▲                                                        │
   │                                                to-violations (principles → fix-specs)
   │                                                        │
hands-off ◀────────────────────────── [violent adversarial re-check]
```

Sessions are continuations, not cold starts: hand-on resumes mode and verifies the git
snapshot of the handoff; hands-off is context-window management, not a pause.

## Install

Prerequisites: Node.js 22+, the [pi coding agent](https://github.com/badlogic/pi-mono).

From npm (the packaged judgment extension):

```sh
pi install npm:@protokol11/pi-judgment
```

From source, copy or junction a package folder into the agent extension directory:

```sh
cp -r extensions/judgment ~/.pi/agent/extensions/judgment
# or, on Windows, a junction so the repo stays the single source:
# mklink /J "%USERPROFILE%\.pi\agent\extensions\judgment" "C:\path\to\agent-governance\extensions\judgment"
```

## Links

- Skills bundle: <https://github.com/protokol11/skills>
- Principle catalog and pack pipeline live in the `to-violations` skill of that bundle.

## Contributing

File issues in the repository tracker. Each extension carries its own headless test
where the logic is pure (for example `node --experimental-strip-types rlcd-local/test-logic.ts`);
run the test file next to the extension you change. Keep every ledger append-only and
every gate fail-closed — those two properties are the product.

## License

[MIT](LICENSE)
