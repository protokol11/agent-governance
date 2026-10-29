# parity-meter

> Pi extension and offline replay engine that turns sessions into a parity ledger of model drift.

pi runs the same prompt through different providers, model versions, and thinking levels. Whether two
runs on identical input stay identical — token mix, reasoning share, cost, protocol behaviour — is a
measurable quantity, not an impression. This extension measures it.

## Why

Model drift is silent: an upgraded checkpoint, a changed default, a different provider under the same
model name — none of these announce themselves. They show up as a shifted `avg_input`, a changed
`reasoning_share`, a new `repeat_read_unchanged` count, or a tool-call sequence hash that no longer
matches the baseline for the same task. An optimization shipped without a regression check is a
breakage (RTL-05). The parity ledger is that check: one row per (session, provider, model, thinking)
group, comparable across runs and versions.

Scope: measurement only. The meter never changes tool arguments and never stops a call
(RTL-08: meter measures, gates decide). It does not judge drift; it records the quantities that let
a gate judge.

Non-scope: prompt evaluation, output quality scoring, model ranking. Those need a judge; this meter
is deterministic rules over observable protocol events.

## How it works

```
session (pi) ──► live extension (index.ts)          agent_end
                  ├─ snapshot tool schemas            │        ├─ ~/.pi/agent/parity.jsonl   (ledger, JSONL)
                  ├─ count protocol errors            └──────► ├─ ~/.pi/agent/parity-meter/
                  ├─ sample usage per turn                      │    tool-schemas.json      (schema sidecar)
                  └─ group by (provider, model, thinking)       └─ session custom entry "parity-meter"
                                             ▲
session files ──► replay engine (parity_meter/*.py, CLI) ── same ledger rows, offline
```

- **Ledger** (`ledger.ts`, `parity_meter/ledger.py`): a projection keyed by session, not an event log.
  Rows for a session are replaced on every write; atomic temp-file-plus-rename; replay is
  deterministic — `emitted_at` derives from session content, so two runs over unchanged files are
  byte-identical. A corrupt ledger line fails loudly instead of being dropped.
- **Row contract** (`schemas.ts`): `schema_version: 1`, `rules_version: 2`, 24 named fields
  (`req`, `avg_input`, `reasoning_share`, `cost_total`, `protocol_errors`, `tool_seq_sha`, ...).
  The TS and Python implementations declare the same constants; the row contract test fails on drift.
- **Protocol-error rules** (`parity_meter/rules.py`, `RULES_VERSION = 2`, threshold 0, no model
  judgment): `tool_name_not_in_schema` — a tool call absent from the schema snapshot, judged against
  the union of the `session_start` and `agent_end` snapshots so a mid-session registration is not a
  ghost; `args_fail_schema` — arguments failing the tool's JSON Schema (stdlib validator subset:
  `type`, `properties`, `required`, `enum`, `anyOf`, `oneOf`, `allOf`, `pattern`, `minItems`, ...);
  `repeat_read_unchanged` — a re-read of an untouched path inside `REPEAT_WINDOW_SEC = 900` seconds
  (a fixed decision, never tuned: the observed true positive was 39 s, the observed false positive
  a 4.5 h re-read). Absent snapshot ⇒ `protocol_errors` is `null`, never zero — a count computed
  against no schema is fabricated (RTL-08).
- **Replay CLI** (`parity_meter/__main__.py`): `replay` rebuilds rows from session files and merges
  them into the ledger; `table` prints the aggregate per (provider, model, thinking); `doctor`
  checks ledger health.

The TypeScript side is the live meter for a running pi session; the Python side replays stored
session files offline into the same ledger format.

## Install

Prerequisites: Node.js (for the live extension) and Python ≥ 3.11 (for replay). None beyond that.

Copy the extension directory into the pi extensions folder:

```bash
cp -r extensions/parity-meter ~/.pi/agent/extensions/parity-meter
```

Then restart pi. On the next `agent_end` the meter appends rows to `~/.pi/agent/parity.jsonl`
and refreshes the sidecar at `~/.pi/agent/parity-meter/tool-schemas.json`.

For the replay CLI:

```bash
pip install repos/protokol11/agent-governance/extensions/parity-meter
parity-meter replay        # last 40 sessions -> ledger
parity-meter table         # aggregate per (provider, model, thinking)
```

Expected replay output ends with:

```
=== aggregate over N sessions ===
<provider>  <model>  think=<level>  req=<n>  cacheRead=<p>%  reasoning=<p>%  cost=$<total>

ledger: /home/<user>/.pi/agent/parity.jsonl (<rows> rows written for <sessions> sessions)
```

## Tests

```bash
node --experimental-strip-types tests/ledger.test.ts        # ledger merge, idempotency, sidecar
node --experimental-strip-types tests/extension.test.ts     # live wiring against a fake pi runtime
node --experimental-strip-types tests/row-contract.test.ts  # TS/Python row schema drift check
python -m pytest tests/                                     # replay: ledger, parse, rules
```

Last run: 3 TypeScript suites, 0 failures; 90 Python tests passed.

## Troubleshooting

- **Symptom:** rows show `protocol_errors: null`. **Cause:** no schema sidecar exists yet — the meter
  has not completed an `agent_end`. **Fix:** run one session to completion and replay again.
- **Symptom:** replay warns `sidecar unusable`. **Cause:** the sidecar is corrupt JSON. **Fix:**
  delete `~/.pi/agent/parity-meter/tool-schemas.json` and let the next session rewrite it.
- **Symptom:** ledger read fails on a line. **Cause:** manual edit or a crash left invalid JSON.
  **Fix:** the file is left untouched by design; restore from version control.

## Contributing

File issues in the monorepo issue tracker. Run all four test commands above before submitting;
the row contract test must pass for any change to `schemas.ts`, `ledger.ts`, or the row fixtures.

## License

[MIT](../../LICENSE)
