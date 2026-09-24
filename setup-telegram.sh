#!/usr/bin/env bash
# One-shot Telegram setup. Run this yourself - the token is read straight into
# GitHub's encrypted secrets and is never printed, logged or written to disk.
set -euo pipefail
cd "$(dirname "$0")"

command -v gh >/dev/null || { echo "gh CLI not found."; exit 1; }

read -rsp "Bot token from @BotFather: " TOKEN; echo
[ -n "$TOKEN" ] || { echo "No token given."; exit 1; }

echo "Looking up your chat id…"
CHAT=$(curl -fsS "https://api.telegram.org/bot${TOKEN}/getUpdates" \
       | grep -o '"chat":{"id":-\?[0-9]*' | grep -o -- '-\?[0-9]*$' | head -1 || true)

if [ -z "$CHAT" ]; then
  cat <<'MSG'

No chat found. Telegram won't let a bot message you until you message it first:
  1. Open the bot in Telegram (BotFather gave you a t.me/... link)
  2. Press Start, or send it any message
  3. Run this script again
MSG
  exit 1
fi
echo "Found chat id: $CHAT"

printf '%s' "$TOKEN" | gh secret set TELEGRAM_TOKEN
printf '%s' "$CHAT"  | gh secret set TELEGRAM_CHAT
unset TOKEN
echo
echo "Secrets stored. Sending a test message…"
gh workflow run refresh.yml
echo "Run started - watch it with:  gh run watch"
