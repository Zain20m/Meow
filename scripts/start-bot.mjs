
/**
 * 24/7 Discord bot watchdog for Railway.
 * Starts bot/index.mjs, restarts it if it exits, and exposes a health endpoint.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BOT_FILE = path.join(ROOT, "bot", "index.mjs");

const PORT = Number(process.env.PORT || 8080);
const BOT_ONLY = process.env.BOT_ONLY !== "0";

const PATH_DIRS = [
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  path.join(ROOT, "vendor", "bin"),
  path.join(ROOT, "vendor", "Deobfuscator-Luraph-V15-adi", "bin"),
  path.join(ROOT, "vendor", "luraph-v15-node", "bin"),
  path.join(ROOT, "vendor", "6vms"),
  path.join(
    ROOT,
    "vendor",
    "MoonSecV3DeobfuscatorDiscordBot-main",
    "bin"
  ),
];

const ENV = {
  ...process.env,
  PATH: [
    ...PATH_DIRS,
    process.env.PATH || "",
  ].filter(Boolean).join(path.delimiter),
  PYTHONUNBUFFERED: "1",
  PYTHON_BIN: process.env.PYTHON_BIN || "/usr/bin/python3",
  PYTHONPATH: [
    path.join(ROOT, "vendor", "luau-vmp-deobf"),
    process.env.PYTHONPATH || "",
  ].filter(Boolean).join(path.delimiter),
};

let bot = null;
let stopping = false;
let restartTimer = null;
let restartDelay = 2000;
let lastExit = null;
let startedAt = Date.now();

function log(...args) {
  console.log(new Date().toISOString(), "[WATCHDOG]", ...args);
}

function checkPython() {
  const candidates = [
    ENV.PYTHON_BIN,
    "/usr/bin/python3",
    "/usr/local/bin/python3",
    "python3",
    "python",
  ];

  const seen = new Set();

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const result = spawnSync(candidate, ["--version"], {
      cwd: ROOT,
      env: ENV,
      encoding: "utf8",
      timeout: 5000,
    });

    log("[PYTHON CHECK]", JSON.stringify({
      candidate,
      status: result.status,
      error: result.error?.message || null,
      stdout: (result.stdout || "").trim(),
      stderr: (result.stderr || "").trim(),
    }));

    if (!result.error && result.status === 0) {
      ENV.PYTHON_BIN = candidate;
      log("[PYTHON SELECTED]", candidate);
      return candidate;
    }
  }

  log("[PYTHON WARNING] No working Python executable found.");
  return null;
}

function startBot() {
  if (stopping || bot) return;

  if (!fs.existsSync(BOT_FILE)) {
    log("[FATAL] Bot entry file does not exist:", BOT_FILE);
    process.exitCode = 1;
    return;
  }

  log("[START] Launching bot:", BOT_FILE);

  bot = spawn(process.execPath, [BOT_FILE], {
    cwd: ROOT,
    env: ENV,
    stdio: ["ignore", "inherit", "inherit"],
  });

  const child = bot;

  child.on("error", (error) => {
    log("[BOT SPAWN ERROR]", error.stack || error.message);
  });

  child.on("exit", (code, signal) => {
    if (bot === child) bot = null;

    lastExit = {
      code,
      signal,
      at: new Date().toISOString(),
    };

    log("[BOT EXIT]", JSON.stringify(lastExit));

    if (stopping) return;

    log("[RESTART] Bot exited. Restarting in", restartDelay, "ms.");

    restartTimer = setTimeout(() => {
      restartTimer = null;
      restartDelay = Math.min(restartDelay * 2, 30000);
      startBot();
    }, restartDelay);
  });

  child.on("spawn", () => {
    restartDelay = 2000;
    log("[BOT ONLINE] Child process started.");
  });
}

function stopBot(signal = "SIGTERM") {
  stopping = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  if (bot && !bot.killed) {
    log("[STOP] Sending", signal, "to bot.");
    bot.kill(signal);
  }
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      const body = {
        ok: true,
        watchdog: "running",
        botRunning: Boolean(bot),
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        lastExit,
        pythonBin: ENV.PYTHON_BIN,
      };

      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(body, null, 2));
      return;
    }

    res.writeHead(404, {
      "content-type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(PORT, "0.0.0.0", () => {
    log("[HTTP] Health server listening on port", PORT);
  });

  server.on("error", (error) => {
    log("[HTTP ERROR]", error.stack || error.message);
  });

  return server;
}

log("[BOOT] Root:", ROOT);
log("[BOOT] Node:", process.version);
log("[BOOT] BOT_ONLY:", BOT_ONLY);
log("[BOOT] Bot entry exists:", fs.existsSync(BOT_FILE));

checkPython();

let healthServer = null;

if (BOT_ONLY) {
  healthServer = startHealthServer();
}

startBot();

function shutdown(signal) {
  log("[SHUTDOWN]", signal);
  stopBot("SIGTERM");

  if (healthServer) {
    healthServer.close();
  }

  setTimeout(() => {
    if (bot) bot.kill("SIGKILL");
    process.exit(0);
  }, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
