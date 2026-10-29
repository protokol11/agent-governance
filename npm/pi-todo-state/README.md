# @protokol11/pi-todo-state

Append-only, concurrency-safe todo board: event log plus deterministic fold.

todo-state gives a pi session (and every subagent it spawns) one machine-readable
board for "what is being worked on right now". The board lives on disk as an event
log outside the model, so the runtime acts as an oracle for shared memory: any
session reads the same state, and no context window holds the only copy.

## Table of contents

- [Install](#install)
- [Usage](#usage)
- [CLI](#cli)
- [Configuration](#configuration)
- [How it fits the repo conventions](#how-it-fits-the-repo-conventions)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Install

Prerequisites: Python 3.11 or newer (standard library only, no packages to
install), Node.js for the pi extension host.

Copy the package directory into the pi agent search path (or install via pi's package settings):

```sh
cp -r node_modules/@protokol11/pi-todo-state ~/.pi/agent/extensions/todo-state
```

The Python core installs as a CLI from its `pyproject.toml`:

```sh
pip install ~/.pi/agent/extensions/todo-state
```

The extension itself never needs the install step: it runs
`python -m todo_state` with the extension directory on `PYTHONPATH`.

Expected check output:

```sh
$ python -m pytest tests/ -q
50 passed
```

(50 pytest tests cover the Python core; 5 more `node:test` table tests cover the
PLAN.md scanner in `tests/plan-scan.test.ts`.)

## Usage

One path to one result: add a task, start it, read the board.

```sh
$ todo-state add "Write the README"
t-1a2b3c
$ todo-state start t-1a2b3c
start t-1a2b3c
$ todo-state board --json
{"seq": 2, "in_progress": "t-1a2b3c", "tasks": [{"task_id": "t-1a2b3c", "title": "Write the README", "status": "in_progress", "note": null}]}
```

Inside pi, the extension exposes three tools over the same core:
`todo_write` (add a task, optionally start it), `todo_update` (close with
`done`, `blocked`, or `wontfix`), and `todo_read` (board as JSON, replayable
with `at_seq`). Starting a task demotes the previous in-progress task to
pending, so the board always names at most one active task — the handle the
drift hook and other sessions read.

## CLI

Synopsis: `todo-state [--session-id ID] [--dir PATH] <command>`.

- `add TITLE [--task-id ID] [--note TEXT] [--status pending|in_progress]` — add a task, print its id.
- `start TASK_ID` — mark in progress, superseding any current one.
- `done TASK_ID [--note TEXT]` — close as done.
- `block TASK_ID [--note TEXT]` — close as blocked.
- `wontfix TASK_ID [--note TEXT]` — close as wontfix.
- `clear` — clear the board with one event.
- `board [--json] [--at-seq N]` — print the board; `--at-seq` replays the log up to that seq.

Exit codes: 0 success, 2 refused input or unknown task id.

## Configuration

| Key | Type | Default | Effect |
|---|---|---|---|
| `TODO_STATE_DIR` | path | `.pi/todo` | State directory (event log plus folded board). |
| `TODO_STATE_SESSION_ID` | string | `cli-<pid>` | Session id stamped on appended events. |

All CLI streams are forced to UTF-8, so titles and notes in any language pass
through the extension without re-encoding loss (pinned by
`tests/test_cli_encoding.py`).

## How it fits the repo conventions

The repo keeps its plan and pipeline contracts in `.docs/` (see
`.docs/PLAN.md` and `.docs/PIPELINE.md`). The extension honours that layout:
an advisory drift hook scans `.docs/PLAN.md` and appends one caution line to
the tool result when the active task or the call target is outside the plan.
The hook has no block path — a missing or unreadable plan leaves it silent
and logs one line to the extension log. Full behaviour is specified in
`.docs/SPECS/harness-core/todo-state-tools.md`.

## Troubleshooting

- Symptom: `todo_write` fails with `unknown task id`. Cause: the id never
  appeared on the board. Fix: read the board first with `todo_read` or
  `todo-state board`.
- Symptom: drift cautions stopped appearing. Cause: `.docs/PLAN.md` is missing
  or unreadable, or the hook hit an error and disabled itself. Fix: check the
  extension log line written at session start.

## Contributing

File issues against the [agent-governance](https://github.com/protokol11/agent-governance) monorepo (source under `extensions/todo-state`; this package is a publish copy). Run the test suites before sending a change:

```sh
python -m pytest extensions/tests/
node --experimental-strip-types extensions/tests/plan-scan.test.ts
```

## License

[MIT](./LICENSE)
