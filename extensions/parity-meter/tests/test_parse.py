"""Tests for the session JSONL reader."""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from parity_meter.parse import (
    UsageRecord,
    usage_from_raw,
    iter_session_files,
    parse_session_file,
)

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
FIXTURE_SESSION = os.path.join(FIXTURES, "session-with-errors.jsonl")


class ParseFixtureTest(unittest.TestCase):
    def setUp(self) -> None:
        self.reported: list[str] = []
        self.session = parse_session_file(FIXTURE_SESSION, on_error=self.reported.append)

    def test_session_id_comes_from_session_line(self) -> None:
        self.assertEqual("fixture-session-0001", self.session.session_id)

    def test_usage_records_are_collected(self) -> None:
        self.assertEqual(3, len(self.session.usage_records))
        first = self.session.usage_records[0]
        self.assertIsInstance(first, UsageRecord)
        self.assertEqual("kimi-coding", first.provider)
        self.assertEqual("kimi-for-coding", first.model)
        self.assertEqual("low", first.thinking)
        self.assertEqual(1000, first.usage.input)
        self.assertEqual(500, first.usage.cache_read)
        self.assertEqual(20, first.usage.reasoning)
        self.assertAlmostEqual(0.01, first.usage.cost_total)

    def test_missing_provider_stays_none(self) -> None:
        second = self.session.usage_records[1]
        self.assertIsNone(second.provider)
        self.assertIsNone(second.model)
        self.assertIsNone(second.thinking)

    def test_model_change_event_is_not_used_for_attribution(self) -> None:
        # The fixture has a model_change to deepseek before an unattributed turn.
        providers = [record.provider for record in self.session.usage_records]
        self.assertNotIn("deepseek", providers)

    def test_tool_calls_keep_order(self) -> None:
        names = [call.name for call in self.session.tool_calls]
        self.assertEqual(["read", "read", "ghost_tool", "read"], names)
        self.assertEqual([0, 1, 2, 3], [call.index for call in self.session.tool_calls])
        self.assertEqual({"path": "a.txt"}, self.session.tool_calls[0].arguments)

    def test_tool_calls_carry_the_event_timestamp(self) -> None:
        # The repeat-read window needs the gap between two reads of the same path.
        self.assertEqual(
            ["2026-10-23T10:27:38.963Z", "2026-10-23T10:28:00.000Z", "2026-10-23T10:29:00.000Z", "2026-10-23T10:29:00.000Z"],
            [call.timestamp for call in self.session.tool_calls],
        )

    def test_corrupt_line_is_counted_and_reported(self) -> None:
        self.assertEqual(1, self.session.parse_errors)
        self.assertEqual(1, len(self.reported))
        self.assertIn("session-with-errors.jsonl:5", self.reported[0])

    def test_last_timestamp_is_latest_event(self) -> None:
        self.assertEqual("2026-10-23T10:30:00.000Z", self.session.last_timestamp)

    def test_user_turn_without_usage_is_skipped(self) -> None:
        self.assertEqual(3, len(self.session.usage_records))

    def test_reparse_is_deterministic(self) -> None:
        again = parse_session_file(FIXTURE_SESSION, on_error=lambda _msg: None)
        self.assertEqual(self.session.usage_records, again.usage_records)
        self.assertEqual(self.session.tool_calls, again.tool_calls)


class UsageFromRawTest(unittest.TestCase):
    def test_empty_usage_yields_zeros(self) -> None:
        usage = usage_from_raw(None)
        self.assertEqual(0, usage.input)
        self.assertEqual(0.0, usage.cost_total)

    def test_string_numbers_are_coerced(self) -> None:
        usage = usage_from_raw({"input": "12", "output": None, "cost": {"total": "0.5"}})
        self.assertEqual(12, usage.input)
        self.assertEqual(0, usage.output)
        self.assertAlmostEqual(0.5, usage.cost_total)


class MissingFileTest(unittest.TestCase):
    def test_unreadable_file_raises_oserror(self) -> None:
        with self.assertRaises(OSError):
            parse_session_file(os.path.join(FIXTURES, "absent.jsonl"))


class IterSessionFilesTest(unittest.TestCase):
    def test_newest_file_first(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            older = os.path.join(root, "cat-a", "older.jsonl")
            newer = os.path.join(root, "cat-b", "newer.jsonl")
            os.makedirs(os.path.dirname(older))
            os.makedirs(os.path.dirname(newer))
            with open(older, "w", encoding="utf-8") as handle:
                handle.write("{}\n")
            with open(newer, "w", encoding="utf-8") as handle:
                handle.write("{}\n")
            os.utime(older, (1_000_000, 1_000_000))
            os.utime(newer, (2_000_000, 2_000_000))
            self.assertEqual([newer, older], list(iter_session_files(root)))

    def test_non_jsonl_files_are_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            with open(os.path.join(root, "notes.txt"), "w", encoding="utf-8") as handle:
                handle.write("ignored\n")
            self.assertEqual([], list(iter_session_files(root)))

    def test_missing_root_yields_nothing(self) -> None:
        self.assertEqual([], list(iter_session_files(os.path.join(FIXTURES, "no-such-dir"))))


class CorruptBatchTest(unittest.TestCase):
    def test_corrupt_line_does_not_abort_parse(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "broken.jsonl")
            lines = [
                {"type": "session", "id": "broken-1"},
                {"type": "message", "message": {"role": "assistant", "usage": {"input": 5}}},
            ]
            with open(path, "w", encoding="utf-8") as handle:
                for event in lines:
                    handle.write(json.dumps(event) + "\n")
                handle.write("{oops\n")
                handle.write("[1, 2, 3]\n")
                handle.write(json.dumps({"type": "message", "message": {"role": "assistant", "usage": {"input": 7}}}) + "\n")
            reported: list[str] = []
            session = parse_session_file(path, on_error=reported.append)
            self.assertEqual("broken-1", session.session_id)
            self.assertEqual(2, len(session.usage_records))
            self.assertEqual(2, session.parse_errors)
            self.assertEqual(2, len(reported))


if __name__ == "__main__":
    unittest.main()
