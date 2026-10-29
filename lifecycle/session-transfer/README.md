# session-transfer

Pi extension that replaces lossy context compaction with a typed handoff document and a session rotation.

Context windows degrade before they overflow: past roughly 150k tokens of accumulated conversation the model enters a measurable quality drop ("dumb zone"). Pi's built-in compaction answers this with a summarised transcript — a lossy text dump with no type contract, no verification, and no way to check what was lost. This extension answers it with a handoff: a typed document the agent authors (via the `hands-off` skill), that the child session is seeded from, so the session rotates on the document instead of on a guess. See the [handoffs skill family](https://github.com/protokol11/handoffs) for the document format.

Scope: packaging (`/transfer`), explicit rotation (`/transfer-resume`), and optional gated auto-rotation. Non-scope: summarising transcript history (that is compaction), and any session migration across machines.

## Why

- Rotation triggers at `min(0.70 × contextWindow, 150_000)` tokens — the same degradation threshold used across this repo's lifecycle tooling — before quality collapse, not after.
- The handoff lives under `.docs/handoff/` with frontmatter `sessionId` and `next_session_mode`. That is the contract: `/transfer-resume` finds the newest handoff carrying the current session id and reuses it, no repackaging.
- The rotation is mechanical: `newSession` with the handoff seed, carrying model and thinking level to the child through a module-scoped queue (the parent context is stale after replacement).
- Every step logs to `.pi/session-transfer.log`; every guard fails silent so a broken transfer never breaks the session it serves.

## Prerequisites

- [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) with the `hands-off` and `update-docs` skills installed.

None further.

## Install

Copy this directory into your pi extensions folder:

```sh
cp -r session-transfer ~/.pi/agent/extensions/session-transfer
```

Expected result: the directory exists and pi loads `/transfer` and `/transfer-resume` at next start.

## Usage

One worked path — package and resume:

1. Run `/transfer`. The extension injects an instruction; the agent writes a handoff via `hands-off` and a status via `update-docs`, then calls `request_transfer` with the handoff path. No new session is created.
2. Run `/transfer-resume`. The extension reuses the handoff for this session (or writes one first), then rotates: a fresh session starts, seeded with the handoff and carrying the parent's model and thinking level.

Optional automatic path (off by default):

- `SESSION_TRANSFER_AUTO=1` arms two automatic channels: an idle gate (usage ≥ threshold and no user input) confirmed by a second model acting as observer (`SESSION_TRANSFER_OBSERVER_MODEL`, default `deepseek/deepseek-flash`), and an agent tool `begin_transfer` once the warn band is hit. Non-explicit channels always ask the user before rotating.

## Commands

| Command | Effect |
|---|---|
| `/transfer` | Package the session into handoff + status; no rotation |
| `/transfer-resume` | Reuse-or-produce a handoff, then rotate and auto-start the child |
| `/transfer-rotate` | Internal; dispatched by the extension once a transfer is armed |
| `begin_transfer` (tool) | Agent-initiated transfer at warn band; requires `SESSION_TRANSFER_AUTO=1` |
| `request_transfer` (tool) | Arm the rotation with a handoff file path |

## Configuration

| Variable | Type | Default | Effect |
|---|---|---|---|
| `SESSION_TRANSFER_AUTO` | flag | off | Enable idle gate and `begin_transfer` |
| `SESSION_TRANSFER_DISABLE` | flag | off | Hard off-switch for all transfer paths |
| `SESSION_TRANSFER_AUTO_RESUME` | flag | off | Auto-start the child on non-explicit channels too |
| `SESSION_TRANSFER_OBSERVER_MODEL` | `provider/model` | `deepseek/deepseek-flash` | Observer model for idle-gate confirmation |
| `CONTEXT_GUARD_WARN_TOKENS` | number | 0.70 × window | Absolute warn band override |
| `CONTEXT_GUARD_CRITICAL_TOKENS` | number | derived | Absolute critical band override |

## Troubleshooting

- **Symptom:** `begin_transfer` returns "Automatic transfer is off." — Cause: `SESSION_TRANSFER_AUTO` is unset. — Fix: set it, or use `/transfer` / `/transfer-resume`.
- **Symptom:** rotation never fires after `request_transfer`. — Cause: a non-explicit channel awaits user confirmation; no answer means no rotation. — Fix: run `/transfer-resume`, which rotates immediately.
- **Symptom:** "rotation failed" notification. — Cause: see `.pi/session-transfer.log` in the project directory.

## Contributing

File issues in the [protokol11](https://github.com/protokol11) monorepo. Run the checks for this package from the repo root:

```sh
npx tsc --noEmit repos/protokol11/agent-governance/lifecycle/session-transfer/index.ts
```

## License

Licensed under the repository's license; see [LICENSE](../../../LICENSE).
