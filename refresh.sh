#!/usr/bin/env bash
# Re-check every screening and publish the result to GitHub Pages.
set -euo pipefail
cd "$(dirname "$0")"

# We rebuild the commit on top of remote below (never merge generated output),
# so refuse to run if there are other uncommitted changes to lose.
if [ -n "$(git status --porcelain | grep -v ' data.json$' | grep -v '^??' || true)" ]; then
  echo "Working tree has other uncommitted changes. Commit or stash them first." >&2
  exit 1
fi

node scrape.mjs
TMP=$(mktemp)
cp data.json "$TMP"

for i in 1 2 3; do
  git fetch -q origin main
  git reset -q --hard origin/main
  cp "$TMP" data.json
  if git diff --quiet data.json; then echo "No change."; rm -f "$TMP"; exit 0; fi
  git add data.json
  git commit -q -m "refresh: $(date '+%Y-%m-%d %H:%M')"
  if git push -q origin HEAD:main 2>/dev/null; then echo "Published."; rm -f "$TMP"; exit 0; fi
  echo "Push rejected; rebuilding on top of remote (attempt $i)…"
done
rm -f "$TMP"
echo "Could not publish after 3 attempts." >&2
exit 1
