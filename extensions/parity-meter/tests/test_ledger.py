"""Tests for the ledger row schema, merge rewrite, and atomic write."""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest

from parity_meter.ledger import (
    FIELD_ORDER,
    SCHEMA_VERSION,
    aggregate,
    attribution_of,
    build_rows,
    merge_rows,
    read_ledger,
    tool_sequence_sha,
    write_ledger,
)
from parity_meter.parse import ToolCall, parse_session_file
from parity_meter.rules import RULES_VERSION, load_schema_snapshot, merge_snapshots

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
SESSION = os.path.join(FIXTURES, "session-with-errors.jsonl")
REPEAT_SESSION = os.path.join(FIXTURES, "session-repeat-window.jsonl")
SIDECAR = os.path.join(FIXTURES, "tool-schemas.json")
SECOND_SIDECAR = os.path.join(FIXTURES, "tool-schemas-second.json")


def parse_fixture() -> object:
    return parse_session_file(SESSION, on_error=lambda _message: None)


def rows_with_snapshot() -> list[dict]:
    return build_rows([parse_fixture()], load_schema_snapshot(SIDECAR))


class AttributionTest(unittest.TestCase):
    def test_full(self) -> None:
        self.assertEqual("full", attribution_of("kimi-coding", "kimi-for-coding"))

    def test_partial(self) -> None:
        self.assertEqual("partial", attribution_of("deepseek", None))

    def test_unknown(self) -> None:
        self.assertEqual("unknown", attribution_of(None, None))


class BuildRowsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.rows = rows_with_snapshot()

    def test_one_row_per_group(self) -> None:
        self.assertEqual(2, len(self.rows))
        keys = [(row["provider"], row["model"], row["thinking"]) for row in self.rows]
        self.assertEqual(
            [("kimi-coding", "kimi-for-coding", "low"), ("unknown", "unknown", "unknown")],
            keys,
        )

    def test_missing_provider_lands_in_unknown_group(self) -> None:
        unknown_rows = [row for row in self.rows if row["attribution"] == "unknown"]
        self.assertEqual(1, len(unknown_rows))
        self.assertEqual("unknown", unknown_rows[0]["provider"])
        self.assertEqual("unknown", unknown_rows[0]["model"])
        self.assertEqual(1, unknown_rows[0]["req"])

    def test_field_order_and_schema_version(self) -> None:
        for row in self.rows:
            self.assertEqual(list(FIELD_ORDER), list(row))
            self.assertEqual(SCHEMA_VERSION, row["schema_version"])
            self.assertNotIn("judgment_id", row)

    def test_every_row_carries_rules_version_two(self) -> None:
        # Spec `parity-meter-rule-calibration`, decision 3: additive field, schema_version stays 1.
        self.assertEqual(2, RULES_VERSION)
        for row in self.rows:
            self.assertEqual(2, row["rules_version"])
            self.assertIsInstance(row["rules_version"], int)

    def test_protocol_errors_are_counted(self) -> None:
        for row in self.rows:
            self.assertEqual(3, row["protocol_errors"]["total"])
            self.assertEqual(1, row["protocol_errors"]["tool_name_not_in_schema"])
            self.assertEqual(1, row["protocol_errors"]["args_fail_schema"])
            self.assertEqual(1, row["protocol_errors"]["repeat_read_unchanged"])
            self.assertTrue(row["schema_snapshot"])
            self.assertEqual("snapshot-current", row["schema_basis"])

    def test_absent_snapshot_yields_null_protocol_errors(self) -> None:
        rows = build_rows([parse_fixture()], None)
        self.assertTrue(rows)
        for row in rows:
            self.assertIsNone(row["protocol_errors"])
            self.assertFalse(row["schema_snapshot"])
            self.assertNotEqual(0, row["protocol_errors"])

    def test_parse_errors_reach_the_row(self) -> None:
        for row in self.rows:
            self.assertEqual(1, row["parse_errors"])

    def test_tool_sequence_fields(self) -> None:
        for row in self.rows:
            self.assertEqual(4, row["tool_seq_len"])
            self.assertEqual(
                tool_sequence_sha(
                    [
                        ToolCall("read", {}, 0),
                        ToolCall("read", {}, 1),
                        ToolCall("ghost_tool", {}, 2),
                        ToolCall("read", {}, 3),
                    ]
                ),
                row["tool_seq_sha"],
            )

    def test_aggregate_metrics(self) -> None:
        kimi = [row for row in self.rows if row["provider"] == "kimi-coding"][0]
        self.assertEqual(2, kimi["req"])
        self.assertEqual(950.0, kimi["avg_input"])  # (1500 + 400) / 2
        self.assertEqual(300.0, kimi["avg_cache_read"])
        self.assertEqual(65.0, kimi["avg_output"])
        self.assertEqual(30, kimi["reasoning"])
        self.assertAlmostEqual(round(30 / 130, 6), kimi["reasoning_share"])
        self.assertAlmostEqual(0.014, kimi["cost_total"])

    def test_emitted_at_is_derived_from_session_content(self) -> None:
        for row in self.rows:
            self.assertEqual("2026-10-23T10:30:00.000Z", row["emitted_at"])

    def test_rows_are_deterministic(self) -> None:
        again = rows_with_snapshot()
        self.assertEqual(
            [json.dumps(row, sort_keys=True) for row in self.rows],
            [json.dumps(row, sort_keys=True) for row in again],
        )


