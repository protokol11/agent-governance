"""Tests for the three deterministic protocol-error rules."""

from __future__ import annotations

import os
import tempfile
import unittest

from parity_meter.parse import ToolCall
from parity_meter.rules import (
    REPEAT_WINDOW_SEC,
    RULES_VERSION,
    SchemaSnapshot,
    args_fail_schema,
    evaluate,
    load_schema_snapshot,
    merge_snapshots,
    repeat_read_unchanged,
    tool_name_not_in_schema,
    validate_arguments,
)

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
SIDECAR = os.path.join(FIXTURES, "tool-schemas.json")
SECOND_SIDECAR = os.path.join(FIXTURES, "tool-schemas-second.json")
REPEAT_SESSION = os.path.join(FIXTURES, "session-repeat-window.jsonl")

READ_SCHEMA = {
    "type": "object",
    "properties": {"path": {"type": "string"}},
    "required": ["path"],
    "additionalProperties": False,
}


def snapshot() -> SchemaSnapshot:
    return SchemaSnapshot(
        path="<memory>",
        schema_version=1,
        captured_at="2026-10-23T10:00:00.000Z",
        tools={"read": READ_SCHEMA, "edit": {"type": "object"}, "write": {"type": "object"}},
    )


def call(name: str, index: int = 0, timestamp: str | None = None, **arguments) -> ToolCall:
    return ToolCall(
        name=name,
        arguments=arguments or None,
        index=index,
        timestamp=timestamp,
    )


class ToolNameRuleTest(unittest.TestCase):
    def test_unknown_tool_is_counted(self) -> None:
        calls = [call("read", 0, path="a.txt"), call("ghost_tool", 1)]
        self.assertEqual(1, tool_name_not_in_schema(calls, snapshot()))

    def test_known_tools_pass(self) -> None:
        calls = [call("read", 0, path="a.txt"), call("edit", 1, path="a.txt", edits=[])]
        self.assertEqual(0, tool_name_not_in_schema(calls, snapshot()))


class ArgsSchemaRuleTest(unittest.TestCase):
    def test_wrong_argument_type_is_counted(self) -> None:
        calls = [call("read", 0, path=42)]
        self.assertEqual(1, args_fail_schema(calls, snapshot()))

    def test_missing_required_argument_is_counted(self) -> None:
        calls = [call("read", 0)]
        self.assertEqual(1, args_fail_schema(calls, snapshot()))

    def test_unexpected_argument_is_counted(self) -> None:
        calls = [call("read", 0, path="a.txt", surprise=True)]
        self.assertEqual(1, args_fail_schema(calls, snapshot()))

    def test_valid_arguments_pass(self) -> None:
        calls = [call("read", 0, path="a.txt")]
        self.assertEqual(0, args_fail_schema(calls, snapshot()))

    def test_unknown_tool_is_not_double_counted_by_args_rule(self) -> None:
        calls = [call("ghost_tool", 0, anything=1)]
        self.assertEqual(0, args_fail_schema(calls, snapshot()))


class RepeatReadRuleTest(unittest.TestCase):
    def test_second_read_without_change_is_counted(self) -> None:
        calls = [call("read", 0, path="a.txt"), call("read", 1, path="a.txt")]
        self.assertEqual(1, repeat_read_unchanged(calls))

    def test_edit_between_reads_clears_violation(self) -> None:
        calls = [
            call("read", 0, path="a.txt"),
            call("edit", 1, path="a.txt", edits=[]),
            call("read", 2, path="a.txt"),
        ]
        self.assertEqual(0, repeat_read_unchanged(calls))

    def test_write_between_reads_clears_violation(self) -> None:
        calls = [
            call("read", 0, path="a.txt"),
            call("write", 1, path="a.txt", content="x"),
            call("read", 2, path="a.txt"),
        ]
        self.assertEqual(0, repeat_read_unchanged(calls))

    def test_edit_of_other_path_does_not_clear_violation(self) -> None:
        calls = [
            call("read", 0, path="a.txt"),
            call("edit", 1, path="b.txt", edits=[]),
            call("read", 2, path="a.txt"),
        ]
        self.assertEqual(1, repeat_read_unchanged(calls))

    def test_different_paths_pass(self) -> None:
        calls = [call("read", 0, path="a.txt"), call("read", 1, path="b.txt")]
        self.assertEqual(0, repeat_read_unchanged(calls))

    def test_three_reads_of_same_path_count_twice(self) -> None:
        calls = [call("read", index, path="a.txt") for index in range(3)]
        self.assertEqual(2, repeat_read_unchanged(calls))

    def test_tool_call_without_path_is_ignored(self) -> None:
        calls = [call("read", 0), call("read", 1)]
        self.assertEqual(0, repeat_read_unchanged(calls))


