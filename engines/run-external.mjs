
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(HERE, "..");
export const VENDOR = path.join(ROOT, "vendor");

function findPython() {
  const candidates = [
    process.env.PYTHON_BIN,
    "/usr/bin/python3",
    "/usr/local/bin/python3",
    "/bin/python3",
    "python3",
    "python",
  ].filter(Boolean);

  for (const candidate of [...new Set(candidates)]) {
    try {
      const result = spawnSync(candidate, ["--version"], {
        cwd: ROOT,
        env: process.env,
        encoding: "utf8",
        timeout: 5000,
      });

      if (!result.error && result.status === 0) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

export function toolEnv() {
  const adi = path.join(VENDOR, "Deobfuscator-Luraph-V15-adi");

  const extras = [
    path.join(VENDOR, "bin"),
    path.join(adi, "bin"),
    path.join(VENDOR, "luraph-v15-node", "bin"),
    path.join(VENDOR, "6vms"),
    path.join(VENDOR, "MoonSecV3DeobfuscatorDiscordBot-main", "bin"),
  ];

  const systemPaths = [
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    process.env.PATH || "",
  ];

  const env = {
    ...process.env,
    PATH: [...extras, ...systemPaths].join(path.delimiter),
    PYTHONUNBUFFERED: "1",
    PYTHONPATH: [
      path.join(VENDOR, "luau-vmp-deobf"),
      process.env.PYTHONPATH || "",
    ].filter(Boolean).join(path.delimiter),
    LUAU_BIN: path.join(adi, "bin", "luau"),
    MOONVEIL_LUAU: path.join(VENDOR, "bin", "luau"),
    LUNE: path.join(VENDOR, "6vms", "lune"),
    HOOKOP_BIN: path.join(VENDOR, "6vms", "lute"),
    LUA51_EXECUTABLE: path.join(
      VENDOR,
      "MoonSecV3DeobfuscatorDiscordBot-main",
      "bin",
      "lua5.1"
    ),
    LUARMOR_REPO: adi,
    FLOWAUTH_REPO: adi,
    LUARMOR_LUAU: path.join(adi, "bin", "luau"),
  };

  env.PYTHON_BIN =
    process.env.PYTHON_BIN ||
    findPython() ||
    "/usr/bin/python3";

  return env;
}

export function timeoutForSize(bytes) {
  const kb = bytes / 1024;

  if (kb < 200) return 90_000;
  if (kb < 500) return 180_000;
  if (kb < 800) return 360_000;
  if (kb < 1200) return 540_000;

  return 900_000;
}

export function makeWorkDir(prefix = "deobf") {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-`)
  );
}

export function writeInput(dir, source, name = "input.lua") {
  const p = path.join(dir, name);
  fs.writeFileSync(p, source, "latin1");
  return p;
}

export function spawnLogged(
  cmd,
  args,
  { cwd, timeoutMs, onLog, env } = {}
) {
  return new Promise((resolve) => {
    const childEnv = {
      ...toolEnv(),
      ...(env || {}),
    };

    let executable = cmd;

    if (
      cmd === "python" ||
      cmd === "python3" ||
      cmd === "/usr/bin/python3" ||
      cmd === "/usr/local/bin/python3"
    ) {
      executable = childEnv.PYTHON_BIN || findPython() || cmd;
    }

    onLog?.(`[SPAWN] executable=${executable}`);
    onLog?.(`[SPAWN] cwd=${cwd || ROOT}`);

    if (
      executable.includes("/") &&
      !fs.existsSync(executable)
    ) {
      onLog?.(`[SPAWN WARNING] Executable path does not exist: ${executable}`);
    }

    const child = spawn(executable, args, {
      cwd: cwd || ROOT,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const started = Date.now();

    const ping = timeoutMs
      ? setInterval(() => {
          const elapsed = Date.now() - started;
          const sec = Math.round(elapsed / 1000);
          const left = Math.max(
            0,
            Math.round((timeoutMs - elapsed) / 1000)
          );

          onLog?.(
            `[~] still running (${sec}s elapsed, ~${left}s budget left)`
          );
        }, 8000)
      : null;

    const killer = timeoutMs
      ? setTimeout(() => {
          onLog?.(
            `[!] timed out after ${Math.round(timeoutMs / 1000)}s - sending stop`
          );

          child.kill("SIGTERM");

          setTimeout(() => {
            if (!settled) child.kill("SIGKILL");
          }, 2500);
        }, timeoutMs)
      : null;

    function cleanup() {
      if (ping) clearInterval(ping);
      if (killer) clearTimeout(killer);
    }

    child.stdout.on("data", (data) => {
      const output = data.toString("utf8");
      stdout += output;

      for (const line of output.split(/\r?\n/).filter(Boolean)) {
        onLog?.(line.slice(0, 500));
      }
    });

    child.stderr.on("data", (data) => {
      const output = data.toString("utf8");
      stderr += output;

      for (const line of output.split(/\r?\n/).filter(Boolean)) {
        onLog?.(line.slice(0, 500));
      }
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();

      const message = [
        `[SPAWN ERROR] executable=${executable}`,
        `[SPAWN ERROR] cwd=${cwd || ROOT}`,
        `[SPAWN ERROR] code=${error.code || "UNKNOWN"}`,
        `[SPAWN ERROR] message=${error.message}`,
        `[SPAWN ERROR] PYTHON_BIN=${childEnv.PYTHON_BIN || "(unset)"}`,
        `[SPAWN ERROR] PATH=${childEnv.PATH || "(unset)"}`,
      ].join("\n");

      onLog?.(message);

      resolve({
        code: -1,
        stdout,
        stderr: `${stderr}\n${message}`.trim(),
        timedOut: false,
      });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();

      resolve({
        code: code ?? 1,
        stdout,
        stderr,
        timedOut: signal === "SIGTERM" || signal === "SIGKILL",
      });
    });
  });
}

export function firstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }

  return null;
}

export function findNewestLua(dir) {
  if (!dir || !fs.existsSync(dir)) return null;

  const walk = (directory, results) => {
    for (const entry of fs.readdirSync(directory, {
      withFileTypes: true,
    })) {
      const p = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(p, results);
      } else if (/\.(lua|luau|txt)$/i.test(entry.name)) {
        results.push(p);
      }
    }

    return results;
  };

  const files = walk(dir, []);

  files.sort(
    (a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
  );

  return files[0] || null;
}

export function readIfExists(p) {
  if (!p || !fs.existsSync(p)) return null;

  return fs.readFileSync(p, "utf8");
}