class CalibratedRulesRowTest(unittest.TestCase):
    """Row-level acceptance for calibration v2 (fixtures `session-repeat-window.jsonl`)."""

    def rows(self, snapshot):
        session = parse_session_file(REPEAT_SESSION, on_error=lambda _message: None)
        return build_rows([session], snapshot)

    def test_start_snapshot_counts_the_late_tool_as_a_ghost(self) -> None:
        rows = self.rows(load_schema_snapshot(SIDECAR))
        self.assertEqual(1, rows[0]["protocol_errors"]["tool_name_not_in_schema"])

    def test_union_snapshot_counts_zero_ghosts(self) -> None:
        union = merge_snapshots(
            load_schema_snapshot(SIDECAR), load_schema_snapshot(SECOND_SIDECAR)
        )
        rows = self.rows(union)
        self.assertEqual(0, rows[0]["protocol_errors"]["tool_name_not_in_schema"])

    def test_repeat_reads_account_for_only_the_in_window_gaps(self) -> None:
        union = merge_snapshots(
            load_schema_snapshot(SIDECAR), load_schema_snapshot(SECOND_SIDECAR)
        )
        rows = self.rows(union)
        self.assertEqual(2, rows[0]["protocol_errors"]["repeat_read_unchanged"])
        self.assertEqual(2, rows[0]["protocol_errors"]["total"])
        self.assertEqual(2, rows[0]["rules_version"])

    def test_replay_stays_on_the_single_on_disk_snapshot(self) -> None:
        # Decision 5: replay keeps the single sidecar basis and says so in the row.
        rows = self.rows(load_schema_snapshot(SIDECAR))
        self.assertEqual("snapshot-current", rows[0]["schema_basis"])
        self.assertTrue(rows[0]["schema_snapshot"])


class MergeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.ledger = os.path.join(self.tempdir.name, "parity.jsonl")

    def test_merge_writes_rows(self) -> None:
        rows = rows_with_snapshot()
        merged = merge_rows(self.ledger, ["fixture-session-0001"], rows)
        self.assertEqual(len(rows), len(merged))
        self.assertEqual(len(rows), len(read_ledger(self.ledger)))

    def test_merge_is_idempotent(self) -> None:
        rows = rows_with_snapshot()
        merge_rows(self.ledger, ["fixture-session-0001"], rows)
        with open(self.ledger, "rb") as handle:
            first = handle.read()
        merge_rows(self.ledger, ["fixture-session-0001"], rows_with_snapshot())
        with open(self.ledger, "rb") as handle:
            second = handle.read()
        self.assertEqual(first, second)

    def test_merge_keeps_other_sessions(self) -> None:
        write_ledger(
            self.ledger,
            [
                {
                    "schema_version": 1,
                    "session_id": "other-session",
                    "provider": "deepseek",
                    "model": "deepseek-flash",
                    "thinking": "high",
                    "req": 5,
                    "avg_input": 100.0,
                    "avg_cache_read": 10.0,
                    "avg_output": 20.0,
                    "reasoning": 40.0,
                    "cost_total": 1.5,
                }
            ],
        )
        merge_rows(self.ledger, ["fixture-session-0001"], rows_with_snapshot())
        session_ids = {row["session_id"] for row in read_ledger(self.ledger)}
        self.assertEqual({"other-session", "fixture-session-0001"}, session_ids)

    def test_merge_drops_stale_rows_of_covered_session(self) -> None:
        merge_rows(self.ledger, ["fixture-session-0001"], rows_with_snapshot())
        merge_rows(self.ledger, ["fixture-session-0001"], [])
        self.assertEqual([], read_ledger(self.ledger))

    def test_rows_are_sorted_by_session_and_group(self) -> None:
        merge_rows(self.ledger, ["fixture-session-0001"], rows_with_snapshot())
        rows = read_ledger(self.ledger)
        keys = [(row["session_id"], row["provider"], row["model"], row["thinking"]) for row in rows]
        self.assertEqual(sorted(keys), keys)

    def test_atomic_write_leaves_no_temp_files(self) -> None:
        merge_rows(self.ledger, ["fixture-session-0001"], rows_with_snapshot())
        leftovers = [name for name in os.listdir(self.tempdir.name) if name.startswith(".parity-")]
        self.assertEqual([], leftovers)

    def test_ledger_is_valid_jsonl_without_judgment_field(self) -> None:
        merge_rows(self.ledger, ["fixture-session-0001"], rows_with_snapshot())
        with io.open(self.ledger, encoding="utf-8") as handle:
            raw = handle.read()
        self.assertTrue(raw.endswith("\n"))
        self.assertEqual(0, raw.count("judgment_id"))
        for line in raw.splitlines():
            self.assertIsInstance(json.loads(line), dict)

    def test_corrupt_ledger_raises(self) -> None:
        with open(self.ledger, "w", encoding="utf-8") as handle:
            handle.write("{broken\n")
        with self.assertRaises(ValueError):
            read_ledger(self.ledger)


