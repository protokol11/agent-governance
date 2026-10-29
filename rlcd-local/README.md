# rlcd-local

Register the local RLCD classifier sidecar as a pi LLM provider for dual-judge judgment.

A pi extension that exposes a locally served, fine-tuned decision-cell classifier as the second judge in a dual-judge judgment system: Judge №1 is the general LLM, Judge №2 is a logistic head over the frozen representation of Coder-1.5B, trained with RLCD (Reinforcement Learning from Classifier Distillation) to score a change against control-practice criteria. Its OOF AUROC of 0.9475 on Coder-1.5B means the learned reward is a measurement of verdict quality, not a prompt heuristics.

## Why

The governing stack follows two scientific-principles rules for the judgment layer:

- **CP-13 — make invalid states unrepresentable.** A review that runs without its classifier is an invalid state of the pipeline, so the code contains no path that produces it. There is no silent fallback to a weaker judge, no default-to-LLM branch. When the sidecar is unreachable, `cp-review` fails with `classifier unavailable` and stops.
- **CP-22 — the oracle lives at runtime, not in the model's memory.** The reward (the head's probability) is computed fresh from the current diff and the current criterion text on every call. Nothing memorized at training time substitutes for measuring the present state.

The absence of a fallback is a feature under these rules: a verdict that skipped its measurement would contaminate downstream aggregates with numbers that mean nothing. A loud failure keeps the audit trail clean.

Scope: transport wiring between pi's classifier API and a running sidecar. Non-scope: the sidecar itself, the training pipeline, and any other question shape beyond the one it was trained on.

**The sidecar service is not part of this repository** (see Prerequisites).

## Install

### Prerequisites

- A running RLCD sidecar from the separate `finetune-lab` repository (`src/serve/rlcd_sidecar.py`). It is trained on state `{diff, cp_texts}` with one `noul` question and criteria `["yes", "no"]`; other question shapes shift the prompt representation and degrade the probability.
- The pi coding-agent runtime with extension support.

The sidecar is a Python service and expects its own environment (WSL, lab venv, GPU). Start it before pi:

```bash
HF_HOME=~/.cache/hf python src/serve/rlcd_sidecar.py --serve --host 0.0.0.0 --port 8931
```

### Install the extension

Copy this directory into the pi extensions folder:

```bash
mkdir -p ~/.pi/agent/extensions
cp -r repos/protokol11/agent-governance/rlcd-local ~/.pi/agent/extensions/rlcd-local
```

The sidecar is installed and started separately from its own repository.

## Usage

With the sidecar running, the extension registers provider `rlcd-local` with classifier model `rlcd-local/cell-coder-1.5b`, callable from other extensions via `ctx.modelRegistry.classify()`. During `cp-review`, a criterion is posed to the head and answered `yes` or `no` with a probability; the probability is the measured reward for that criterion.

If `cp-review` reports `classifier unavailable`, the extension loaded but the sidecar did not answer at `http://127.0.0.1:8931`. Start the sidecar and re-run. This failure is intentional — see Why.

## Configuration

| Key | Type | Default | Effect |
|---|---|---|---|
| `RLCD_SIDECAR_URL` | string | `http://127.0.0.1:8931` | Base URL of the sidecar; trailing slashes are stripped. |

## Development

```bash
npm install
npm test          # headless test of logic.ts (URL resolution, envelope, output unwrapping)
npm run typecheck
```

No pi runtime or network is needed for the test: `logic.ts` holds pure transport wiring and is covered without the sidecar.

## Contributing

File issues in the owning repository (`agent-governance`). Run `npm test` and `npm run typecheck` before submitting a change. See the design record in `journey/judgment-stack-journey.md` and `journey/maslow-harness-pyramid-journey.md` for the judgment-stack rationale.

## License

[MIT](../LICENSE) (project-wide license at the repository root).
