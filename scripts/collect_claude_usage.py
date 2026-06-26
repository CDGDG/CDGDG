#!/usr/bin/env python3
"""Collect local Claude Code usage into data/claude-agent-usage.json.

This publishes aggregate counters only. It never exports prompts, tool output,
file paths, message text, or secrets. It mirrors the output schema and windowing
logic of collect_agent_usage.py, but reads Claude Code session logs instead of
Codex logs.

Claude Code records one JSONL line per event under ~/.claude/projects/**/*.jsonl.
Each assistant event carries a per-message ``message.usage`` block (NOT a running
cumulative total like Codex), so usage is summed across the session's assistant
events. One file == one session.
"""

from __future__ import annotations

import datetime as dt
import json
import pathlib
from dataclasses import asdict, dataclass


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT_PATH = REPO_ROOT / "data" / "claude-agent-usage.json"
CLAUDE_LOG_ROOT = pathlib.Path.home() / ".claude" / "projects"
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


def map_usage(usage: dict) -> dict[str, int]:
    """Map a Claude message.usage block onto the shared token schema.

    Codex accounting keeps cached tokens inside ``input_tokens`` and reports
    ``total_tokens = input_tokens + output_tokens``. Claude reports the three
    input buckets disjointly, so fold cache creation and cache read into the
    input series and keep ``total = input + output`` to match Codex.
    """
    input_new = int(usage.get("input_tokens", 0) or 0)
    cache_creation = int(usage.get("cache_creation_input_tokens", 0) or 0)
    cache_read = int(usage.get("cache_read_input_tokens", 0) or 0)
    output = int(usage.get("output_tokens", 0) or 0)

    input_tokens = input_new + cache_creation + cache_read
    return {
        "input_tokens": input_tokens,
        "cached_input_tokens": cache_read,
        "output_tokens": output,
        "reasoning_output_tokens": 0,
        "total_tokens": input_tokens + output,
    }


def iter_claude_sessions() -> list[tuple[dt.datetime, dict[str, int]]]:
    sessions: list[tuple[dt.datetime, dict[str, int]]] = []
    if not CLAUDE_LOG_ROOT.exists():
        return sessions
    for path in CLAUDE_LOG_ROOT.rglob("*.jsonl"):
        last_timestamp: dt.datetime | None = None
        totals = {key: 0 for key in TOKEN_KEYS}
        seen_messages: set[str] = set()
        has_usage = False
        try:
            handle = path.open("r", encoding="utf-8")
        except OSError:
            continue
        with handle:
            for line in handle:
                if '"usage"' not in line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("type") != "assistant":
                    continue
                message = event.get("message") or {}
                usage = message.get("usage")
                if not isinstance(usage, dict):
                    continue
                # Guard against the same assistant message appearing twice.
                message_id = message.get("id")
                if message_id is not None:
                    if message_id in seen_messages:
                        continue
                    seen_messages.add(message_id)
                mapped = map_usage(usage)
                for key in TOKEN_KEYS:
                    totals[key] += mapped[key]
                has_usage = True
                timestamp = parse_timestamp(event.get("timestamp"))
                if timestamp and (last_timestamp is None or timestamp > last_timestamp):
                    last_timestamp = timestamp
        if has_usage and last_timestamp:
            sessions.append((last_timestamp, totals))
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
    sessions = iter_claude_sessions()
    month_start = dt.datetime(now.year, now.month, 1, tzinfo=KST).astimezone(dt.timezone.utc)
    rolling_start = (now - dt.timedelta(days=30)).astimezone(dt.timezone.utc)

    payload = {
        "generated_at": now.isoformat(),
        "sources": ["~/.claude/projects"],
        "claude": {
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
