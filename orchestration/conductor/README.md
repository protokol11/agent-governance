# conductor

Pi extension that runs chained agent workflows and an adaptive Ralph loop with role-gated tool access.

> Orchestration extension for the pi coding agent: fixed subagent chains, a Ralph iteration loop (explore → plan → coder → tester), a per-role tool allowlist (role-gate), and test-profile resolution. Note: this package predates the current standards of the monorepo it lives in; a rework is planned.

## Table of contents

- [Background](#background)
- [Install](#install)
- [Usage](#usage)
- [CLI](#cli)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Background

Conductor treats agent orchestration as a finite-state machine, not a prompt trick.

- **Ralph loop as a state machine.** Each iteration moves through distinct phases — role selection, subagent action, artifact logging, planning (`decideAfterVerify` maps verify results to `done | retry | plan | diagnose | human | abort`), and hooks on session start and tool calls. State is persisted per run, so a loop survives session restarts (`restoreActiveRalphRunId`).
- **Subagent chains.** A chain is an ordered list of roles. `/conductor run <chain> <theme>` spawns the roles in sequence over the pi-subagents RPC channel and collects their artifacts under `.pi-subagents/artifacts/`.
- **Role-gate.** Every Conductor-managed subagent session is registered with a role; a `tool_call` hook blocks any tool outside that role's allowlist and appends the block to `tmp/conductor/role-gate.log`. Default roles: `explore`, `plan`, `coder`, `tester`, `fixer`. A tester, for example, can read and run tests but cannot edit files.
- **Cheap-model dispatch with verification.** The monorepo model routing (`.docs/PIPELINE.md`) assigns tactical coding to Kimi K2.7 on minimal/low thinking and strategy to DeepSeek v4-pro on high. Conductor's split — cheap executors plus a separate verifier pass and an independent verification rotation — applies the same principle: spend cognition on planning and verification, not on code generation.

Scope: orchestration primitives inside pi sessions. Out of scope: model selection (the human or orchestrator picks the brain; Conductor picks the hat), ticket tracking (retired in favor of direct dispatch).

## Install

Prerequisites:

- Node.js with `npm` (devDependencies pin `@earendil-works/pi-coding-agent` and TypeScript).
- The pi coding agent with the subagents RPC channel available.

Copy this directory into your pi extensions folder:

```sh
cp -r orchestration/conductor ~/.pi/agent/extensions/conductor
```

Expected result: `~/.pi/agent/extensions/conductor/index.ts` exists and pi loads the extension at session start, showing `conductor` and `ralph` status items.

## Usage

Start a fixed chain over a theme:

```text
/conductor run standard "add dark mode to the dashboard"
```

The chain runs each role in order; `status` shows progress, `next` advances after a pause. For open-ended goals, run the Ralph loop:

```text
/ralph run --auto --project . "make the login form pass its acceptance criteria"
```

Each iteration goes explore → plan → coder → tester, writes artifacts (`AUDIT.md`, `plan.md`, `code.md`, `report.json`), then the planner decides: done, retry with TDD guidance, re-plan, diagnose, escalate to human, or abort at `maxIterations`. Verify the loop decision in code at `ralph/planner.ts:decideAfterVerify`.

## CLI

`/conductor <subcommand>` — synopsis: `/conductor run <chain> <theme>`.

- `run <chain> <theme>` — execute a chain (see Configuration for chain definitions).
- `next`, `redo` — advance or repeat the current step.
- `status`, `abort` — inspect or stop the active run.

`/ralph <subcommand>` — synopsis: `/ralph run [--auto] [--project <path>] <goal>`.

- `run` — start an adaptive loop.
- `continue`, `pause`, `status`, `abort` — lifecycle control; state persists across sessions.

## Configuration

| Key | Location | Default | Effect |
|---|---|---|---|
| `conductor.roles.<role>.allowedTools` | `.pi/settings.json` | built-in allowlist per role | Override which tools a role may call. |
| Chains | `.pi/conductor-chains.json` (project) and `~/.pi/conductor-chains.json` (base) | required | `{"chains": {"name": ["explore", "plan", ...]}}`; project chains override base chains with the same name (`loadChains`). |
| Test profiles | `.pi/profiles/tester.json` | fallback profile | Resolved by the `get_test_profile` tool; the tester role calls it before running tests and must record `fallbackReason` when `isFallback` is true. |

## Troubleshooting

- Symptom: `Conductor: pi-subagents RPC not ready`. Cause: the subagents channel has no peer. Fix: start pi in a project where the subagents extension is loaded, then retry.
- Symptom: a tool call is blocked with `Role '<role>' is not allowed to use '<tool>'`. Cause: role-gate enforcement. Fix: edit the role allowlist in `.pi/settings.json`, or check `tmp/conductor/role-gate.log` for the record.
- Symptom: `/conductor run` reports an unknown chain. Cause: the chain is missing from both chain files. Fix: add it to `.pi/conductor-chains.json` and restart the session.

## Contributing

This package is private (`"private": true` in `package.json`). File issues in the monorepo tracker at the repository root. Run checks before committing:

```sh
npm run typecheck   # npx tsc --noEmit
npx tsx test-conductor.ts
npx tsx test-ralph.ts
npx tsx test-tester-profile.ts
```

## License

No license file is present in this package; default copyright applies and the code is not licensed for reproduction or distribution. See the monorepo root for any top-level license terms.
