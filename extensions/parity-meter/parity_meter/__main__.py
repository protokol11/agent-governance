"""CLI entry point: replay, table, doctor.

The replay printout keeps the meter-v0 column layout so the 2026-10-23
baseline stays comparable (see README, "Table format").
"""

from __future__ import annotations

import argparse
import os
import sys
from itertools import islice
from typing import Any, Iterable

from . import __version__
from .ledger import (
    SCHEMA_VERSION,
    UNKNOWN,
    aggregate,
    build_rows,
    merge_rows,
    read_ledger,
)
from .parse import SessionParse, iter_session_files, parse_session_file
from .rules import REPEAT_WINDOW_SEC, RULES_VERSION, load_schema_snapshot

DEFAULT_SESSIONS = "~/.pi/agent/sessions"
DEFAULT_LEDGER = "~/.pi/agent/parity.jsonl"
DEFAULT_SCHEMAS = "~/.pi/agent/parity-meter/tool-schemas.json"
DEFAULT_LAST = 40


def _expand(path: str) -> str:
    return os.path.expanduser(path)


def _warn(message: str) -> None:
    print(message, file=sys.stderr)


def _load_snapshot(path: str):
    try:
        return load_schema_snapshot(path)
    except ValueError as exc:
        _warn(f"sidecar unusable, protocol errors stay null: {exc}")
        return None


def _percent(numerator: float, denominator: float) -> float:
    return 100.0 * numerator / denominator if denominator else 0.0


def _print_session_row(row: dict[str, Any]) -> None:
    count = int(row["req"])
    input_total = float(row["avg_input"]) * count
    cache_read_total = float(row["avg_cache_read"]) * count
    output_total = float(row["avg_output"]) * count
    reasoning_total = float(row["reasoning"])
    print(
        f"{str(row['session_file'])[:24]:24} {str(row['provider']):10} {str(row['model']):18} "
        f"think={str(row['thinking']):6} req={count:3} in={int(round(input_total)):8} "
        f"cacheRead={int(round(cache_read_total)):8} "
        f"({_percent(cache_read_total, input_total):5.1f}%) out={int(round(output_total)):6} "
        f"reasoning={int(round(reasoning_total)):6} "
        f"({_percent(reasoning_total, output_total):4.1f}%) cost=${float(row['cost_total']):.4f}"
    )


def _print_aggregate(groups: Iterable[dict[str, Any]]) -> None:
    for group in groups:
        print(
            f"{str(group['provider']):10} {str(group['model']):18} think={str(group['thinking']):6} "
            f"req={group['req']:4} cacheRead={_percent(group['cache_read'], group['input']):5.1f}% "
            f"reasoning={_percent(group['reasoning'], group['output']):4.1f}% cost=${group['cost']:.4f}"
        )


def _parse_sessions(files: Iterable[str]) -> list[SessionParse]:
    parsed: list[SessionParse] = []
    for path in files:
        try:
            parsed.append(parse_session_file(path))
        except OSError as exc:
            _warn(f"cannot read session file, no row emitted: {exc}")
    return parsed


def command_replay(args: argparse.Namespace) -> int:
    sessions_dir = _expand(args.sessions)
    ledger_path = _expand(args.ledger)
    snapshot = _load_snapshot(_expand(args.schemas))
    if snapshot is None:
        _warn(
            f"no schema snapshot at {_expand(args.schemas)}: protocol_errors=null, schema_snapshot=false"
        )
    files = list(islice(iter_session_files(sessions_dir), args.last))
    if not files:
        _warn(f"no session files under {sessions_dir}")
        return 0
    parsed = _parse_sessions(files)
    rows = build_rows(parsed, snapshot)
    covered = [session.session_id for session in parsed]
    merge_rows(ledger_path, covered, rows)

    with_usage = [session for session in parsed if session.usage_records]
    for row in rows:
        _print_session_row(row)
    print("\n=== aggregate over", len(with_usage), "sessions ===")
    _print_aggregate(aggregate(rows))
    print(f"\nledger: {ledger_path} ({len(rows)} rows written for {len(covered)} sessions)")
    return 0


def _recent_sessions(rows: list[dict[str, Any]], last: int | None) -> list[dict[str, Any]]:
    if last is None:
        return rows
    newest: dict[str, str] = {}
    for row in rows:
        session_id = str(row.get("session_id", ""))
        emitted_at = str(row.get("emitted_at", ""))
        if emitted_at > newest.get(session_id, ""):
            newest[session_id] = emitted_at
    keep = {
        session_id
        for session_id, _stamp in sorted(newest.items(), key=lambda item: (item[1], item[0]), reverse=True)[
            :last
        ]
    }
    return [row for row in rows if str(row.get("session_id", "")) in keep]


