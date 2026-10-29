"""Deterministic protocol-error rules (n13-d1 test A, threshold 0).

Three rules only, no model judgment:

1. ``tool_name_not_in_schema`` - the assistant called a tool absent from the
   schema snapshot. Calibration v2: the live extension evaluates this against
   the union of the ``session_start`` and ``agent_end`` snapshots, so a tool
   registered mid-session is not a ghost.
2. ``args_fail_schema`` - the arguments fail the JSON Schema of that tool.
3. ``repeat_read_unchanged`` - a read of path P with no edit or write of P
   between two reads of P, inside ``REPEAT_WINDOW_SEC``. A repeat beyond the
   window is rational long-horizon behaviour and resets the anchor.

Calibration spec: `.docs/SPECS/harness-core/parity-meter-rule-calibration.md`.

Rule version 2. Version 1 counted every repeat read regardless of gap and judged
rule 1 against the single ``session_start`` snapshot; rows from the two eras
must never be mixed silently (RTL-09).

The validator is a stdlib subset of JSON Schema, not a full implementation.
Supported keywords: type, properties, required, additionalProperties, items,
enum, anyOf, oneOf, allOf, minimum, maximum, minLength, maxLength, pattern,
minItems, maxItems. Unknown keywords are ignored on purpose so a richer schema
never turns into a false violation.

Absent snapshot means protocol errors stay ``null`` in the row. A count
computed against no schema is fabricated (RTL-08), so ``evaluate`` returns
``None`` and never zero.
"""

from __future__ import annotations

import io
import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from .parse import ToolCall

SIDE_SCHEMA_VERSION = 1
SCHEMA_BASIS = "snapshot-current"
RULES_VERSION = 2

#: Repeat-read window in seconds, mirrored in ``schemas.ts`` as ``REPEAT_WINDOW_SEC``.
#: Declared, never tuned (RSI-08): the observed true positive was a 39s repeat,
#: the observed false positive was a 4.5h re-read.
REPEAT_WINDOW_SEC = 900

_TYPE_NAMES = {
    "string": str,
    "object": dict,
    "array": list,
    "boolean": bool,
    "null": type(None),
}


@dataclass(frozen=True)
class SchemaSnapshot:
    path: str
    schema_version: int
    captured_at: str | None
    tools: dict[str, dict[str, Any]] = field(default_factory=dict)


def _json_type_matches(expected: str, value: Any) -> bool:
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    python_type = _TYPE_NAMES.get(expected)
    if python_type is None:
        return True
    if python_type is bool:
        return isinstance(value, bool)
    return isinstance(value, python_type)


def _tool_schema(entry: Any) -> dict[str, Any]:
    if not isinstance(entry, dict):
        return {}
    for key in ("parameters", "schema", "inputSchema", "input_schema"):
        candidate = entry.get(key)
        if isinstance(candidate, dict):
            return candidate
    return {}