class CliSmokeTest(unittest.TestCase):
    """Command layer: replay writes, table reads, doctor reports, exit codes hold."""

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.sessions_dir = os.path.join(self.tempdir.name, "sessions")
        os.makedirs(self.sessions_dir)
        with open(SESSION, encoding="utf-8") as source:
            body = source.read()
        with open(
            os.path.join(self.sessions_dir, "fixture-session.jsonl"), "w", encoding="utf-8"
        ) as target:
            target.write(body)
        self.output = ""

    def run_main(self, *argv: str) -> int:
        from parity_meter.__main__ import main

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(io.StringIO()):
            code = main(list(argv))
        self.output = buffer.getvalue()
        return code

    def common(self) -> list[str]:
        return [
            "--sessions",
            self.sessions_dir,
            "--ledger",
            os.path.join(self.tempdir.name, "parity.jsonl"),
            "--schemas",
            SIDECAR,
        ]

    def test_replay_table_doctor_exit_zero(self) -> None:
        self.assertEqual(0, self.run_main("replay", "--last", "5", *self.common()))
        self.assertIn("=== aggregate over 1 sessions ===", self.output)
        self.assertEqual(0, self.run_main("table", *self.common()))
        self.assertIn("kimi-coding", self.output)
        self.assertEqual(0, self.run_main("doctor", *self.common()))
        self.assertIn("rows with protocol_errors.total>0: 2", self.output)
        self.assertIn("rules_version: 2", self.output)
        self.assertIn("repeat_window_sec: 900", self.output)

    def test_doctor_without_sidecar_reports_missing(self) -> None:
        argv = [
            "--sessions",
            self.sessions_dir,
            "--ledger",
            os.path.join(self.tempdir.name, "parity.jsonl"),
            "--schemas",
            os.path.join(self.tempdir.name, "absent.json"),
        ]
        self.assertEqual(0, self.run_main("doctor", *argv))
        self.assertIn("status: MISSING", self.output)

    def test_table_on_absent_ledger_reports_zero_rows(self) -> None:
        self.assertEqual(0, self.run_main("table", *self.common()))
        self.assertIn("rows=0", self.output)

    def test_negative_last_is_rejected(self) -> None:
        from parity_meter.__main__ import main

        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                main(["replay", "--last", "-1", *self.common()])


class AggregateTest(unittest.TestCase):
    def test_groups_and_sorts_by_cost(self) -> None:
        rows = rows_with_snapshot()
        groups = aggregate(rows)
        self.assertEqual(2, len(groups))
        self.assertEqual("kimi-coding", groups[0]["provider"])
        self.assertAlmostEqual(0.014, groups[0]["cost"])
        self.assertEqual(2, groups[0]["req"])
        self.assertEqual(1, groups[0]["sessions"])  # one row, one session

    def test_missing_numeric_fields_default_to_zero(self) -> None:
        groups = aggregate([{"provider": "p", "model": "m", "thinking": "low"}])
        self.assertEqual(0, groups[0]["req"])
        self.assertEqual(0.0, groups[0]["cost"])


if __name__ == "__main__":
    unittest.main()
