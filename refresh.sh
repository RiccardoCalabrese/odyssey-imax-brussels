#!/usr/bin/env bash
# Re-check every screening and publish the result to GitHub Pages.
set -euo pipefail
cd "$(dirname "$0")"
node scrape.mjs
if ! git diff --quiet data.json; then
  git add data.json
  git commit -q -m "refresh: $(date '+%Y-%m-%d %H:%M')"
  git push -q origin main
  echo "Published."
else
  echo "No change."
fi
