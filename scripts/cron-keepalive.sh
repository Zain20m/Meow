#!/bin/sh
# Keep the Discord bot + preview process alive.
# crontab -e  then add:
#   */5 * * * * /workspace/scripts/cron-keepalive.sh >> /tmp/deobf-cron.log 2>&1
# On Railway you do not need this — BOT_ONLY=1 already restarts the bot.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$ROOT/vendor/bin:$ROOT/vendor/luraph-v15-node/bin:$ROOT/vendor/6vms:${PATH:-}"

if [ -x "$ROOT/startup.sh" ]; then
  sh "$ROOT/startup.sh" || true
fi

node "$ROOT/scripts/start-bot.mjs" >> /tmp/bot-watchdog.log 2>&1 &

URL="${KEEP_ALIVE_URL:-http://127.0.0.1:8080/health}"
curl -sf --max-time 8 "$URL" >/dev/null 2>&1 || curl -sf --max-time 8 "http://127.0.0.1:8080/" >/dev/null 2>&1 || true
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) keepalive ok"