def command_table(args: argparse.Namespace) -> int:
    ledger_path = _expand(args.ledger)
    try:
        rows = read_ledger(ledger_path)
    except ValueError as exc:
        _warn(f"ledger unreadable: {exc}")
        return 1
    selected = _recent_sessions(rows, args.last)
    groups = aggregate(selected)
    print(f"ledger: {ledger_path} rows={len(rows)} shown={len(selected)}")
    _print_aggregate(groups)
    unknown_rows = [row for row in selected if row.get("attribution") == "unknown"]
    if unknown_rows:
        unknown_cost = sum(float(row.get("cost_total") or 0.0) for row in unknown_rows)
        print(
            f"\nunknown attribution: {len(unknown_rows)} rows, "
            f"cost=${unknown_cost:.4f} counted under {UNKNOWN}/{UNKNOWN}"
        )
    return 0


def command_doctor(args: argparse.Namespace) -> int:
    sessions_dir = _expand(args.sessions)
    ledger_path = _expand(args.ledger)
    schemas_path = _expand(args.schemas)
    print(f"parity-meter {__version__}")
    print(f"python: {sys.version.split()[0]}")
    print(f"rules_version: {RULES_VERSION}")
    print(f"repeat_window_sec: {REPEAT_WINDOW_SEC}")

    files = list(iter_session_files(sessions_dir))
    print(f"sessions_dir: {sessions_dir} exists={os.path.isdir(sessions_dir)} files={len(files)}")

    print(f"sidecar: {schemas_path} present={os.path.exists(schemas_path)}")
    snapshot = _load_snapshot(schemas_path)
    if snapshot is None:
        print("  status: MISSING - replay rows carry schema_snapshot=false and protocol_errors=null")
    else:
        print(f"  schema_version: {snapshot.schema_version}")
        print(f"  captured_at: {snapshot.captured_at}")
        print(f"  tools: {len(snapshot.tools)}")
        if snapshot.tools:
            print("  tool names: " + ", ".join(sorted(snapshot.tools)))

    try:
        rows = read_ledger(ledger_path)
    except ValueError as exc:
        _warn(f"ledger unreadable: {exc}")
        return 1
    print(f"ledger: {ledger_path} present={os.path.exists(ledger_path)} rows={len(rows)}")
    versions = sorted({row.get("schema_version") for row in rows}, key=str)
    print(f"  schema_version seen: {versions if versions else 'none'}")
    rule_versions = sorted({row.get("rules_version") for row in rows}, key=str)
    print(f"  rules_version seen: {rule_versions if rule_versions else 'none'}")
    no_snapshot = [row for row in rows if row.get("schema_snapshot") is False]
    print(f"  rows with schema_snapshot=false: {len(no_snapshot)}")
    unknown_rows = [row for row in rows if row.get("attribution") == "unknown"]
    print(f"  rows with attribution=unknown: {len(unknown_rows)}")
    error_rows = [row for row in rows if (row.get("protocol_errors") or {}).get("total")]
    print(f"  rows with protocol_errors.total>0: {len(error_rows)}")
    bad_version = [row for row in rows if row.get("schema_version") != SCHEMA_VERSION]
    if bad_version:
        print(f"  WARNING rows with schema_version != {SCHEMA_VERSION}: {len(bad_version)}")
    # Pre-calibration rows stay in the ledger untouched (decision 5); the count
    # is printed so a mixed table is never read as one calibrated series.
    stale_rules = [row for row in rows if row.get("rules_version") != RULES_VERSION]
    if stale_rules:
        print(f"  rows with rules_version != {RULES_VERSION}: {len(stale_rules)}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="parity_meter",
        description="Offline replay engine for pi parity metrics.",
    )
    parser.add_argument("--version", action="version", version=f"parity-meter {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--ledger", default=DEFAULT_LEDGER, help="ledger path")
    common.add_argument("--sessions", default=DEFAULT_SESSIONS, help="sessions root")
    common.add_argument("--schemas", default=DEFAULT_SCHEMAS, help="schema snapshot sidecar path")

    replay = sub.add_parser("replay", parents=[common], help="replay sessions into the ledger")
    replay.add_argument("--last", type=int, default=DEFAULT_LAST, help="newest N session files")
    replay.set_defaults(func=command_replay)

    table = sub.add_parser("table", parents=[common], help="print the ledger table")
    table.add_argument("--last", type=int, default=None, help="newest N sessions only")
    table.set_defaults(func=command_table)

    doctor = sub.add_parser("doctor", parents=[common], help="sidecar and ledger status")
    doctor.set_defaults(func=command_doctor)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    last = getattr(args, "last", None)
    if last is not None and last < 0:
        parser.error("--last must be zero or greater")
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