def _extract_tools(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw = payload.get("tools")
    tools: dict[str, dict[str, Any]] = {}
    if isinstance(raw, dict):
        for name, entry in raw.items():
            if not isinstance(name, str):
                continue
            tools[name] = entry if isinstance(entry, dict) and _looks_like_schema(entry) else _tool_schema(entry)
        return tools
    if isinstance(raw, list):
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name") or entry.get("tool")
            if not isinstance(name, str) or not name:
                continue
            tools[name] = _tool_schema(entry)
    return tools


def _looks_like_schema(entry: dict[str, Any]) -> bool:
    keys = {"type", "properties", "required", "items", "enum", "anyOf", "oneOf", "allOf"}
    return bool(keys & set(entry))


def merge_snapshots(
    earlier: SchemaSnapshot | None,
    later: SchemaSnapshot | None,
) -> SchemaSnapshot | None:
    """Union of two tool snapshots, the later one winning on a name collision.

    Rule 1 needs the union because a tool can be registered or dynamically
    exposed after ``session_start`` (live catch 01a16114: ``subagent_supervisor``
    was live but absent from the start snapshot). A name present in either
    snapshot is a live tool, so it is not a ghost.

    The live extension is the only producer of a second snapshot. Replay keeps
    validating against the single on-disk sidecar (calibration decision 5): it
    cannot reconstruct a late registration, and the sidecar it reads is already
    the union the extension wrote.
    """
    if earlier is None:
        return later
    if later is None:
        return earlier
    return SchemaSnapshot(
        path=later.path,
        schema_version=later.schema_version,
        captured_at=later.captured_at,
        tools={**earlier.tools, **later.tools},
    )


def load_schema_snapshot(path: str) -> SchemaSnapshot | None:
    """Load the sidecar. Returns ``None`` when the file is absent.

    Raises ``ValueError`` for an unreadable or malformed sidecar so the caller
    can report it. A silently empty snapshot would mask real violations.
    """
    if not os.path.exists(path):
        return None
    with io.open(path, encoding="utf-8") as handle:
        try:
            payload = json.load(handle)
        except ValueError as exc:
            raise ValueError(f"sidecar {path}: invalid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"sidecar {path}: root must be a JSON object")
    version = payload.get("schema_version", SIDE_SCHEMA_VERSION)
    captured_at = payload.get("captured_at")
    return SchemaSnapshot(
        path=path,
        schema_version=version if isinstance(version, int) else SIDE_SCHEMA_VERSION,
        captured_at=captured_at if isinstance(captured_at, str) else None,
        tools=_extract_tools(payload),
    )


def validate_arguments(schema: Any, value: Any, where: str = "arguments") -> list[str]:
    """Return human-readable violations of ``schema`` by ``value``."""
    if not isinstance(schema, dict):
        return []
    errors: list[str] = []
    expected_type = schema.get("type")
    if isinstance(expected_type, str):
        if not _json_type_matches(expected_type, value):
            return [f"{where}: expected {expected_type}"]
    elif isinstance(expected_type, list):
        if not any(isinstance(t, str) and _json_type_matches(t, value) for t in expected_type):
            return [f"{where}: expected one of {expected_type}"]

    enum = schema.get("enum")
    if isinstance(enum, list) and value not in enum:
        errors.append(f"{where}: value not in enum")

    if isinstance(value, dict):
        properties = schema.get("properties")
        properties = properties if isinstance(properties, dict) else {}
        required = schema.get("required")
        if isinstance(required, list):
            for key in required:
                if isinstance(key, str) and key not in value:
                    errors.append(f"{where}: missing required property {key!r}")
        for key, sub_schema in properties.items():
            if key in value:
                errors.extend(validate_arguments(sub_schema, value[key], f"{where}.{key}"))
        additional = schema.get("additionalProperties")
        if additional is False:
            for key in value:
                if key not in properties:
                    errors.append(f"{where}: unexpected property {key!r}")
        elif isinstance(additional, dict):
            for key, sub_value in value.items():
                if key not in properties:
                    errors.extend(validate_arguments(additional, sub_value, f"{where}.{key}"))

    if isinstance(value, list):
        items = schema.get("items")
        if isinstance(items, dict):
            for position, item in enumerate(value):
                errors.extend(validate_arguments(items, item, f"{where}[{position}]"))
        elif isinstance(items, list):
            for position, item in enumerate(value[: len(items)]):
                errors.extend(validate_arguments(items[position], item, f"{where}[{position}]"))
        min_items = schema.get("minItems")
        if isinstance(min_items, int) and len(value) < min_items:
            errors.append(f"{where}: fewer than {min_items} items")
        max_items = schema.get("maxItems")
        if isinstance(max_items, int) and len(value) > max_items:
            errors.append(f"{where}: more than {max_items} items")

    if isinstance(value, str):
        min_length = schema.get("minLength")
        if isinstance(min_length, int) and len(value) < min_length:
            errors.append(f"{where}: shorter than {min_length}")
        max_length = schema.get("maxLength")
        if isinstance(max_length, int) and len(value) > max_length:
            errors.append(f"{where}: longer than {max_length}")
        pattern = schema.get("pattern")
        if isinstance(pattern, str):
            try:
                if re.search(pattern, value) is None:
                    errors.append(f"{where}: does not match pattern {pattern!r}")
            except re.error:
                pass

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        minimum = schema.get("minimum")
        if isinstance(minimum, (int, float)) and value < minimum:
            errors.append(f"{where}: below minimum {minimum}")
        maximum = schema.get("maximum")
        if isinstance(maximum, (int, float)) and value > maximum:
            errors.append(f"{where}: above maximum {maximum}")

    any_of = schema.get("anyOf")
    if isinstance(any_of, list) and any_of:
        if not any(not validate_arguments(sub, value, where) for sub in any_of):
            errors.append(f"{where}: matches no anyOf branch")
    one_of = schema.get("oneOf")
    if isinstance(one_of, list) and one_of:
        matched = sum(1 for sub in one_of if not validate_arguments(sub, value, where))
        if matched != 1:
            errors.append(f"{where}: matches {matched} oneOf branches")
    all_of = schema.get("allOf")
    if isinstance(all_of, list):
        for sub in all_of:
            errors.extend(validate_arguments(sub, value, where))

    return errors


def tool_name_not_in_schema(calls: list[ToolCall], snapshot: SchemaSnapshot) -> int:
    return sum(1 for call in calls if call.name not in snapshot.tools)


def args_fail_schema(calls: list[ToolCall], snapshot: SchemaSnapshot) -> int:
    failures = 0
    for call in calls:
        schema = snapshot.tools.get(call.name)
        if schema is None:
            continue
        if validate_arguments(schema, call.arguments):
            failures += 1
    return failures


def _epoch_seconds(value: str | None) -> float | None:
    """Parse an ISO 8601 session timestamp into epoch seconds, ``None`` if unusable."""
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def repeat_read_unchanged(
    calls: list[ToolCall],
    window_sec: int = REPEAT_WINDOW_SEC,
) -> int:
    """Count reads of a path that no edit or write touched since the prior read.

    Only a repeat with a measurable gap of at most ``window_sec`` counts. A repeat
    beyond the window is not a violation and becomes the new anchor. A read whose
    timestamp is unknown stays counted: an unmeasurable gap is not evidence of
    rational long-horizon behaviour.
    """
    anchors: dict[str, float | None] = {}
    violations = 0
    for call in calls:
        arguments = call.arguments if isinstance(call.arguments, dict) else {}
        path = arguments.get("path")
        if not isinstance(path, str) or not path:
            continue
        if call.name == "read":
            if path in anchors:
                anchor = anchors[path]
                moment = _epoch_seconds(call.timestamp)
                if anchor is None or moment is None or moment - anchor <= window_sec:
                    violations += 1
            # Every read becomes the new anchor, counted or not: a repeat beyond the
            # window resets the baseline instead of accumulating a stale one.
            anchors[path] = _epoch_seconds(call.timestamp)
        elif call.name in ("edit", "write"):
            anchors.pop(path, None)
    return violations


def evaluate(calls: list[ToolCall], snapshot: SchemaSnapshot | None) -> dict[str, int] | None:
    """Return the protocol-error counters, or ``None`` when no snapshot exists."""
    if snapshot is None:
        return None
    by_name = tool_name_not_in_schema(calls, snapshot)
    by_args = args_fail_schema(calls, snapshot)
    by_repeat = repeat_read_unchanged(calls)
    return {
        "total": by_name + by_args + by_repeat,
        "tool_name_not_in_schema": by_name,
        "args_fail_schema": by_args,
        "repeat_read_unchanged": by_repeat,
    }
