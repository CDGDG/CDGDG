#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd /Users/cdgdg/Documents/Devroot/CDGDG

/usr/bin/python3 scripts/collect_agent_usage.py
/opt/homebrew/bin/npx vercel --prod --yes >/tmp/cdgdg-ai-usage-vercel.log 2>&1
