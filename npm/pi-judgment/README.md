# @protokol11/pi-judgment

Typed, calibrated decisions for pi agents: a `judge` tool, an append-only ledger, a reliability curve, and a scope-lock gate with dual-judge review.

## Why

Agents get autonomy through a prompt. This extension grounds autonomy in evidence instead:

1. Every agent decision is recorded as a typed judgment with an explicit confidence.
2. Resolved outcomes build a calibration curve per model. The curve decides when a model's probability is trustworthy enough to act on.
3. Escalation to a human is a priced third action, not a fallback. Below the minimum sample size, every decision escalates: a cold-start ledger has no evidence, so the human decides.

## How it works

Mental model: `judge(state, questions)` asks typed questions and returns answers with a probability. Each answer lands in an append-only ledger. Later, `resolve_judgment` records whether the claim turned out true. The calibration view compares predicted vs. observed accuracy per confidence bin.

```text
agent ── judge(state, questions) ──► lint questions (free: no model call on bad input)
                                      │
                                      ▼
                          model answers noul / choice / score
                          (yes/no + probability, or option, or score)
                                      │
                                      ▼
                 append-only ledger: .pi/judgments.jsonl
                 judgment rows + resolution + refusal events, folded on read
                                      │
        resolve_judgment(id, outcome) ▼
                 reliability curve: predicted vs. observed per bin
                 /judgments → Tab: calibration pane
```

Scope-lock gate: `write` and `edit` are blocked until a scope judgment is authorized. A deterministic rule predicate runs first (an explicit user trigger pins p, no model call). If no trigger is present, a semantic judge scores the residue of the conversation. A degraded judge never degrades to allow: it asks the human. Authorization is bound to the session that declared it and is inherited by subagents through the session chain (a child reads the root project's ledger).

Decision policy (`decide`): act yes, act no, or escalate — the policy picks the cheapest action, and a tie escalates to the human. Below `minSample` resolved records it always escalates.

- `judge(state, questions, model?)` — typed questions (`noul`, `choice`, `score`), linted before any model call; bad questions cost nothing.
- `resolve_judgment(judgment_id, outcome)` — records ground truth; unresolved judgments never count toward calibration.
- `scope_lock(declared_scope)` — authorizes file mutations for the session; call before the first `write`/`edit`.
- `/judgments` — full-screen explorer over the ledger: browse, filter by model and provenance, resolve with `y`/`n`; `Tab` switches to the calibration pane. Outside the TUI it prints a one-line stats summary.

## Install

Requires Node 22 or later. For the pi coding agent:

```bash
pi install npm:@protokol11/pi-judgment
```

Or add the package to `packages` in your pi settings. See pi.dev for the extension API.

## Optional integration: cp-review gate

The gate reviews `write`/`edit` payloads against CPs (composable principles) from a trained classifier. By default it reads the corpus at `~/.agents/skills/principles-render/rendered/cp-corpus.json`. That file comes from the `principles-render` skill in the `principles` package: https://github.com/protokol11/principles

Without a corpus, or when the classifier is unavailable, the gate fails loudly with `classifier/corpus unavailable` and asks for human review. There is no silent fallback.

## Honest status

Working. 16 test files, 142 tests passing. The cp gate caches the corpus per process; a session-level cache is not implemented.

## License

MIT
