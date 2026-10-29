# agent-directory

A typed directory of pi subagents: who exists in the system, with which profile, model, and tools.

## Why

An orchestrator that spawns subagents needs an answer to one question: *who can I call, and what are they allowed to touch?* Free-text role names give no such answer. This extension treats the set of subagents as a typed catalog with a closed schema, loaded from declarative markdown files, so the answer comes from data, not from memory.

The directory answers the first half of agent compatibility: the role fits the task, its tool list covers the work, and its context budget covers the input. The second half — whether the surrounding graph can route the task — belongs to [orchestration-graph](../orchestration-graph). Compatibility is the conjunction of both.

Out of scope: planning which agent to call (the orchestrator decides), multi-step agent pipelines, and any network or MCP registration.

## Install

Prerequisites: pi (the coding agent runtime) and Node.js with type stripping support.

1. Copy this directory to the pi extension path:

```sh
cp -r extensions/agent-directory ~/.pi/agent/extensions/agent-directory
```

2. Start pi in any project. The extension loads on `session_start`.

Expected result: the `agent(name, task)` tool appears with the loaded agent names, and the `/agents` command lists the catalog.

## Usage

1. Create a project agent file at `.pi/agents/reviewer.md`:

```markdown
---
name: reviewer
description: Reviews a diff and reports findings
tools: read, bash
model: anthropic/claude-sonnet-4-20250514
---
You review diffs. Report findings as file:line — issue.
```

2. Start pi and run the slash command:

```text
/agents
```

Expected output:

```text
reviewer (project): Reviews a diff and reports findings — tools: [read, bash] — model: anthropic/claude-sonnet-4-20250514
```

3. Call the agent from a session:

```text
agent(name="reviewer", task="review the last commit")
```

The extension spawns a child `pi` process. The agent file supplies the system prompt, the tool filter reaches the child through `--tools` (CS-30), and the child runtime refuses tools the file does not declare. A trace entry records agent, task digest, tools, and model before the spawn (RTL-09).

## How it works

| Module | Role |
|---|---|
| `loader.ts` | Pure loader. Reads `.pi/agents/*.md` (project) and `~/.agents/agents/*.md` (user), parses frontmatter against the closed key set `name, description, tools, model` (CP-22), and writes a catalog manifest to `.pi/agent-directory/catalog.json`. Project scope wins on name collision. No pi imports. |
| `index.ts` | Pi wiring. Reloads the catalog when the directory snapshot drifts, registers the `agent` tool with the catalog names as the parameter enum, and exposes `/agents`. |
| `spawn-plan.ts` | Pure planner. Builds every child argument: model (agent file beats session default), `--tools`, `--exclude-tools mcp__*` for read-only roles, and a `0o600` temp prompt file passed through `--append-system-prompt`. |
| `spawn-run.ts` | Runner. Executes the plan and maps the child exit state to a structured outcome. |

The `agent` tool schema is built from the loaded catalog, never from free text: only names that exist in the directory reach the model (CP-22). The spec for the harness-core bindings that consume this catalog lives outside this repository.

## Configuration

Agent files carry the whole configuration. Frontmatter keys:

| Key | Type | Required | Effect |
|---|---|---|---|
| `name` | string | yes | Directory key. Must be unique across scopes after shadowing. |
| `description` | string | yes | Shown in `/agents` and in tool listings. |
| `tools` | list or comma string | no | Tool filter passed to the child. Empty means pi defaults. |
| `model` | string | no | Provider/model for the child. Falls back to the session model. |

The body after the frontmatter is the agent prompt. An empty body is a load error.

## Tests

54 tests across three suites: 17 loader, 21 spawn-plan, 16 spawn-run. The suites run under plain Node with type stripping, no test framework:

```sh
npm test
```

## Contributing

File issues against the owning repository. Run `npm test` in this directory before submitting a change. Keep `loader.ts` and `spawn-plan.ts` free of pi imports; that separation is what lets the suites run without the runtime.

## License

See the repository LICENSE file.
