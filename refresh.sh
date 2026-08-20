#!/usr/bin/env bash
# Re-check every screening and publish the result to GitHub Pages.
set -euo pipefail
cd "$(dirname "$0")"

# GitHub Actions also pushes refreshes, so sync before doing our own.
git pull --rebase --autostash -q origin main || true

node scrape.mjs
if ! git diff --quiet data.json; then
  git add data.json
  git commit -q -m "refresh: $(date '+%Y-%m-%d %H:%M')"
  for i in 1 2 3; do
    if git push -q origin main 2>/dev/null; then echo "Published."; exit 0; fi
    git pull --rebase --autostash -q origin main || true
  done
  echo "Could not push after 3 attempts." >&2; exit 1
else
  echo "No change."
fi
