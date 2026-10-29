"""Read pi session JSONL files into usage records and tool-call sequences.

Session format v3 writes one JSON object per line. Assistant turns carry the
provider, model, thinking level, token usage, and content blocks with tool
calls. A line that is not valid JSON is counted, reported, and skipped so the
batch keeps going (RTL-09 trace beats batch atomicity).

Provider and model come from the assistant message only. The reader does not
infer them from ``model_change`` events: inference would silently re-attribute
rows that the session itself left empty, and the ledger contract asks for
``unknown`` instead.
"""

from __future__ import annotations

import io
import json
import os
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator


@dataclass(frozen=True)
class Usage:
    input: int = 0
    cache_read: int = 0
    cache_write: int = 0
    output: int = 0
    reasoning: int = 0
    cost_total: float = 0.0
    cost_cache_read: float = 0.0
    cost_cache_write: float = 0.0
    cost_output: float = 0.0


@dataclass(frozen=True)
class UsageRecord:
    provider: str | None
    model: str | None
    thinking: str | None
    usage: Usage


@dataclass(frozen=True)
class ToolCall:
    name: str
    arguments: Any
    index: int
    # Session event timestamp, ISO 8601. The repeat-read rule needs it to measure
    # the gap between two reads of the same path; ``None`` when the line had none.
    timestamp: str | None = None


@dataclass
class SessionParse:
    path: str
    session_id: str
    usage_records: list[UsageRecord] = field(default_factory=list)
    tool_calls: list[ToolCall] = field(default_factory=list)
    parse_errors: int = 0
    last_timestamp: str | None = None


def _int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def usage_from_raw(raw: dict[str, Any] | None) -> Usage:
    raw = raw or {}
    cost = raw.get("cost") or {}
    return Usage(
        input=_int(raw.get("input")),
        cache_read=_int(raw.get("cacheRead")),
        cache_write=_int(raw.get("cacheWrite")),
        output=_int(raw.get("output")),
        reasoning=_int(raw.get("reasoning")),
        cost_total=_float(cost.get("total")),
        cost_cache_read=_float(cost.get("cacheRead")),
        cost_cache_write=_float(cost.get("cacheWrite")),
        cost_output=_float(cost.get("output")),
    )


def _text_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _stderr(message: str) -> None:
    print(message, file=sys.stderr)


def _session_id_from_path(path: str) -> str:
    stem = os.path.basename(path)
    if stem.endswith(".jsonl"):
        stem = stem[: -len(".jsonl")]
    if "_" in stem:
        return stem.split("_", 1)[1]
    return stem


def parse_session_file(
    path: str,
    on_error: Callable[[str], None] | None = None,
) -> SessionParse:
    """Parse one session file. Raises OSError when the file cannot be read."""
    report = on_error or _stderr
    result = SessionParse(path=path, session_id=_session_id_from_path(path))
    handle = io.open(path, encoding="utf-8")
    with handle:
        for lineno, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError as exc:
                result.parse_errors += 1
                report(f"{path}:{lineno}: unparsable session line: {exc}")
                continue
            if not isinstance(event, dict):
                result.parse_errors += 1
                report(f"{path}:{lineno}: session line is not a JSON object")
                continue
            timestamp = event.get("timestamp")
            if isinstance(timestamp, str):
                if result.last_timestamp is None or timestamp > result.last_timestamp:
                    result.last_timestamp = timestamp
            if event.get("type") == "session":
                session_id = event.get("id")
                if isinstance(session_id, str) and session_id:
                    result.session_id = session_id
                continue
            if event.get("type") != "message":
                continue
            message = event.get("message")
            if not isinstance(message, dict):
                continue
            if message.get("role") != "assistant":
                continue
            raw_usage = message.get("usage")
            if isinstance(raw_usage, dict):
                result.usage_records.append(
                    UsageRecord(
                        provider=_text_or_none(message.get("provider")),
                        model=_text_or_none(message.get("model")),
                        thinking=_text_or_none(message.get("thinkingLevel")),
                        usage=usage_from_raw(raw_usage),
                    )
                )
            content = message.get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "toolCall":
                    continue
                name = block.get("name")
                if not isinstance(name, str):
                    continue
                result.tool_calls.append(
                    ToolCall(
                        name=name,
                        arguments=block.get("arguments"),
                        index=len(result.tool_calls),
                        timestamp=timestamp if isinstance(timestamp, str) else None,
                    )
                )
    return result


def iter_session_files(root: str) -> Iterator[str]:
    """Yield session files under ``root``, newest first, ties broken by name."""
    found: list[tuple[float, str]] = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for filename in filenames:
            if not filename.endswith(".jsonl"):
                continue
            path = os.path.join(dirpath, filename)
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                continue
            found.append((mtime, path))
    found.sort(key=lambda item: (item[0], item[1]), reverse=True)
    for _mtime, path in found:
        yield path
