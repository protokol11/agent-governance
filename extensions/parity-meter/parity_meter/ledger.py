"""Ledger row schema, merge-by-session rewrite, atomic write.

The ledger is a projection, not an event log: ``merge_rows`` drops every row of
the sessions just covered and writes the recomputed rows. Re-running replay
converges instead of growing, and two runs over unchanged files produce
byte-identical output (RTL-08).

``emitted_at`` is derived from the session content (last event timestamp, then
file mtime), never from the wall clock. A clock would break the determinism
re-check on the second run.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import tempfile
from datetime import datetime, timezone
from typing import Any, Iterable

from .parse import SessionParse, ToolCall, usage_from_raw
from .rules import RULES_VERSION, SCHEMA_BASIS, SchemaSnapshot, evaluate

SCHEMA_VERSION = 1
UNKNOWN = "unknown"

FIELD_ORDER = (
    "schema_version",
    "rules_version",
    "session_id",
    "session_file",
    "provider",
    "model",
    "thinking",
    "attribution",
    "req",
    "avg_input",
    "avg_cache_read",
    "avg_output",
    "reasoning",
    "reasoning_share",
    "cost_total",
    "cost_cache_share",
    "cost_output_share",
    "protocol_errors",
    "tool_seq_sha",
    "tool_seq_len",
    "parse_errors",
    "schema_snapshot",
    "schema_basis",
    "emitted_at",
)


def attribution_of(provider: str | None, model: str | None) -> str:
    """full when provider and model are known, unknown when both are missing."""
    if provider and model:
        return "full"
    if provider or model:
        return "partial"
    return "unknown"


def tool_sequence_sha(calls: Iterable[ToolCall]) -> str:
    names = "\n".join(call.name for call in calls)
    return hashlib.sha256(names.encode("utf-8")).hexdigest()


def _ratio(numerator: float, denominator: float) -> float:
    if not denominator:
        return 0.0
    return round(numerator / denominator, 6)


def _mean(total: float, count: int) -> float:
    if not count:
        return 0.0
    return round(total / count, 4)


def _emitted_at(session: SessionParse) -> str:
    if session.last_timestamp:
        return session.last_timestamp
    try:
        mtime = os.path.getmtime(session.path)
    except OSError:
        return "1970-01-01T00:00:00Z"
    return datetime.fromtimestamp(mtime, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def build_rows(
    sessions: Iterable[SessionParse],
    snapshot: SchemaSnapshot | None,
) -> list[dict[str, Any]]:
    """Build one row per (session, provider, model, thinking) group."""
    rows: list[dict[str, Any]] = []
    for session in sessions:
        groups: dict[tuple[str, str, str], list[Any]] = {}
        for record in session.usage_records:
            key = (
                record.provider or UNKNOWN,
                record.model or UNKNOWN,
                record.thinking or UNKNOWN,
            )
            groups.setdefault(key, []).append(record)
        protocol_errors = evaluate(session.tool_calls, snapshot)
        sequence_sha = tool_sequence_sha(session.tool_calls)
        emitted_at = _emitted_at(session)
        for key in sorted(groups):
            provider, model, thinking = key
            records = groups[key]
            usages = [record.usage for record in records]
            count = len(usages)
            input_total = sum(usage.input + usage.cache_read for usage in usages)
            cache_read_total = sum(usage.cache_read for usage in usages)
            output_total = sum(usage.output for usage in usages)
            reasoning_total = sum(usage.reasoning for usage in usages)
            cost_total = round(sum(usage.cost_total for usage in usages), 6)
            cost_cache_total = sum(
                usage.cost_cache_read + usage.cost_cache_write for usage in usages
            )
            cost_output_total = sum(usage.cost_output for usage in usages)
            row: dict[str, Any] = {
                "schema_version": SCHEMA_VERSION,
                "rules_version": RULES_VERSION,
                "session_id": session.session_id,
                "session_file": os.path.basename(session.path),
                "provider": provider,
                "model": model,
                "thinking": thinking,
                "attribution": attribution_of(
                    None if provider == UNKNOWN else provider,
                    None if model == UNKNOWN else model,
                ),
                "req": count,
                "avg_input": _mean(input_total, count),
                "avg_cache_read": _mean(cache_read_total, count),
                "avg_output": _mean(output_total, count),
                "reasoning": reasoning_total,
                "reasoning_share": _ratio(reasoning_total, output_total),
                "cost_total": cost_total,
                "cost_cache_share": _ratio(cost_cache_total, cost_total),
                "cost_output_share": _ratio(cost_output_total, cost_total),
                "protocol_errors": dict(protocol_errors) if protocol_errors is not None else None,
                "tool_seq_sha": sequence_sha,
                "tool_seq_len": len(session.tool_calls),
                "parse_errors": session.parse_errors,
                "schema_snapshot": protocol_errors is not None,
                "schema_basis": SCHEMA_BASIS,
                "emitted_at": emitted_at,
            }
            rows.append({field: row[field] for field in FIELD_ORDER})
    return rows


def read_ledger(path: str) -> list[dict[str, Any]]:
    """Read ledger rows. A corrupt ledger line raises; the ledger is our output."""
    if not os.path.exists(path):
        return []
    rows: list[dict[str, Any]] = []
    with io.open(path, encoding="utf-8") as handle:
        for lineno, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except ValueError as exc:
                raise ValueError(f"ledger {path}:{lineno}: invalid JSON: {exc}") from exc
            if not isinstance(row, dict):
                raise ValueError(f"ledger {path}:{lineno}: row is not a JSON object")
            rows.append(row)
    return rows


def _sort_key(row: dict[str, Any]) -> tuple[str, str, str, str]:
    return (
        str(row.get("session_id", "")),
        str(row.get("provider", "")),
        str(row.get("model", "")),
        str(row.get("thinking", "")),
    )


def merge_rows(
    path: str,
    covered_sessions: Iterable[str],
    new_rows: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Rewrite rows for the covered sessions and return the merged ledger."""
    covered = set(covered_sessions)
    kept = [row for row in read_ledger(path) if row.get("session_id") not in covered]
    merged = kept + [row for row in new_rows]
    merged.sort(key=_sort_key)
    write_ledger(path, merged)
    return merged


