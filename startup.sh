#!/bin/sh
set -eu
cd /workspace
export PATH="/workspace/vendor/bin:/workspace/vendor/Deobfuscator-Luraph-V15-adi/bin:/workspace/vendor/luraph-v15-node/bin:/workspace/vendor/6vms:/workspace/vendor/MoonSecV3DeobfuscatorDiscordBot-main/bin:${PATH:-}"
export PYTHONPATH="/workspace/vendor/luau-vmp-deobf:${PYTHONPATH:-}"
export PYTHONUNBUFFERED=1
chmod +x /workspace/vendor/MoonSecV3DeobfuscatorDiscordBot-main/bin/lua5.1 2>/dev/null || true
chmod +x /workspace/vendor/bin/* 2>/dev/null || true

# Saved from the control panel. Never printed. Gitignored.
if [ -f /workspace/data/bot-secrets.json ]; then
  eval "$(node -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync("/workspace/data/bot-secrets.json", "utf8"));
      const q = (s) => "\"" + String(s).replace(/["\\\\$`]/g, "") + "\"";
      if (j.token) process.stdout.write("export DISCORD_BOT_TOKEN=" + q(j.token) + "\n");
      if (j.appId) process.stdout.write("export DISCORD_APP_ID=" + q(j.appId) + "\n");
    } catch {}
  ')"
fi

if [ ! -f /workspace/data/watchdog.pid ] || ! kill -0 "$(cat /workspace/data/watchdog.pid 2>/dev/null)" 2>/dev/null; then
  node /workspace/scripts/start-bot.mjs >> /tmp/bot-watchdog.log 2>&1 &
fi

healthy() {
  curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/health
}

if healthy; then
  exit 0
fi

# Stale listener that is not answering is what the cloud proxy reports as 502/503.
if curl -sf -o /dev/null --max-time 1 http://127.0.0.1:8080/ ; then
  exit 0
fi

npm run dev >> /tmp/vite-dev.log 2>&1 &
i=0
while [ "$i" -lt 40 ]; do
  if healthy || curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
    exit 0
  fi
  i=$((i + 1))
  sleep 0.5
done
exit 0
