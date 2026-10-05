#!/usr/bin/env bash
# Rebuild the demo project from scratch: two mock BUs (DEV, PROD) pulled into Git.
# Usage: demo/reset.sh [target-dir]   (default: ./mc-ship-demo)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SEED="$HERE/../sample-project/seed"
DIR="${1:-mc-ship-demo}"
rm -rf "$DIR" && mkdir -p "$DIR" && cd "$DIR"
git init -q
# CI runners have no git identity; use a local one for the demo repo only
git config user.email >/dev/null || { git config user.name "MC Ship demo"; git config user.email "demo@example.com"; }
agentia mc connect DEV  --mock --seed "$SEED/DEV.json"
agentia mc connect PROD --mock --seed "$SEED/PROD.json"
agentia mc pull --bu DEV --bu PROD
git add -A && git commit -qm "Baseline: pull DEV and PROD" && echo "Demo project ready in $(pwd)"