def write_ledger(path: str, rows: Iterable[dict[str, Any]]) -> None:
    """Write the ledger atomically: temp file in the same directory, then rename."""
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    body = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows)
    handle, temp_path = tempfile.mkstemp(dir=directory, prefix=".parity-", suffix=".jsonl")
    try:
        with io.open(handle, "w", encoding="utf-8", newline="\n") as handle_io:
            handle_io.write(body)
        os.replace(temp_path, path)
    except BaseException:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
        raise


def aggregate(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group ledger rows by (provider, model, thinking) for the printed table."""
    groups: dict[tuple[str, str, str], dict[str, Any]] = {}
    for row in rows:
        key = (
            str(row.get("provider", UNKNOWN)),
            str(row.get("model", UNKNOWN)),
            str(row.get("thinking", UNKNOWN)),
        )
        group = groups.setdefault(
            key,
            {
                "provider": key[0],
                "model": key[1],
                "thinking": key[2],
                "req": 0,
                "input": 0.0,
                "cache_read": 0.0,
                "output": 0.0,
                "reasoning": 0.0,
                "cost": 0.0,
                "sessions": 0,
            },
        )
        count = int(row.get("req") or 0)
        group["req"] += count
        group["input"] += float(row.get("avg_input") or 0.0) * count
        group["cache_read"] += float(row.get("avg_cache_read") or 0.0) * count
        group["output"] += float(row.get("avg_output") or 0.0) * count
        group["reasoning"] += float(row.get("reasoning") or 0.0)
        group["cost"] += float(row.get("cost_total") or 0.0)
        group["sessions"] += 1
    return sorted(groups.values(), key=lambda group: (-group["cost"], group["provider"], group["model"]))


# Re-exported for callers that only import the ledger module.
__all__ = [
    "SCHEMA_VERSION",
    "UNKNOWN",
    "FIELD_ORDER",
    "aggregate",
    "attribution_of",
    "build_rows",
    "merge_rows",
    "read_ledger",
    "tool_sequence_sha",
    "usage_from_raw",
    "write_ledger",
]
