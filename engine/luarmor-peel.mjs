import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchScript, extractScriptUrls, looksLikeUrl, isHtmlSplash, looksLikeProtectedLua, peelToPayload } from "./fetch-source.mjs";
import { isLuraph15 } from "./detect.mjs";
import { VENDOR, spawnLogged, toolEnv, makeWorkDir } from "./run-external.mjs";

export function extractScriptKey(source) {
  const s = String(source ?? "");
  const patterns = [
    /script_key\s*=\s*["'`]([^"'`]*)["'`]/,
    /getgenv\(\)\s*\.\s*script_key\s*=\s*["'`]([^"'`]*)["'`]/,
    /getgenv\(\)\s*\[\s*["'`]script_key["'`]\s*\]\s*=\s*["'`]([^"'`]*)["'`]/,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m) return m[1];
  }
  return "";
}

export function extractLuarmorId(source) {
  const m = String(source ?? "").match(/\/files\/v(\d+)\/(?:loaders|l)\/([A-Fa-f0-9]{16,})\.lua/i);
  if (!m) return null;
  return { version: m[1], id: m[2] };
}

export function normalizeLuarmorLoader(source) {
  let s = String(source || "").replace(/^\uFEFF/, "").trim();
  const key = extractScriptKey(s);
  const url =
    s.match(/https?:\/\/api\.luarmor\.net\/files\/v\d+\/(?:loaders|l)\/[A-Fa-f0-9]+\.lua/i)?.[0] ||
    s.match(/https?:\/\/\S+?\.lua(?:\?\S*)?/i)?.[0];
  if (url) {
    const lines = [];
    if (/script_key\s*=/.test(s)) {
      const raw = s.match(/script_key\s*=\s*(?:["'`][^"'`]*["'`]|[A-Za-z0-9_-]+)/);
      if (raw) lines.push(raw[0].replace(/;$/, ""));
      else if (key) lines.push(`script_key=${JSON.stringify(key)}`);
    }
    lines.push(`loadstring(game:HttpGet(${JSON.stringify(url)}))()`);
    return lines.join("\n");
  }
  s = s.replace(/local\s+idx\s*=\s*0[\s\S]*?return\s+old\s*\(\s*chunk\s*,\s*\.\.\.\s*\)\s*end\s*\)\s*/m, "");
  s = s.replace(/getgenv\(\)\.loadstring\s*=[\s\S]*?end\s*\)\s*/m, "");
  return s.trim();
}

export function isLuarmorBootstrapper(source) {
  const s = String(source ?? "");
  return /_bsdata0\s*=/.test(s) && /static_content_|cdn\.luarmor\.net\/v4_init/i.test(s);
}

export function isLuarmorClientBlob(body) {
  const s = String(body || "");
  if (s.length < 4000) return false;
  return /ce_like_loadstring_fn/.test(s) && /luarmor\.net/i.test(s) && /ScriptID|roblox-auth\.luarmor|Failed to load Luarmor client/.test(s);
}

function collectLoadstrings(outDir, clientSource) {
  let names = [];
  try {
    names = fs.readdirSync(outDir).filter((n) => /^loadstring\d+\.txt$/i.test(n));
  } catch {
    return [];
  }
  names.sort((a, b) => Number(a.match(/\d+/)?.[0] || 0) - Number(b.match(/\d+/)?.[0] || 0));
  const head = String(clientSource || "").slice(0, 280);
  return names
    .map((n) => {
      const body = fs.readFileSync(path.join(outDir, n), "latin1");
      const client = isLuarmorClientBlob(body) || (head.length > 80 && body.slice(0, 280) === head);
      return { name: n.replace(/\.txt$/i, ".lua"), body, client };
    })
    .filter((d) => d.body.length > 20);
}

function luraphScore(body) {
  const s = String(body ?? "");
  if (!s) return 0;
  let n = 0;
  if (/Luraph Obfuscator v15/i.test(s.slice(0, 2500))) n += 100;
  if (/Luraph Obfuscator/i.test(s)) n += 40;
  if (/This script is obfuscated with MoonVeil/i.test(s.slice(0, 400))) n += 80;
  if (/return setmetatable\(\{/.test(s.slice(0, 500)) && /LPH/.test(s)) n += 30;
  if (/Luarmor V4 bootstrapper/i.test(s)) n += 20;
  if (isHtmlSplash(s)) n -= 80;
  if (/<!DOCTYPE html|<html[\s>]/i.test(s.slice(0, 500))) n -= 80;
  if (/Luarmor - Lua Whitelist Service|priceCard glass|heroDescription/i.test(s)) n -= 100;
  if (/executor is not supported by Luarmor/i.test(s)) n -= 50;
  if (s.length > 20000) n += 8;
  return n;
}

function pickBest(files) {
  let best = null;
  for (const f of files) {
    let body = "";
    try {
      body = fs.readFileSync(f, "latin1");
    } catch {
      continue;
    }
    const score = luraphScore(body) + Math.min(20, Math.log10(Math.max(10, body.length)));
    if (!best || score > best.score) best = { file: f, body, score };
  }
  return best;
}

async function fetchLuarmorClient(onLog) {
  const urls = [
    "https://cdn.luarmor.net/v4_init_sephal.lua",
    "https://cdn.luarmor.net/v4_init.lua",
    "https://api.luarmor.net/v4_init_sephal.lua",
  ];
  for (const url of urls) {
    onLog(`[*] fetching luarmor client ${url} (Xeno UA)`);
    const got = await fetchScript(url, onLog);
    if (
      got.ok &&
      got.source &&
      got.source.length > 5000 &&
      !isHtmlSplash(got.source) &&
      !/executor is not supported by Luarmor/i.test(got.source)
    ) {
      onLog(`[+] live luarmor client ${got.source.length} bytes`);
      return got.source;
    }
  }
  const vendored = path.join(VENDOR, "luarmor", "client.lua");
  if (fs.existsSync(vendored)) {
    const body = fs.readFileSync(vendored, "latin1");
    onLog(`[+] using vendored luarmor client (${body.length} bytes) — CDN blocked`);
    return body;
  }
  return "";
}

export async function runCaptureSandbox(source, onLog, { scriptKey = "", timeoutMs = 50_000, clientSource = "" } = {}) {
  const work = makeWorkDir("lune-cap");
  const input = path.join(work, "input.lua");
  const outDir = path.join(work, "cap");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(input, source, "latin1");
  let clientPath = "";
  if (clientSource && clientSource.length > 1000 && !/superflow_bytecode|Luarmor V4 bootstrapper/.test(clientSource)) {
    clientPath = path.join(work, "client.lua");
    fs.writeFileSync(clientPath, clientSource, "latin1");
  }
  const lune = path.join(VENDOR, "6vms", "lune");
  const sandbox = path.join(path.dirname(fileURLToPath(import.meta.url)), "capture-sandbox.luau");
  if (!fs.existsSync(lune)) {
    onLog("[!] lune runtime missing — skip sandbox capture");
    return { ok: false, error: "lune missing" };
  }
  onLog("[*] lune capture sandbox (HttpGet + loadstring hooks, Xeno UA, sneak 403)");
  const args = [sandbox, input, outDir, scriptKey || "", clientPath || "", String(Math.round(timeoutMs / 1000))];
  const res = await spawnLogged(lune, ["run", ...args], {
    cwd: path.dirname(sandbox),
    timeoutMs: timeoutMs + 8_000,
    onLog,
    env: toolEnv(),
  });
  const files = [];
  try {
    for (const n of fs.readdirSync(outDir)) {
      if (n.endsWith(".lua")) files.push(path.join(outDir, n));
    }
  } catch {
    /* ignore */
  }
  const dumps = collectLoadstrings(outDir, clientSource);
  if (dumps.length) {
    for (const d of dumps) onLog(`[+] ${d.name} ${d.body.length} bytes${d.client ? " (luarmor client, not the script)" : ""}`);
    const payload = [...dumps].reverse().find((d) => !d.client) || null;
    return {
      ok: !!payload,
      source: payload?.body || "",
      luraph: payload ? isLuraph15(payload.body) : false,
      files,
      work,
      dumps,
      dumped: true,
    };
  }
  const luraphFile = path.join(outDir, "LURAPH.lua");
  if (fs.existsSync(luraphFile)) {
    const body = fs.readFileSync(luraphFile, "latin1");
    onLog(`[+] sandbox caught luraph (${body.length} bytes)`);
    return { ok: true, source: body, luraph: true, files, work };
  }
  const best = pickBest(files);
  if (best && best.score > 10 && looksLikeProtectedLua(best.body) && !isHtmlSplash(best.body)) {
    onLog(`[+] sandbox best capture ${path.basename(best.file)} (${best.body.length} bytes, score ${best.score.toFixed(1)})`);
    return { ok: true, source: best.body, luraph: isLuraph15(best.body), files, work };
  }
  const errText = (res.stderr || res.stdout || "no capture").slice(-400);
  if (/host returned 403|unauthorized/i.test(errText)) {
    onLog("[!] sandbox saw 403 — kept going with whatever was captured");
  }
  return { ok: false, error: errText, files, work };
}

export async function peelLuarmor(source, onLog = () => {}, { insta = false } = {}) {
  let current = String(source ?? "");
  const key = extractScriptKey(current);
  if (key) onLog(`[*] script_key present (${key.length} chars)`);
  else onLog("[*] no script_key — dumping anyway (FFA / empty key)");

  const id = extractLuarmorId(current);
  if (id) onLog(`[*] luarmor script id v${id.version}/${id.id}`);

  // Always hit /l/ as well as /loaders/ — FFA scripts dump luraph with no key.
  if (id) {
    const urls = [
      `https://api.luarmor.net/files/v${id.version}/l/${id.id}.lua`,
      `https://api.luarmor.net/files/v${id.version}/loaders/${id.id}.lua`,
    ];
    for (const u of urls) {
      onLog(`[*] dumper GET ${u}`);
      const got = await fetchScript(u, onLog);
      if (got.ok && got.source && !isHtmlSplash(got.source) && looksLikeProtectedLua(got.source)) {
        current = got.source;
        if (isLuraph15(current)) {
          onLog("[+] luraph 15 from /l/ (no key required)");
          return { source: current, luraph: true, layer: "l-endpoint", key };
        }
      }
    }
  }

  if (looksLikeUrl(current) || /loadstring\s*\(\s*game:HttpGet/i.test(current) || id) {
    let target = current;
    if (id && !/loadstring/i.test(current) && current.length < 200) {
      target = `https://api.luarmor.net/files/v${id.version}/l/${id.id}.lua`;
    }
    const peeled = await peelToPayload(target, onLog, { stopAtLuraph: true });
    if (peeled.source && !isHtmlSplash(peeled.source)) {
      current = peeled.source;
      if (peeled.luraph || isLuraph15(current)) {
        onLog("[+] luraph 15 after URL peel");
        return { source: current, luraph: true, layer: "fetch", key };
      }
    }
  }

  if (isLuraph15(current)) return { source: current, luraph: true, layer: "already", key };

  const liveClient = await fetchLuarmorClient(onLog);
  const sandboxBudget = insta ? 8_000 : 45_000;
  let lastDumps = [];

  const attempts = [];
  if (key) attempts.push(key);
  attempts.push(""); // empty key — FFA
  if (!key) attempts.push("trial");

  if (isLuarmorBootstrapper(current) || /luarmor/i.test(current) || /_bsdata0\s*=/.test(current) || id) {
    for (const tryKey of attempts) {
      const stitched = `script_key=${JSON.stringify(tryKey)}\n${current}`;
      onLog(`[*] lune dump with ${tryKey ? "key" : "empty key"}`);
      const cap = await runCaptureSandbox(stitched, onLog, {
        scriptKey: tryKey,
        timeoutMs: sandboxBudget,
        clientSource: liveClient,
      });
      if (cap.dumps?.length) {
        const payload = cap.dumps.find((d) => !d.client);
        if (payload) {
          onLog(`[+] script chunk ${payload.name} (${payload.body.length} bytes) — ${cap.dumps.length} loadstring file(s)`);
          return {
            source: payload.body,
            luraph: isLuraph15(payload.body),
            layer: "sandbox",
            key: tryKey,
            dumps: cap.dumps,
          };
        }
        onLog("[!] only the Luarmor client was hooked. That file is the same for every script.");
        lastDumps = cap.dumps;
      } else if (cap.ok && cap.source && !isLuarmorClientBlob(cap.source)) {
        current = cap.source;
        if (cap.luraph || isLuraph15(current)) {
          onLog("[+] luraph 15 after lune dump");
          return { source: current, luraph: true, layer: "sandbox", key: tryKey, dumps: cap.dumps || [] };
        }
        if (looksLikeProtectedLua(current) && !isHtmlSplash(current) && !isLuarmorBootstrapper(current)) {
          onLog("[+] sandbox dumped a protected payload");
          return { source: current, luraph: isLuraph15(current), layer: "sandbox-payload", key: tryKey, dumps: cap.dumps || [] };
        }
      }
    }
    onLog("[*] no luraph from auth — still returning the dumped loader blob");
  }

  const nested = extractScriptUrls(current).filter(
    (u) =>
      /\/files\/|\/l\/|\/loaders\/|\.lua(\?|$)|getpolsec|cdn\.luarmor|roblox-auth/i.test(u) &&
      !/luarmor\.net\/?$|luarmor\.net\/login|docs\.luarmor|discord\.gg|fonts\.google/i.test(u),
  );
  for (const u of nested.slice(0, 6)) {
    onLog(`[*] nested fetch ${u}`);
    const got = await fetchScript(u, onLog);
    if (got.ok && got.source && looksLikeProtectedLua(got.source) && !isHtmlSplash(got.source)) {
      if (isLuraph15(got.source) || luraphScore(got.source) > luraphScore(current)) {
        current = got.source;
        if (isLuraph15(current)) return { source: current, luraph: true, layer: "nested", key };
      }
    }
  }

  return {
    source: isLuarmorClientBlob(current) ? "" : current,
    luraph: isLuraph15(current),
    layer: "dump",
    key,
    dumps: lastDumps,
    note: lastDumps.length ? "only the luarmor client was captured" : null,
  };
}
