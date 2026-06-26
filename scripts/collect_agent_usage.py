#!/usr/bin/env python3
"""Collect local AI agent usage into data/agent-usage.json.

This publishes aggregate counters only. It never exports prompts, tool output,
file paths, message text, or secrets.
"""

from __future__ import annotations

import datetime as dt
import json
import pathlib
from dataclasses import asdict, dataclass


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT_PATH = REPO_ROOT / "data" / "agent-usage.json"
CODEX_LOG_ROOTS = [
    pathlib.Path.home() / ".codex" / "sessions",
    pathlib.Path.home() / ".codex" / "archived_sessions",
]
KST = dt.timezone(dt.timedelta(hours=9), "KST")


TOKEN_KEYS = (
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
)


@dataclass
class Totals:
    sessions: int = 0
    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    reasoning_output_tokens: int = 0
    total_tokens: int = 0

    def add(self, usage: dict[str, int]) -> None:
        self.sessions += 1
        for key in TOKEN_KEYS:
            setattr(self, key, getattr(self, key) + int(usage.get(key, 0) or 0))


def parse_timestamp(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def iter_codex_sessions() -> list[tuple[dt.datetime, dict[str, int]]]:
    sessions: list[tuple[dt.datetime, dict[str, int]]] = []
    for root in CODEX_LOG_ROOTS:
        if not root.exists():
            continue
        for path in root.rglob("*.jsonl"):
            last_timestamp: dt.datetime | None = None
            last_usage: dict[str, int] | None = None
            try:
                handle = path.open("r", encoding="utf-8")
            except OSError:
                continue
            with handle:
                for line in handle:
                    if '"token_count"' not in line:
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    payload = event.get("payload") or {}
                    info = payload.get("info") or {}
                    usage = info.get("total_token_usage")
                    timestamp = parse_timestamp(event.get("timestamp"))
                    if usage and timestamp:
                        last_timestamp = timestamp
                        last_usage = {key: int(usage.get(key, 0) or 0) for key in TOKEN_KEYS}
            if last_timestamp and last_usage:
                sessions.append((last_timestamp, last_usage))
    return sessions


def total_for_window(sessions: list[tuple[dt.datetime, dict[str, int]]], start: dt.datetime) -> Totals:
    total = Totals()
    for timestamp, usage in sessions:
        if timestamp >= start:
            total.add(usage)
    return total


def daily_totals(sessions: list[tuple[dt.datetime, dict[str, int]]], days: int = 371) -> list[dict[str, int | str]]:
    now = dt.datetime.now(KST)
    first_day = now.date() - dt.timedelta(days=days - 1)
    by_day: dict[dt.date, Totals] = {first_day + dt.timedelta(days=offset): Totals() for offset in range(days)}
    for timestamp, usage in sessions:
        local_day = timestamp.astimezone(KST).date()
        if local_day in by_day:
            by_day[local_day].add(usage)
    return [
        {"date": day.isoformat(), **asdict(total)}
        for day, total in sorted(by_day.items())
    ]


def main() -> int:
    now = dt.datetime.now(KST)
    sessions = iter_codex_sessions()
    month_start = dt.datetime(now.year, now.month, 1, tzinfo=KST).astimezone(dt.timezone.utc)
    rolling_start = (now - dt.timedelta(days=30)).astimezone(dt.timezone.utc)

    payload = {
        "generated_at": now.isoformat(),
        "sources": ["~/.codex/sessions", "~/.codex/archived_sessions"],
        "codex": {
            "month": asdict(total_for_window(sessions, month_start)),
            "rolling_30d": asdict(total_for_window(sessions, rolling_start)),
            "all_time": asdict(total_for_window(sessions, dt.datetime.min.replace(tzinfo=dt.timezone.utc))),
            "daily": daily_totals(sessions),
        },
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