class RepeatReadWindowTest(unittest.TestCase):
    """Calibration v2 (spec `parity-meter-rule-calibration`, decision 1 and 4)."""

    def test_window_constant_is_declared_value(self) -> None:
        self.assertEqual(900, REPEAT_WINDOW_SEC)

    def test_rules_version_is_two(self) -> None:
        self.assertEqual(2, RULES_VERSION)

    def test_39s_repeat_counts(self) -> None:
        calls = [
            call("read", 0, "2026-10-23T09:00:00.000Z", path="a.txt"),
            call("read", 1, "2026-10-23T09:00:39.000Z", path="a.txt"),
        ]
        self.assertEqual(1, repeat_read_unchanged(calls))

    def test_gap_at_window_boundary_counts(self) -> None:
        calls = [
            call("read", 0, "2026-10-23T09:00:00.000Z", path="a.txt"),
            call("read", 1, "2026-10-23T09:15:00.000Z", path="a.txt"),
        ]
        self.assertEqual(1, repeat_read_unchanged(calls))

    def test_gap_beyond_window_does_not_count(self) -> None:
        calls = [
            call("read", 0, "2026-10-23T09:00:00.000Z", path="a.txt"),
            call("read", 1, "2026-10-23T13:30:00.000Z", path="a.txt"),
        ]
        self.assertEqual(0, repeat_read_unchanged(calls))

    def test_read_beyond_window_resets_the_anchor(self) -> None:
        # 09:00 -> 09:30 (1800s, no count) -> 09:30:20 (20s, counts): the far read
        # becomes the new baseline, it does not leave the stale 09:00 anchor in place.
        calls = [
            call("read", 0, "2026-10-23T09:00:00.000Z", path="a.txt"),
            call("read", 1, "2026-10-23T09:30:00.000Z", path="a.txt"),
            call("read", 2, "2026-10-23T09:30:20.000Z", path="a.txt"),
        ]
        self.assertEqual(1, repeat_read_unchanged(calls))

    def test_unknown_timestamp_stays_counted(self) -> None:
        calls = [call("read", 0, path="a.txt"), call("read", 1, path="a.txt")]
        self.assertEqual(1, repeat_read_unchanged(calls))

    def test_window_is_a_parameter(self) -> None:
        calls = [
            call("read", 0, "2026-10-23T09:00:00.000Z", path="a.txt"),
            call("read", 1, "2026-10-23T09:00:39.000Z", path="a.txt"),
        ]
        self.assertEqual(0, repeat_read_unchanged(calls, window_sec=30))


class LateRegisteredToolTest(unittest.TestCase):
    """Calibration v2 rule 1: ghosts are counted against the snapshot union."""

    def test_tool_only_in_second_snapshot_is_not_a_ghost(self) -> None:
        start = load_schema_snapshot(SIDECAR)
        end = load_schema_snapshot(SECOND_SIDECAR)
        assert start is not None and end is not None
        calls = [call("subagent_supervisor", 0, prompt="go")]
        self.assertEqual(1, tool_name_not_in_schema(calls, start))
        union = merge_snapshots(start, end)
        assert union is not None
        self.assertEqual(0, tool_name_not_in_schema(calls, union))

    def test_union_keeps_both_sides(self) -> None:
        start = load_schema_snapshot(SIDECAR)
        end = load_schema_snapshot(SECOND_SIDECAR)
        assert start is not None and end is not None
        union = merge_snapshots(start, end)
        assert union is not None
        self.assertEqual({"read", "edit", "write", "subagent_supervisor"}, set(union.tools))

    def test_union_prefers_the_later_schema(self) -> None:
        earlier = SchemaSnapshot(path="a", schema_version=1, captured_at=None, tools={"read": {"type": "object"}})
        later = SchemaSnapshot(
            path="b",
            schema_version=1,
            captured_at="2026-10-23T11:00:00.000Z",
            tools={"read": {"type": "string"}, "grep": {"type": "object"}},
        )
        union = merge_snapshots(earlier, later)
        assert union is not None
        self.assertEqual({"type": "string"}, union.tools["read"])
        self.assertEqual({"type": "object"}, union.tools["grep"])

    def test_union_with_missing_side_returns_the_other(self) -> None:
        start = load_schema_snapshot(SIDECAR)
        assert start is not None
        self.assertIs(start, merge_snapshots(start, None))
        self.assertIs(start, merge_snapshots(None, start))
        self.assertIsNone(merge_snapshots(None, None))

    def test_repeat_fixture_counts_two_repeats_inside_window(self) -> None:
        from parity_meter.parse import parse_session_file

        session = parse_session_file(REPEAT_SESSION, on_error=lambda _message: None)
        self.assertEqual(2, repeat_read_unchanged(session.tool_calls))


