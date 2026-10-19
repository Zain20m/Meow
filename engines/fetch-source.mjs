import { lookup } from "node:dns/promises";
import net from "node:net";

const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "metadata.google.internal"]);
const UA_CHAIN = [
  "Xeno/RobloxApp/V1.0.9",
  "Roblox/WinInet",
  "RobloxStudio/WinInet",
  "Wave",
  "Solara/2.0",
  "Zenith",
  "Electron",
  "Delta/1.0",
  "Synapse",
  "Krnl",
  "Fluxus",
  "okhttp/3.10.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
  }
  if (ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) return true;
  return false;
}

async function assertSafeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http/https urls");
  const host = u.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("refusing private url");
  }
  try {
    const addrs = await lookup(host, { all: true });
    for (const a of addrs) {
      if (isPrivateIp(a.address)) throw new Error("refusing private ip");
    }
  } catch (e) {
    if (String(e.message).includes("refusing")) throw e;
  }
  return u;
}

function cleanUrl(u) {
  return String(u || "")
    .replace(/\\[ntr]/g, "")
    .replace(/[),.;]+$/, "")
    .replace(/&/g, "&")
    .trim();
}

export function extractLoadstring(text) {
  const s = String(text ?? "").trim();
  const patterns = [
    /loadstring\s*\(\s*(?:game:HttpGet(?:Async)?|http(?:s)?request)\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/i,
    /HttpGet(?:Async)?\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/i,
    /loadstring\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/i,
    /request\s*\(\s*\{\s*Url\s*=\s*["'`](https?:\/\/[^"'`]+)["'`]/i,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m) return cleanUrl(m[1]);
  }
  if (/^https?:\/\//i.test(s) && !s.includes("\n")) return cleanUrl(s.split(/\s+/)[0]);
  return null;
}

export function extractScriptUrls(text) {
  const s = String(text ?? "");
  const urls = [];
  const push = (u) => {
    u = cleanUrl(u);
    if (!/^https?:\/\//i.test(u)) return;
    if (u.length > 2000) return;
    if (!urls.includes(u)) urls.push(u);
  };
  const load = extractLoadstring(s);
  if (load) push(load);
  const re =
    /(?:game:HttpGet(?:Async)?|HttpGet|loadstring)\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/gi;
  let m;
  while ((m = re.exec(s))) push(m[1]);
  const raw = /https?:\/\/[^\s"'\\<>]+/g;
  while ((m = raw.exec(s))) {
    const u = cleanUrl(m[0]);
    if (
      /luarmor\.net|getpolsec\.com|flowauth\.net|moonveil|cdn\.|\/l\/|\/loaders\/|pastebin|raw\.githubusercontent|gist\.|dropbox|work\.ink|linkvertise|scriptblox|wearedevs|github\.com\/.+\/raw/i.test(
        u,
      ) ||
      /\.lua(\?|$)/i.test(u)
    ) {
      if (/luarmor\.net\/?$|luarmor\.net\/login|docs\.luarmor|fonts\.googleapis|discord\.gg|media\.discordapp/i.test(u)) {
        continue;
      }
      push(u);
    }
  }
  return urls.slice(0, 24);
}

export function looksLikeUrl(text) {
  const s = String(text ?? "").trim();
  if (/^https?:\/\//i.test(s) || /^loadstring\s*:/i.test(s) || /^loadstring\s*\(/i.test(s)) return true;
  if (/script_key\s*=/.test(s) && /loadstring\s*\(/i.test(s) && /HttpGet/i.test(s)) return true;
  if (s.length < 2500 && /loadstring\s*\(\s*game:HttpGet/i.test(s)) return true;
  return false;
}

export function isLoaderStub(source) {
  const s = String(source ?? "").trim();
  if (!s) return false;
  if (s.length > 8000) return false;
  const stripped = s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");
  if (stripped.length < 1800 && /loadstring\s*\(/i.test(stripped) && /HttpGet/i.test(stripped)) {
    if (!/superflow_bytecode|_bsdata0|Luraph Obfuscator|MoonVeil|function\s+\w+\s*\(/i.test(s)) return true;
  }
  return false;
}

export function isHtmlSplash(body, contentType = "") {
  const s = String(body ?? "");
  const htmlType = /text\/html/i.test(contentType);
  const head = s.slice(0, 4000);
  const hasHtml = /<!DOCTYPE html|<html[\s>]|<head[\s>]|<!doctypehtml/i.test(head);
  const landing =
    /Luarmor - Lua Whitelist Service|priceCard glass|heroDescription|You are not allowed to view these files|Contents can not be displayed on browser|Not Authorized/i.test(
      head,
    );
  const hasLua =
    /loadstring\s*\(|superflow_bytecode|Luraph Obfuscator|_bsdata0|This script is obfuscated with MoonVeil/i.test(s);
  return ((htmlType || hasHtml || landing) && !hasLua) || landing;
}

export function looksLikeProtectedLua(source) {
  const s = String(source ?? "");
  if (!s || s.length < 40) return false;
  if (isHtmlSplash(s)) return false;
  if (/Luraph Obfuscator/i.test(s)) return true;
  if (/This script is obfuscated with MoonVeil/i.test(s)) return true;
  if (/superflow_bytecode|_bsdata0/.test(s)) return true;
  if (/MoonSec|Prometheus|Hercules|IronBrew|LuaObfuscator|Goofyscator/i.test(s.slice(0, 4000))) return true;
  if (s.length > 400 && /function\s*\(|return\s+setmetatable|local\s+\w+\s*=/.test(s) && !isHtmlSplash(s)) return true;
  return false;
}

function luraphReached(source) {
  const head = String(source ?? "").slice(0, 2500);
  return /Luraph Obfuscator v15/i.test(head) || /This file was protected using Luraph Obfuscator v15/i.test(head);
}

function isLuarmorBootstrap(source) {
  const s = String(source ?? "");
  return /_bsdata0\s*=/.test(s) && /cdn\.luarmor\.net\/v4_init|static_content_/i.test(s) && s.length < 20000;
}

function rewriteLuarmor(url) {
  const variants = [url];
  const idMatch = url.match(/\/files\/v(\d+)\/(?:loaders|l)\/([A-Za-z0-9]+)\.lua/i);
  if (idMatch) {
    const v = idMatch[1];
    const id = idMatch[2];
    for (const host of ["api.luarmor.net", "cdn.luarmor.net"]) {
      for (const folder of ["l", "loaders"]) {
        variants.push(`https://${host}/files/v${v}/${folder}/${id}.lua`);
      }
    }
  } else {
    if (url.includes("/loaders/")) variants.push(url.replace("/loaders/", "/l/"));
    if (url.includes("/l/") && !url.includes("/loaders/")) variants.push(url.replace("/l/", "/loaders/"));
    if (url.includes("api.luarmor.net")) variants.push(url.replace("api.luarmor.net", "cdn.luarmor.net"));
    if (url.includes("cdn.luarmor.net")) variants.push(url.replace("cdn.luarmor.net", "api.luarmor.net"));
  }
  return [...new Set(variants)];
}

function rewriteGeneric(url) {
  const variants = [url];
  if (/luarmor\.net/i.test(url)) return rewriteLuarmor(url);
  if (/getpolsec\.com/i.test(url)) {
    variants.push(url.replace("://api.", "://"));
    variants.push(url.replace("/scripts/hosted/", "/hosted/"));
  }
  if (url.endsWith("/")) variants.push(url.replace(/\/+$/, ""));
  return [...new Set(variants)];
}

function extraHeadersFor(url, ua) {
  const headers = {
    "User-Agent": ua,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://www.roblox.com/",
    Origin: "https://www.roblox.com",
  };
  if (/discord(app)?\.com/i.test(url)) {
    headers["User-Agent"] = "DiscordBot (https://github.com/discordjs/discord.js, 14.16.3) Node.js/22";
    const tok = process.env.DISCORD_BOT_TOKEN;
    if (tok) headers.Authorization = `Bot ${tok}`;
  }
  if (/luarmor\.net|getpolsec\.com/i.test(url)) {
    headers["X-Executor"] = "Xeno";
  }
  return headers;
}

async function fetchOnce(url, ua, timeoutMs) {
  const u = await assertSafeUrl(url);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(u.href, {
      redirect: "follow",
      signal: ac.signal,
      headers: extraHeadersFor(u.href, ua),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const body = buf.toString("latin1");
    return { status: res.status, body, contentType: res.headers.get("content-type") || "", url: res.url || u.href };
  } finally {
    clearTimeout(t);
  }
}

function luaScore(body) {
  if (!body) return 0;
  let n = 0;
  if (/Luraph Obfuscator/i.test(body)) n += 50;
  if (/This script is obfuscated with MoonVeil/i.test(body)) n += 50;
  if (/MoonVeil|getpolsec/i.test(body)) n += 20;
  if (/superflow_bytecode|_bsdata0/.test(body)) n += 40;
  if (/Luarmor V4 bootstrapper/i.test(body)) n += 35;
  if (/loadstring\s*\(/.test(body)) n += 8;
  if (/function\s*\(/.test(body)) n += 6;
  if (/local\s+\w+\s*=/.test(body)) n += 4;
  if (isHtmlSplash(body)) n -= 80;
  if (/Luarmor - Lua Whitelist Service|priceCard glass|heroDescription/i.test(body)) n -= 100;
  if (/executor is not supported by Luarmor/i.test(body)) n -= 40;
  if (body.length > 2000) n += 5;
  if (body.length > 20000) n += 8;
  return n;
}

function isSoftUnauthorized(res) {
  if (!res) return false;
  if (res.status === 401 || res.status === 403) return true;
  const head = String(res.body || "").slice(0, 2000);
  return /unauthorized access|not authorized|access denied|invalid key|hwid|host returned 403|403 unauthorized/i.test(head);
}

export async function fetchScript(input, onLog = () => {}) {
  let raw = String(input ?? "").trim();
  if (/^loadstring\s*:/i.test(raw)) raw = raw.replace(/^loadstring\s*:/i, "").trim();
  const url = extractLoadstring(raw) || (/^https?:\/\//i.test(raw.split(/\s/)[0]) ? raw.split(/\s/)[0] : null);
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: true, source: String(input ?? ""), from: "inline" };
  }

  const variants = rewriteGeneric(url);
  let lastErr = "fetch failed";
  let best = null;
  for (const candidate of variants) {
    onLog(`[*] fetching ${candidate}`);
    for (const ua of UA_CHAIN) {
      try {
        const res = await fetchOnce(candidate, ua, 28000);
        const unauthorized = isSoftUnauthorized(res);
        if (unauthorized) {
          onLog(`[!] ${res.status} unauthorized on ${candidate} (${ua}) — sneaking through anyway`);
          lastErr = `host returned ${res.status} unauthorized`;
          if (looksLikeProtectedLua(res.body) || luaScore(res.body) > 8) {
            if (!best || luaScore(res.body) > luaScore(best.body)) best = { ...res, from: res.url };
          }
          continue;
        }
        if (isHtmlSplash(res.body, res.contentType)) {
          onLog(`[!] html splash from ${candidate} — not a script, trying next`);
          lastErr = "html instead of script";
          const nested = extractScriptUrls(res.body).filter((u) => /\/files\/|\/loaders\/|\.lua/i.test(u));
          for (const n of nested.slice(0, 4)) {
            if (!variants.includes(n)) variants.push(n);
          }
          continue;
        }
        if (/executor is not supported by Luarmor/i.test(res.body)) {
          onLog(`[!] luarmor rejected UA ${ua} — next executor UA`);
          lastErr = "executor not supported";
          continue;
        }
        if (res.status >= 400 && res.body.length < 80) {
          lastErr = `http ${res.status} (${res.body.length} bytes)`;
          continue;
        }
        const score = luaScore(res.body);
        if (!best || score > luaScore(best.body) || res.body.length > (best.body?.length || 0)) {
          best = { ...res, from: res.url };
        }
        if (looksLikeProtectedLua(res.body) || luraphReached(res.body) || (res.body.length > 200 && score > 5)) {
          onLog(`[+] fetched ${res.body.length} bytes from ${res.url}`);
          return { ok: true, source: res.body, from: res.url, status: res.status };
        }
      } catch (e) {
        lastErr = e.message || String(e);
        if (/403|401|unauthor/i.test(lastErr)) {
          onLog(`[!] ${lastErr} — sneak next`);
        }
      }
    }
  }
  if (best && best.body && best.body.length > 8 && !isHtmlSplash(best.body, best.contentType)) {
    onLog(`[+] sneak-through kept ${best.body.length} bytes from ${best.from}`);
    return { ok: true, source: best.body, from: best.from, status: best.status, sneaked: true };
  }
  onLog(`[!] fetch failed: ${lastErr} — keeping original paste`);
  return { ok: false, error: lastErr, source: String(input ?? ""), soft: true };
}

export function extractNestedUrls(source) {
  return extractScriptUrls(source);
}

export async function peelToPayload(input, onLog = () => {}, { stopAtLuraph = true } = {}) {
  let current = String(input ?? "");
  const seen = new Set();
  const history = [];
  for (let layer = 1; layer <= 10; layer++) {
    if (stopAtLuraph && luraphReached(current)) {
      onLog(`[+] luraph 15 layer reached (${current.length} bytes)`);
      return { source: current, peeled: true, layer, luraph: true, history };
    }
    const stub = isLoaderStub(current) || looksLikeUrl(current);
    const urls = extractScriptUrls(current);
    const fetchables = urls.filter(
      (u) =>
        !seen.has(u) &&
        !/discord\.gg|fonts\.google|docs\.luarmor|luarmor\.net\/login|luarmor\.net\/?$|media\.discordapp/i.test(u),
    );
    const heavy =
      looksLikeProtectedLua(current) &&
      current.length > 8000 &&
      /Luraph Obfuscator|MoonVeil|superflow_bytecode|MoonSec|Prometheus|Hercules|IronBrew/i.test(current);
    if (heavy && !isLuarmorBootstrap(current)) {
      onLog(`[+] stopping peel on protected payload (${current.length} bytes)`);
      return { source: current, peeled: layer > 1, layer, luraph: luraphReached(current), history };
    }
    if (!stub && looksLikeProtectedLua(current) && !fetchables.length) {
      return { source: current, peeled: layer > 1, layer, luraph: luraphReached(current), history };
    }
    if (!fetchables.length) {
      if (looksLikeProtectedLua(current) && !isHtmlSplash(current)) {
        return { source: current, peeled: layer > 1, layer, luraph: luraphReached(current), history };
      }
      break;
    }
    let progressed = false;
    for (const u of fetchables) {
      seen.add(u);
      onLog(`[*] peel layer ${layer}: ${u}`);
      const got = await fetchScript(u, onLog);
      if (got.ok && got.source && got.source !== current && got.source.length > 20 && !isHtmlSplash(got.source)) {
        history.push({ url: u, bytes: got.source.length, from: got.from });
        current = got.source;
        progressed = true;
        if (stopAtLuraph && luraphReached(current)) {
          onLog(`[+] luraph 15 after peel layer ${layer}`);
          return { source: current, peeled: true, layer, luraph: true, history };
        }
        break;
      }
    }
    if (!progressed) break;
  }
  return { source: current, peeled: history.length > 0, layer: history.length, luraph: luraphReached(current), history };
}
