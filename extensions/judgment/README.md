# pi-judgment

Typed, calibrated decisions for pi agents: every judgment is recorded, priced, and measured against outcomes.

## Why

An LLM that returns "yes, p=0.98" is not evidence — it is a claim. This extension treats every model answer as a hypothesis: the model proposes a typed answer with a calibrated probability, the caller decides with fixed options, and ground truth arrives later when the outcome is known. Confidence is trusted only after predicted reliability matches observed reliability in the ledger; escalation is a priced third action, not an error path; and below the minimum sample size the human decides, because a cold-start probability is noise regardless of how confident it sounds.

## How it works

Mental model: a decision is a claim with a price, not a feeling.

1. **Ask.** The `judge` tool takes typed questions (noul / choice / score). Questions are linted before any model call — a bad question costs nothing. Every answer is appended to an append-only JSONL ledger with its value and confidence.
2. **Decide.** `decide` picks the cheapest of three priced actions: act yes, act no, escalate. Escalation ties go to the owner. Below `minSample` resolved records the gate escalates regardless of p — cold start means the human decides.
3. **Resolve.** `resolve_judgment` records ground truth. The `/calibration` command bins resolved records and compares predicted vs observed reliability, filtered by provenance so human and rule decisions never leak into the model's curve.

```
ask (typed, linted)
  │
  ├─ rule judge (deterministic trigger) ──► priced decision ──► act
  │                                                    │
  └─ model judge ──► ledger ──► resolve ──► calibration curve
                                 ▲                │
                            human answers ◄── below minSample,
                            broken judge,     or escalate ties
                            p=0.98 included
```

Two gates wrap `write`/`edit` tool calls. The **scope-lock gate** requires a `scope_lock` authorization (session-bound, inherited by subagents through the session chain); a degraded judge always escalates to a confirmation dialog rather than failing or silently allowing. The **cp-review gate** checks diffs against the CP corpus — it requires `cp-corpus.json` emitted by the `principles-render` package from the principles catalog; without that file the gate cannot run.

Known limits, stated in one place: bash mutations are not gated, calibration rests on ledger-sized samples (tens of records, not thousands), and thinking models as judges degrade into escalation.

## Install

Prerequisites: pi coding agent runtime; for the cp-review gate, a `cp-corpus.json` built by the `principles-render` package.

From this monorepo's npm package:

```sh
pi install npm:@protokol11/pi-judgment
```

Or copy this folder into the agent extension directory:

```sh
cp -r extensions/judgment ~/.pi/agent/extensions/judgment
```

## Usage

Call `scope_lock` before the first mutation, then use `judge` for checkable decisions and `resolve_judgment` to close the loop:

```sh
judge(state, { "scope_ok": { type: "noul", instructions: "..." } })
resolve_judgment(judgment_id, true)
```

Inspect the reliability curve with the `/calibration` command. Run the test suite with `npm test` (17 files under `test/`, plus shared fixtures).

## Contributing

File issues in the protokol11 monorepo. Run `npm test` before submitting changes; the core under `core/` is pure and tested without pi.

## License

MIT — see [LICENSE](../../LICENSE).
