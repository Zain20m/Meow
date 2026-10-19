import { extractStrings, classifyStrings } from "./static-lift.mjs";
import { stampSource } from "./stamp.mjs";
import { detect } from "./detect.mjs";

const LUA_HINT = /\b(local|function|end|return|then|game|HttpGet|GetService|loadstring|print)\b/;

function normalize(source) {
  return String(source || "").replace(/\0/g, "").replace(/\r\n/g, "\n");
}

function longestBlob(source) {
  const strings = extractStrings(source, { max: 2000 });
  return strings.reduce((best, s) => (s.length > best.length ? s : best), "");
}

function tryByteXor(blob) {
  if (!blob || blob.length < 24 || blob.length > 400_000) return null;
  const bytes = Buffer.from(blob, "latin1");
  let best = null;
  for (let key = 1; key < 256; key++) {
    const out = Buffer.alloc(Math.min(bytes.length, 240));
    for (let i = 0; i < out.length; i++) out[i] = bytes[i] ^ key;
    const sample = out.toString("latin1");
    if (LUA_HINT.test(sample)) {
      const full = Buffer.alloc(bytes.length);
      for (let i = 0; i < bytes.length; i++) full[i] = bytes[i] ^ key;
      const text = full.toString("latin1");
      if (LUA_HINT.test(text)) {
        best = { key, text };
        break;
      }
    }
  }
  return best;
}

