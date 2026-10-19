
#!/usr/bin/env node
/**
 * 24/7 Discord bot watchdog.
 * Railway: BOT_ONLY=1 binds PORT and keeps the bot alive.
 * Preview: no HTTP bind unless configured.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const DATA = path.join(ROOT, "data");
const STATUS = path.join(DATA, "bot-status.json");
const PID = path.join(DATA, "bot.pid");
const WANT = path.join(DATA, "bot-want.json");
const WATCHDOG = path.join(DATA, "watchdog.pid");

fs.mkdirSync(DATA, { recursive: true });

// Diagnose Python inside the actual Railway container.
const pythonCheck = spawnSync("/usr/bin/python3", ["--version"], {
  encoding: "utf8",
  timeout: 5000,
});

console.log("[PYTHON CHECK]", JSON.stringify({
  status: pythonCheck.status,
  error: pythonCheck.error?.message ?? null,
  stdout: pythonCheck.stdout?.trim() ?? "",
  stderr: pythonCheck.stderr?.trim() ?? "",
}));

const botOnly =
  process.env.BOT_ONLY === "1" ||
  Boolean(process.env.RAILWAY_ENVIRONMENT) ||
  Boolean(process.env.RAILWAY_ENVIRONMENT_ID);

const port = Number(process.env.PORT || (botOnly ? 8080 : 0));

function alive(pid) {
  if (!pid) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function wantRunning() {
  const w = readJson(WANT, { running: true });
  return w.running !== false;
}

const CONFIG = path.join(DATA, "bot-secrets.json");

function appIdFromToken(token) {
  const part = String(token || "").split(".")[0];
  if (!part) return "";

  try {
    const id = Buffer.from(part, "base64")
      .toString("utf8")
      .replace(/\0/g, "")
      .trim();

    return /^\d{17,22}$/.test(id) ? id : "";
  } catch {
    return "";
  }
}

function readToken() {
  let file = {};
  let mtime = 0;

  try {
    mtime = fs.statSync(CONFIG).mtimeMs;
    file = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {
    file = {};
  }

  const token = String(
    file.token || process.env.DISCORD_BOT_TOKEN || ""
  ).trim();

  const appId = String(
    file.appId ||
    process.env.DISCORD_APP_ID ||
    appIdFromToken(token) ||
    ""
  ).trim();

  return { token, appId, mtime };
}

let holdUntilTokenChanges = 0;

if (fs.existsSync(WATCHDOG)) {
  const old = Number(fs.readFileSync(WATCHDOG, "utf8"));

  if (old && old !== process.pid && alive(old)) {
    console.log("[watchdog] already running pid", old);
    process.exit(0);
  }
}

fs.writeFileSync(WATCHDOG, String(process.pid));

let child = null;
let restartTimer = null;
let crashes = 0;

function spawnBot() {
  const { token, appId, mtime } = readToken();

  if (!token) {
    writeJson(STATUS, {
      online: false,
      error: "missing token",
      updatedAt: Date.now(),
    });
    return;
  }

  if (holdUntilTokenChanges && mtime === holdUntilTokenChanges) {
    return;
  }

  if (holdUntilTokenChanges && mtime !== holdUntilTokenChanges) {
    holdUntilTokenChanges = 0;
  }

  if (child && child.exitCode === null) return;

  const extras = [
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

  // Keep the system locations available after adding vendor tools.
  const systemPaths = [
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    process.env.PATH || "",
  ];

  const childEnv = {
    ...process.env,
    DISCORD_BOT_TOKEN: token,
    DISCORD_APP_ID: appId,
    PATH: [...extras, ...systemPaths].join(path.delimiter),
    PYTHON_BIN: process.env.PYTHON_BIN || "/usr/bin/python3",
    PYTHONPATH: [
      path.join(ROOT, "vendor", "luau-vmp-deobf"),
      process.env.PYTHONPATH || "",
    ].filter(Boolean).join(path.delimiter),
    PYTHONUNBUFFERED: "1",
  };

  let errBuf = "";

  child = spawn(
    process.execPath,
    [path.join(ROOT, "bot", "index.mjs")],
    {
      cwd: ROOT,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  fs.writeFileSync(PID, String(child.pid || ""));

  writeJson(STATUS, {
    online: false,
    error: "connecting",
    updatedAt: Date.now(),
  });

  child.stdout?.on("data", (d) => {
    process.stdout.write("[bot] " + d);
  });

  child.stderr?.on("data", (d) => {
    errBuf = (errBuf + d.toString()).slice(-2000);
    process.stderr.write("[bot] " + d);
  });

  child.on("error", (error) => {
    errBuf = (errBuf + "\n" + error.message).slice(-2000);
    console.error("[watchdog] spawn error:", error.message);
  });

  child.on("exit", (code, signal) => {
    child = null;

    const stopped = !wantRunning();
    const invalid = /TokenInvalid|invalid token/i.test(errBuf);

    if (invalid) {
      holdUntilTokenChanges = mtime;

      writeJson(STATUS, {
        online: false,
        error:
          "Invalid bot token. Reset it in the Discord Developer Portal and update your configuration.",
        updatedAt: Date.now(),
      });

      console.log("[watchdog] token rejected — waiting for a new token");
      return;
    }

    writeJson(STATUS, {
      online: false,
      error: stopped ? "stopped" : `exit ${code ?? signal}`,
      updatedAt: Date.now(),
    });

    if (stopped) return;

    crashes += 1;
    const delay = Math.min(15_000, 800 + crashes * 700);

    console.log(
      `[watchdog] bot exited ${code ?? signal} — restart in ${delay}ms`
    );

    clearTimeout(restartTimer);
    restartTimer = setTimeout(spawnBot, delay);
  });
}

function tick() {
  const { token } = readToken();
  const running = wantRunning();

  const botPid = Number(
    fs.existsSync(PID) ? fs.readFileSync(PID, "utf8") : 0
  );

  if (!running) {
    if (child && child.exitCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore shutdown errors.
      }
    } else if (alive(botPid)) {
      try {
        process.kill(botPid, "SIGTERM");
      } catch {
        // Ignore shutdown errors.
      }
    }

    return;
  }

  if (!token) return;
  if (child && child.exitCode === null) return;
  if (alive(botPid) && !child) return;

  spawnBot();
}

tick();
setInterval(tick, 4000);

if (botOnly && port) {
  const server = http.createServer((req, res) => {
    const url = req.url?.split("?")[0] || "/";

    if (
      url === "/health" ||
      url === "/" ||
      url === "/api/health"
    ) {
      const st = readJson(STATUS, {});

      const body = JSON.stringify({
        ok: true,
        service: "6.5mz-deobf",
        bot: st.online === true,
        username: st.username || null,
        error: st.error || null,
      });

      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });

      res.end(body);
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(
      `[watchdog] health on 0.0.0.0:${port} bot-only=${botOnly}`
    );
  });
}

process.on("SIGTERM", () => {
  try {
    child?.kill("SIGTERM");
  } catch {
    // Ignore shutdown errors.
  }

  process.exit(0);
});

console.log("[watchdog] 6.5mz deobf watchdog online");
