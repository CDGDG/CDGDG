#!/usr/bin/env bash
#
# Collect local Codex + Claude Code usage and upload the aggregate counters to
# the Vercel ingest endpoint. Intended to be triggered ~once a day (e.g. from a
# Claude Code SessionStart hook) so the README telemetry card stays fresh.
#
# Usage:
#   daily_usage_upload.sh                 run now
#   daily_usage_upload.sh --if-stale [N]  run only if the last run was > N
#                                         seconds ago (default 72000 = 20h);
#                                         otherwise exit 0 immediately and quietly
#
# Reads AGENT_USAGE_INGEST_SECRET from the repo's .env.local (gitignored).
# Publishes aggregate numbers only -- never prompts, file contents, or secrets.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$HOME/.cache/cdgdg-ai-usage/last-run"

# --- staleness gate (before any logging, so skips stay silent) ---------------
if [ "${1:-}" = "--if-stale" ]; then
  stale_seconds="${2:-72000}"
  if [ -f "$STAMP" ]; then
    now="$(date +%s)"
    last="$(stat -f %m "$STAMP" 2>/dev/null || echo 0)"
    if [ "$(( now - last ))" -lt "$stale_seconds" ]; then
      exit 0
    fi
  fi
fi

mkdir -p "$(dirname "$STAMP")"
touch "$STAMP"

cd "$REPO_ROOT" || exit 1
LOG_DIR="$REPO_ROOT/.local-logs"
mkdir -p "$LOG_DIR"
exec >>"$LOG_DIR/usage-upload.log" 2>&1

echo "=== $(date '+%Y-%m-%d %H:%M:%S %z') run start ==="

# Load the ingest secret (and any other Vercel env) from .env.local.
if [ -f "$REPO_ROOT/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env.local"
  set +a
fi

if [ -z "${AGENT_USAGE_INGEST_SECRET:-}" ]; then
  echo "ERROR: AGENT_USAGE_INGEST_SECRET missing (check .env.local); aborting"
  echo "=== run aborted ==="
  exit 1
fi

PYTHON="$(command -v python3 || echo /usr/bin/python3)"

# Codex
if "$PYTHON" scripts/collect_agent_usage.py; then
  "$PYTHON" scripts/upload_agent_usage.py --source codex --file data/agent-usage.json \
    || echo "WARN: codex upload failed"
else
  echo "WARN: codex collect failed"
fi

# Claude Code
if "$PYTHON" scripts/collect_claude_usage.py; then
  "$PYTHON" scripts/upload_agent_usage.py --source claude --file data/claude-agent-usage.json \
    || echo "WARN: claude upload failed"
else
  echo "WARN: claude collect failed"
fi

echo "=== run done ==="