function tryBase64(source) {
  const hits = [];
  const re = /['"]([A-Za-z0-9+/=\s]{80,})['"]/g;
  let m;
  while ((m = re.exec(source)) && hits.length < 8) {
    const raw = m[1].replace(/\s+/g, "");
    if (raw.length % 4 !== 0) continue;
    try {
      const buf = Buffer.from(raw, "base64");
      if (buf.length < 24) continue;
      const text = buf.toString("latin1");
      if (LUA_HINT.test(text) || text.includes("\x1bLua") || text.includes("LuaQ")) {
        hits.push(text);
      }
    } catch {
      /* ignore */
    }
  }
  return hits;
}

function familyOf(source, detection) {
  const escapes = (source.match(/\\(?:\d{1,3}|x[0-9a-fA-F]{2})/g) || []).length;
  if (/loadstring\s*\(\s*(?:game\s*:\s*)?HttpGet|loadstring\s*\(\s*http\.request/i.test(source) && source.length < 4000) {
    return "remote-loader";
  }
  if (escapes > 40) return "string-encryption";
  if (/\x1bLua|\\x1bLua|\\27Lua/.test(source)) return "bytecode";
  if (/[A-Za-z0-9+/]{120,}={0,2}/.test(source) && /base64|alphabet|decode/i.test(source)) return "base64";
  const vmName = detection?.best?.id && detection.best.id !== "unknown" && detection.best.confidence >= 0.28;
  const flattened = /elseif/.test(source) && (source.match(/\belseif\b/g) || []).length > 25;
  if (vmName || flattened || /Luraph|IronBrew|Prometheus|MoonSec|PSU|MoonVeil/i.test(source.slice(0, 4000))) {
    return "vm";
  }
  if (/\blocal\b/.test(source) && /\bfunction\b/.test(source) && escapes < 8) return "minified";
  return "unknown";
}

function behaviour(source, strings) {
  const bag = strings.join("\n") + "\n" + source.slice(0, 8000);
  const notes = [];
  if (/HttpGet|http\.request|syn\.request/i.test(bag)) notes.push("fetches a remote script");
  if (/loadstring/i.test(bag)) notes.push("runs loadstring");
  if (/GetService/i.test(bag)) notes.push("uses Roblox services");
  if (/webhook/i.test(bag)) notes.push("mentions a webhook");
  if (/ScreenGui|CreateWindow|AddToggle|AddButton/i.test(bag)) notes.push("builds a UI");
  if (/script_key|keyless|whitelist/i.test(bag)) notes.push("key / whitelist check");
  return notes;
}

const DUMP = `local oldLoad = loadstring
getgenv().loadstring = newcclosure(function(src, chunkname)
  if type(src) == "string" and #src > 300 then
    pcall(writefile, "dumped_" .. tostring(os.clock()) .. ".lua", src)
    print("[DUMP] wrote payload, length", #src)
  end
  return oldLoad(src, chunkname)
end)`;

export function runPlaybook(raw) {
  const source = normalize(raw);
  const detection = detect(source);
  const family = familyOf(source, detection);
  const strings = extractStrings(source, { max: 2500 }).filter((s) => s.length > 2 && s.length < 8000);
  const grouped = classifyStrings(strings);
  const notes = behaviour(source, strings);
  const recovered = [];
  const missing = [];
  let body = "";

  if (family === "remote-loader") {
    missing.push("The one-liner is only a loader. The fetched body was not a finished script.");
    body = source;
  } else if (family === "string-encryption") {
    const xor = tryByteXor(longestBlob(source));
    if (xor && LUA_HINT.test(xor.text)) {
      recovered.push(`single-byte XOR key ${xor.key} produced Lua-looking text`);
      body = xor.text;
    } else {
      recovered.push("decoded string constants only — decryptor was not a single-byte XOR");
      missing.push("original control flow was not reconstructed");
      body = strings.filter((s) => /[A-Za-z]{4}/.test(s)).slice(0, 200).map((s) => `-- ${JSON.stringify(s)}`).join("\n");
    }
  } else if (family === "base64") {
    const layers = tryBase64(source);
    if (layers.length) {
      recovered.push(`${layers.length} base64 layer(s) decoded to Lua or bytecode`);
      body = layers.join("\n\n-- next layer --\n\n");
      if (body.includes("\x1bLua")) missing.push("bytecode still needs unluac/luadec");
    } else {
      missing.push("base64 alphabet was custom or there is another layer — not guessed");
      body = "";
    }
  } else if (family === "bytecode") {
    recovered.push("bytecode header is present");
    missing.push("stripped bytecode was not decompiled here");
    body = "-- bytecode payload kept below as latin1\n" + source;
  } else if (family === "minified") {
    recovered.push("readable Lua. Short names only — this was not encrypted.");
    body = source;
  } else if (family === "vm") {
    recovered.push("constant fragments and high-level behaviour");
    missing.push("original linear source is not in the static file");
    missing.push("a runtime dump is required for full source (Luraph / IronBrew / Prometheus / PSU class)");
    const consts = [...(grouped.urls || []), ...(grouped.readable || [])].slice(0, 80);
    body = [
      "-- constant fragments",
      ...consts.map((s) => `-- ${JSON.stringify(String(s).slice(0, 240))}`),
      "",
      "-- behaviour: " + (notes.join("; ") || "not obvious from constants"),
      "",
      "-- runtime dump (run this in the executor BEFORE the protected script)",
      DUMP,
    ].join("\n");
  } else {
    const tested = tryByteXor(longestBlob(source));
    const b64 = tryBase64(source);
    if (tested) {
      recovered.push(`tested string-returning transforms; XOR key ${tested.key} matched Lua keywords`);
      body = tested.text;
    } else if (b64.length) {
      recovered.push("a base64 blob decoded to Lua-looking text");
      body = b64[0];
    } else {
      recovered.push("string constants");
      missing.push("no decryptor verified — source was not invented");
      body = strings.slice(0, 120).map((s) => `-- ${JSON.stringify(s.slice(0, 240))}`).join("\n");
    }
  }

  const header = [
    "command: .l",
    `playbook: ${family}`,
    `fingerprint: ${detection.best?.label || "unknown"} ${(detection.best?.confidence || 0).toFixed(2)}`,
    "recovered: " + (recovered.join("; ") || "nothing verified"),
    "not recovered: " + (missing.join("; ") || "none"),
    notes.length ? "behaviour: " + notes.join("; ") : "",
  ].filter(Boolean);

  const text = stampSource(body || "-- nothing verified", header);
  return {
    ok: true,
    partial: missing.length > 0 && family !== "minified",
    text,
    engine: "playbook .l",
    family,
    preview: text.split("\n").slice(0, 8).join("\n"),
  };
}
