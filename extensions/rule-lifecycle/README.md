# rule-lifecycle

Mine governance rules from an append-only judgment ledger and graduate them through replay gates.

Repeated judgment calls leave evidence in an append-only ledger. This extension treats that evidence as data for induction, not as anecdotes. Clusters of recurring residuals surface as candidate rules. A rule moves from `should` to `must` only when a synthesized lint reproduces held-out human verdicts above a threshold. The inductive bias comes from the ledger, not from someone's head.

The entry point `index.ts` does not exist yet, so pi does not load this extension directly. The modules run through the test suite and through `emit-drill-proposals.mjs`.

## Background

A judge answers governance questions, and a deterministic predicate answers the cheap cases. The cases the predicate misses are residuals: escalations and refusals. When the same question shape recurs and the judge disagrees with the resolved outcome, the predicate has a blind spot worth encoding as a rule.

rule-lifecycle runs the scientific loop over that trail:

1. **Mine.** Cluster residuals by question shape, ranked by volume times disagreement rate (`core/mine.ts`).
2. **Propose.** Emit a reviewable proposal file. The catalog is never opened for writing (`propose.ts`).
3. **Promote.** Fire a `should` to `must` promotion when sample size, false-refusal rate, human-resolved count, and held-out replay all pass their gates (`core/promote.ts`).
4. **Demote.** Open the symmetric valve when a `must` rule exceeds its false-positive tolerance.

Scope: pure queries over ledger records and refusal records. No file system, no model calls inside the query modules. Out of scope: writing to the rule catalog, replay against superseded labels, and any promotion without a synthesizable lint predicate in `lints/`.

Sources: `journey/judgment-stack-journey.md` in the monorepo and `.docs/PIPELINE.md` at the workspace root.

## Install

Prerequisites: Node.js 22.6 or newer with type stripping support. No package install step exists.

1. Copy the extension directory into the pi extensions folder:

   ```sh
   cp -r extensions/rule-lifecycle ~/.pi/agent/extensions/rule-lifecycle
   ```

   On Windows PowerShell, use `Copy-Item -Recurse` with the same paths.

2. Run the modules by explicit invocation. There is no auto-loaded entry point.

## Usage

The proof command runs the full suite from the extension directory:

```sh
npm test
```

Expected tail of the output:

```text
ℹ pass 20
ℹ fail 1
```

The one failure is `test/read.test.mjs`: "a refusal referencing an unknown judgment_id throws". The other 20 of 21 tests pass. The suite is the current harness for every module.

To emit candidate proposals after a drill, run the explicit script from the extension directory:

```sh
node --experimental-strip-types emit-drill-proposals.mjs
```

Expected output:

```text
wrote <repo-root>/.scratch/rule-lifecycle/candidate-CP-13.md
wrote <repo-root>/.scratch/rule-lifecycle/candidate-CP-22.md
```

The script calls `writeProposal`, which refuses any path outside `.scratch/rule-lifecycle`.

## API

All query functions are pure. They take `JudgmentRecord[]` and `Map<string, RefusalRecord>` from the sibling `judgment` extension.

```ts
import { mineResiduals, replay } from "./core/mine.ts";
import { promotionCandidates, demotionCandidates } from "./core/promote.ts";
import { writeProposal } from "./propose.ts";
import { predicateFor } from "./lints/index.ts";
```

- `mineResiduals(records, refusals, { minVolume, minDisagreement })` returns ranked clusters with sample hashes and instructions.
- `replay(predicate, records)` returns accuracy, count, and mismatching judgment ids over resolved records.
- `promotionCandidates(records, refusals, gates)` returns promotion events with a held-out replay report. Human-resolved witnesses form the held-out set and never feed mechanical synthesis.
- `demotionCandidates(lintStats, { maxFalsePositiveRate })` returns demotion events on probation.
- `writeProposal(proposal, { root })` writes one proposal file under `.scratch/rule-lifecycle` and throws on any other path.
- `predicateFor(ruleId)` looks up a synthesized lint. A rule with no entry here can never be promoted.

Full reference: the doc comments in `core/mine.ts`, `core/promote.ts`, and `propose.ts`.

## Troubleshooting

- Symptom: `Cannot find module '../../judgment/core/types.ts'`. Cause: the suite reads the sibling `judgment` extension through a relative path. Fix: run from a checkout that contains both extensions at their repo paths.
- Symptom: `writeProposal` throws a path error. Cause: the proposal target resolves outside `.scratch/rule-lifecycle`. Fix: pass `root` for the intended repository and keep rule ids slug-safe.

## Contributing

File issues in the `protokol11` monorepo tracker. Run the tests before a change:

```sh
npm test
```

## License

Licensed under the repository license. See [../../LICENSE](../../LICENSE).
