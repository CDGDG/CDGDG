#!/usr/bin/env python3
"""Upload aggregate agent telemetry JSON to the Vercel ingest endpoint."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import urllib.error
import urllib.request


DEFAULT_ENDPOINT = "https://cdgdg-ai-usage.vercel.app/api/agent-usage"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", choices=["codex", "claude"], required=True)
    parser.add_argument("--file", type=pathlib.Path, required=True)
    parser.add_argument("--endpoint", default=os.getenv("AGENT_USAGE_ENDPOINT", DEFAULT_ENDPOINT))
    args = parser.parse_args()

    secret = os.getenv("AGENT_USAGE_INGEST_SECRET")
    if not secret:
        raise SystemExit("AGENT_USAGE_INGEST_SECRET is required")

    payload = args.file.read_bytes()
    request = urllib.request.Request(
        f"{args.endpoint}?source={args.source}",
        data=payload,
        headers={
            "Authorization": f"Bearer {secret}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            print(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        print(error.read().decode("utf-8"))
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