class EvaluateTest(unittest.TestCase):
    def test_absent_snapshot_returns_none(self) -> None:
        calls = [call("ghost_tool", 0)]
        self.assertIsNone(evaluate(calls, None))

    def test_counters_sum_into_total(self) -> None:
        calls = [
            call("read", 0, path="a.txt"),
            call("read", 1, path="a.txt"),
            call("ghost_tool", 2),
            call("read", 3, path=42),
        ]
        result = evaluate(calls, snapshot())
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(1, result["tool_name_not_in_schema"])
        self.assertEqual(1, result["args_fail_schema"])
        self.assertEqual(1, result["repeat_read_unchanged"])
        self.assertEqual(3, result["total"])

    def test_clean_session_reports_zero_not_none(self) -> None:
        result = evaluate([call("read", 0, path="a.txt")], snapshot())
        self.assertEqual(
            {"total": 0, "tool_name_not_in_schema": 0, "args_fail_schema": 0, "repeat_read_unchanged": 0},
            result,
        )


class ValidateArgumentsTest(unittest.TestCase):
    def test_type_mismatch(self) -> None:
        self.assertTrue(validate_arguments({"type": "string"}, 1))

    def test_type_union_accepts_member(self) -> None:
        self.assertEqual([], validate_arguments({"type": ["string", "null"]}, None))

    def test_enum(self) -> None:
        schema = {"enum": ["low", "high"]}
        self.assertEqual([], validate_arguments(schema, "low"))
        self.assertTrue(validate_arguments(schema, "medium"))

    def test_nested_object(self) -> None:
        schema = {
            "type": "object",
            "properties": {"edits": {"type": "array", "items": {"type": "object"}}},
        }
        self.assertEqual([], validate_arguments(schema, {"edits": [{"oldText": "a"}]}))
        self.assertTrue(validate_arguments(schema, {"edits": ["nope"]}))

    def test_any_of(self) -> None:
        schema = {"anyOf": [{"type": "string"}, {"type": "integer"}]}
        self.assertEqual([], validate_arguments(schema, 3))
        self.assertTrue(validate_arguments(schema, 3.5))

    def test_unknown_keywords_are_ignored(self) -> None:
        self.assertEqual([], validate_arguments({"$ref": "#/definitions/x"}, "anything"))

    def test_empty_schema_accepts_anything(self) -> None:
        self.assertEqual([], validate_arguments({}, {"free": "form"}))


class LoadSchemaSnapshotTest(unittest.TestCase):
    def test_fixture_sidecar_loads(self) -> None:
        loaded = load_schema_snapshot(SIDECAR)
        self.assertIsNotNone(loaded)
        assert loaded is not None
        self.assertEqual(1, loaded.schema_version)
        self.assertEqual({"read", "edit", "write"}, set(loaded.tools))
        self.assertEqual(READ_SCHEMA, loaded.tools["read"])

    def test_absent_sidecar_returns_none(self) -> None:
        self.assertIsNone(load_schema_snapshot(os.path.join(FIXTURES, "absent.json")))

    def test_malformed_sidecar_raises(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "tool-schemas.json")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("{not json")
            with self.assertRaises(ValueError):
                load_schema_snapshot(path)

    def test_dict_shaped_tools_are_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "tool-schemas.json")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write('{"schema_version": 1, "tools": {"read": {"parameters": {"type": "object"}}}}')
            loaded = load_schema_snapshot(path)
            assert loaded is not None
            self.assertEqual({"type": "object"}, loaded.tools["read"])


if __name__ == "__main__":
    unittest.main()
