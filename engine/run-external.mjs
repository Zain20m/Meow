import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
export const VENDOR = path.join(ROOT, "vendor");

export function toolEnv() {
  const adi = path.join(VENDOR, "Deobfuscator-Luraph-V15-adi");
  const extras = [
    path.join(VENDOR, "bin"),
    path.join(adi, "bin"),
    path.join(VENDOR, "luraph-v15-node", "bin"),
    path.join(VENDOR, "6vms"),
    path.join(VENDOR, "MoonSecV3DeobfuscatorDiscordBot-main", "bin"),
  ];
  return {
    ...process.env,
    PATH: `${extras.join(path.delimiter)}${path.delimiter}${process.env.PATH || ""}`,
    PYTHONUNBUFFERED: "1",
    PYTHON_BIN: process.env.PYTHON_BIN || "python3",
    PYTHONPATH: `${path.join(VENDOR, "luau-vmp-deobf")}${path.delimiter}${process.env.PYTHONPATH || ""}`,
    LUAU_BIN: path.join(adi, "bin", "luau"),
    MOONVEIL_LUAU: path.join(VENDOR, "bin", "luau"),
    LUNE: path.join(VENDOR, "6vms", "lune"),
    HOOKOP_BIN: path.join(VENDOR, "6vms", "lute"),
    LUA51_EXECUTABLE: path.join(VENDOR, "MoonSecV3DeobfuscatorDiscordBot-main", "bin", "lua5.1"),
    LUARMOR_REPO: adi,
    FLOWAUTH_REPO: adi,
    LUARMOR_LUAU: path.join(adi, "bin", "luau"),
  };
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return dir;
}

export function writeInput(dir, source, name = "input.lua") {
  const p = path.join(dir, name);
  fs.writeFileSync(p, source, "latin1");
  return p;
}

export function spawnLogged(cmd, args, { cwd, timeoutMs, onLog, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: cwd || ROOT,
      env: env || toolEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const started = Date.now();
    const ping = setInterval(() => {
      const sec = Math.round((Date.now() - started) / 1000);
      const left = Math.max(0, Math.round((timeoutMs - (Date.now() - started)) / 1000));
      onLog?.(`[~] still running (${sec}s elapsed, ~${left}s budget left)`);
    }, timeoutMs < 12_000 ? 60_000 : 8_000);
    const killer = setTimeout(() => {
      onLog?.(`[!] timed out after ${Math.round(timeoutMs / 1000)}s — sending stop`);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2500);
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      const t = d.toString("utf8");
      stdout += t;
      for (const line of t.split(/\r?\n/).filter(Boolean)) onLog?.(line.slice(0, 500));
    });
    child.stderr.on("data", (d) => {
      const t = d.toString("utf8");
      stderr += t;
      for (const line of t.split(/\r?\n/).filter(Boolean)) onLog?.(line.slice(0, 500));
    });
    child.on("error", (e) => {
      clearInterval(ping);
      clearTimeout(killer);
      resolve({ code: -1, stdout, stderr: stderr + "\n" + e.message, timedOut: false });
    });
    child.on("close", (code, signal) => {
      clearInterval(ping);
      clearTimeout(killer);
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
  const walk = (d, acc) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p, acc);
      else if (/\.(lua|luau|txt)$/i.test(ent.name)) acc.push(p);
    }
    return acc;
  };
  const files = walk(dir, []);
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

export function readIfExists(p) {
  if (!p || !fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}
