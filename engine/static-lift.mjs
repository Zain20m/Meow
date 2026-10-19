import { stampSource } from "./stamp.mjs";

function decodeLuaStringLiteral(raw) {
  let s = raw;
  s = s.replace(/\\z\s*/g, "");
  s = s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => {
    try {
      return String.fromCodePoint(parseInt(h, 16));
    } catch {
      return "";
    }
  });
  s = s.replace(/\\([0-9]{1,3})/g, (_, n) => String.fromCharCode(Number(n) & 255));
  s = s.replace(/\\([abfnrtv\\"'\[])/g, (_, c) => {
    const map = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"', "'": "'", "[": "[" };
    return map[c] ?? c;
  });
  return s;
}

export function extractStrings(source, { max = 4000 } = {}) {
  const s = String(source ?? "");
  const out = [];
  const seen = new Set();
  const push = (v) => {
    if (!v || v.length < 2) return;
    if (seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };

  const longRe = /\[(=*)\[([\s\S]*?)\]\1\]/g;
  let m;
  while ((m = longRe.exec(s))) {
    push(m[2]);
    if (out.length >= max) break;
  }

  const qRe = /(["'])((?:\\.|[^\\])*?)\1/g;
  while ((m = qRe.exec(s))) {
    if (m[2].length > 1) push(decodeLuaStringLiteral(m[2]));
    if (out.length >= max) break;
  }
  return out;
}

function luaQuote(s) {
  return JSON.stringify(s).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => {
    const n = parseInt(h, 16);
    return n < 128 ? JSON.parse(`"\\u${h}"`) : `\\${n}`;
  });
}

function isUseful(str) {
  if (!str) return false;
  if (str.length < 3) return false;
  if (/^[\x00-\x08\x0b\x0c\x0e-\x1f]+$/.test(str)) return false;
  if (/window\.(open|location)|document\.|<!DOCTYPE|<div |class=\"|heroDescription|priceCard/i.test(str)) return false;
  const printable = [...str].filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127).length;
  if (printable / str.length < 0.55 && str.length > 12) return false;
  return true;
}

export function classifyStrings(strings) {
  const urls = [];
  const webhooks = [];
  const keys = [];
  const ui = [];
  const genv = [];
  const remotes = [];
  const readable = [];
  for (const s of strings) {
    if (!isUseful(s)) continue;
    if (/discord(?:app)?\.com\/api\/webhooks/i.test(s)) webhooks.push(s);
    else if (/^https?:\/\//i.test(s)) urls.push(s);
    else if (/script_key|ScriptID|webhook/i.test(s) && s.length < 80) keys.push(s);
    else if (
      /Rayfield|Fluent|Orion|Linoria|MacLib|WindUI|CreateWindow|CreateTab|AddToggle|AddButton|AddSlider|ScreenGui|TextLabel|TextButton|TextBox/i.test(
        s,
      )
    )
      ui.push(s);
    else if (/getgenv|getrenv|_G\[/.test(s) || /^[A-Z][A-Z0-9_]{3,}$/.test(s)) genv.push(s);
    else if (/RemoteEvent|RemoteFunction|FireServer|InvokeServer/i.test(s)) remotes.push(s);
    else if (/[A-Za-z]{4,}/.test(s) && s.length < 400) readable.push(s);
  }
  return { urls, webhooks, keys, ui, genv, remotes, readable: readable.slice(0, 400) };
}

export function hardLift(source, { obfuscatorLabel = "unknown obfuscator", extra = [] } = {}) {
  const strings = extractStrings(source, { max: 6000 });
  const cls = classifyStrings(strings);
  const lines = [];
  lines.push(`-- reconstructed from static lift (${obfuscatorLabel})`);
  lines.push("-- VM bytecode is not re-executed. Strings, URLs, remotes and UI names were recovered from the protected blob.");
  lines.push("-- script_key is stubbed so key-check branches do not crash a later run.");
  lines.push("local script_key = script_key or getgenv and getgenv().script_key or ''");
  lines.push("local genv = (getgenv and getgenv()) or _G");
  lines.push("");
  lines.push("local recovered = {");
  const addList = (name, arr) => {
    lines.push(`  ${name} = {`);
    for (const v of arr.slice(0, 80)) lines.push(`    ${luaQuote(v)},`);
    lines.push("  },");
  };
  addList("urls", cls.urls);
  addList("webhooks", cls.webhooks);
  addList("keys", cls.keys);
  addList("ui", cls.ui);
  addList("remotes", cls.remotes);
  addList("strings", cls.readable);
  lines.push("}");
  lines.push("");
  if (cls.urls.length) {
    lines.push("-- discovered fetch targets");
    for (const u of cls.urls.slice(0, 20)) {
      lines.push(`-- ${u}`);
    }
    lines.push("");
  }
  const calls = [];
  const callRe = /([\w.:]+)\s*\(\s*(["'])((?:\\.|[^\\])*?)\2/g;
  let m;
  const src = String(source ?? "");
  while ((m = callRe.exec(src))) {
    const fn = m[1];
    const arg = decodeLuaStringLiteral(m[3]);
    if (arg.length >= 3 && isUseful(arg) && !/^[\\x0-9]+$/.test(fn)) {
      calls.push({ fn, arg });
    }
    if (calls.length > 120) break;
  }
  if (calls.length) {
    lines.push("-- observed call sites with literal arguments");
    for (const c of calls.slice(0, 80)) {
      lines.push(`-- ${c.fn}(${luaQuote(c.arg)})`);
    }
    lines.push("");
  }
  for (const e of extra) lines.push(e);
  lines.push("return recovered");
  const body = lines.join("\n").replace(/\/\//g, "--");
  return stampSource(body, [`engine: hard lift / ${obfuscatorLabel}`]);
}

export function reconstructLogic(source, { obfuscatorLabel = "logic remake" } = {}) {
  const src = String(source ?? "");
  const strings = extractStrings(src, { max: 8000 });
  const cls = classifyStrings(strings);
  const genvWrites = [];
  const remotes = [];
  const fetches = [];
  const uiCalls = [];
  const fnHints = new Set();

  const genvRe =
    /(?:getgenv\(\)|genv|_G)\s*(?:\.\s*([A-Za-z_][\w]*)|\s*\[\s*(["'])((?:\\.|[^\\])*?)\2\s*\])\s*=\s*([^\n]+)/g;
  let m;
  while ((m = genvRe.exec(src))) {
    genvWrites.push({ key: m[1] || m[3], value: (m[4] || "").trim().slice(0, 180) });
  }

  const remoteRe = /([A-Za-z_][\w.]*)\s*:\s*(FireServer|InvokeServer|FireClient)\s*\(([^)]*)\)/g;
  while ((m = remoteRe.exec(src))) {
    remotes.push({ name: m[1], method: m[2], args: m[3].slice(0, 120) });
  }
  for (const s of cls.remotes.concat(strings.filter((x) => /RemoteEvent|RemoteFunction/i.test(x)))) {
    if (!remotes.some((r) => r.name === s)) remotes.push({ name: s, method: "FireServer", args: "" });
  }

  for (const u of cls.urls) {
    if (/discord\.com\/api\/webhooks|fonts\.google|media\.discordapp/i.test(u)) continue;
    fetches.push(u);
  }

  const uiRe =
    /:(CreateWindow|CreateTab|AddTab|AddToggle|AddButton|AddSlider|AddDropdown|AddInput|CreateToggle|CreateButton|CreateSlider)\s*\(\s*\{?[^}]*Name\s*=\s*(["'])((?:\\.|[^\\])*?)\2/gi;
  while ((m = uiRe.exec(src))) {
    uiCalls.push({ kind: m[1], name: m[3] });
  }
  for (const s of cls.ui) {
    if (s.length < 48 && !uiCalls.some((u) => u.name === s)) uiCalls.push({ kind: "control", name: s });
  }

  for (const s of cls.readable) {
    if (/^[A-Z][A-Za-z0-9]+$/.test(s) && s.length >= 4 && s.length <= 32) fnHints.add(s);
  }

  const lines = [];
  lines.push(`-- logic remake (${obfuscatorLabel})`);
  lines.push("-- rebuilt from recovered calls, remotes, fetches, UI names and genv writes");
  lines.push("-- this is a behavior remake, not a pretty-print of the VM");
  lines.push("local script_key = script_key or (getgenv and getgenv().script_key) or ''");
  lines.push("local genv = (getgenv and getgenv()) or _G");
  lines.push("if script_key == '' then script_key = 'none' end");
  lines.push("");
  lines.push("local UI = { toggles = {}, buttons = {}, sliders = {} }");
  lines.push("local STR = {}");
  lines.push("");

  if (genvWrites.length) {
    lines.push("-- restored getgenv writes");
    for (const g of genvWrites.slice(0, 80)) {
      lines.push(`genv[${JSON.stringify(g.key)}] = ${JSON.stringify(g.value)}`);
    }
    lines.push("");
  }

  if (fetches.length) {
    lines.push("-- recovered fetch / load layer");
    lines.push("local function pull(url)");
    lines.push("  local ok, body = pcall(function()");
    lines.push("    return game:HttpGet(url)");
    lines.push("  end)");
    lines.push("  if ok and type(body) == 'string' and #body > 0 then");
    lines.push("    local fn, err = loadstring(body)");
    lines.push("    if fn then return fn() end");
    lines.push("    warn('load failed', err)");
    lines.push("  end");
    lines.push("end");
    for (const u of fetches.slice(0, 12)) {
      lines.push(`pcall(pull, ${JSON.stringify(u)})`);
    }
    lines.push("");
  }

  if (remotes.length) {
    lines.push("-- recovered remote traffic");
    lines.push("local function fire(name, method, ...)");
    lines.push("  local inst = nil");
    lines.push("  pcall(function() inst = game:GetService('ReplicatedStorage'):FindFirstChild(name, true) end)");
    lines.push("  if inst and inst[method] then inst[method](inst, ...) end");
    lines.push("end");
    for (const r of remotes.slice(0, 40)) {
      lines.push(`pcall(fire, ${JSON.stringify(r.name)}, ${JSON.stringify(r.method)}${r.args ? ", " + r.args : ""})`);
    }
    lines.push("");
  }

  if (uiCalls.length) {
    lines.push("-- recovered UI controls (logic stubs)");
    for (const c of uiCalls.slice(0, 60)) {
      const kind = /toggle/i.test(c.kind + c.name) ? "toggles" : /slider/i.test(c.kind + c.name) ? "sliders" : "buttons";
      lines.push(`UI.${kind}[${JSON.stringify(c.name)}] = function(...) end`);
    }
    lines.push("");
  }

  if (fnHints.size) {
    lines.push("-- named operations recovered from the blob");
    let i = 0;
    for (const n of fnHints) {
      if (i++ > 40) break;
      if (!/^[A-Za-z_]/.test(n)) continue;
      lines.push(`local function ${n}(...) end`);
    }
    lines.push("");
  }

  if (cls.webhooks.length) {
    lines.push("-- webhook endpoints observed");
    for (const w of cls.webhooks.slice(0, 8)) lines.push(`-- webhook ${w}`);
    lines.push("");
  }

  if (cls.readable.length) {
    lines.push("-- recovered string table");
    lines.push("STR = {");
    for (const s of cls.readable.slice(0, 80)) lines.push(`  ${JSON.stringify(s)},`);
    lines.push("}");
    lines.push("");
  }

  lines.push("return { ok = true, remade = true, ui = UI, strings = STR }");
  const body = lines.join("\n").replace(/\/\//g, "--");
  return stampSource(body, [`engine: logic remake / ${obfuscatorLabel}`]);
}

export function reconstructFromTrace(text, { obfuscatorLabel = "reconstruct" } = {}) {
  const lifted = String(text ?? "");
  if (/local recovered\s*=/.test(lifted) || /reconstructed from static lift/.test(lifted) || lifted.length < 160) {
    return reconstructLogic(lifted, { obfuscatorLabel });
  }
  let body = lifted;
  body = body.replace(/^\s*\/\//gm, "--");
  body = body.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m
      .split("\n")
      .map((l) => (l.trim().startsWith("--") ? l : "-- " + l))
      .join("\n"),
  );
  body = body.replace(/Key validation failed[^\n]*/g, "-- key check skipped (script_key stubbed)");
  body = body.replace(/invalid argument #1 to 'create' \(size out of range\)/g, "-- skipped buffer.create with out-of-range size");
  body = body.replace(/buffer\.create\(\s*\d{8,}\s*\)/g, "buffer.create(0) -- size clamped");
  if (!/local script_key/.test(body)) {
    body = "local script_key = script_key or getgenv and getgenv().script_key or 'none'\n" + body;
  }
  if (!body.trim() || /return recovered\s*$/.test(body.trim())) {
    return reconstructLogic(lifted, { obfuscatorLabel });
  }
  return stampSource(body, [`engine: reconstruct / ${obfuscatorLabel}`]);
}

export function dumpReport(source, obfuscatorLabel) {
  const strings = extractStrings(source, { max: 8000 });
  const cls = classifyStrings(strings);
  const lines = [];
  lines.push(`-- dump (${obfuscatorLabel})`);
  lines.push(`-- strings: ${strings.length}`);
  const section = (title, arr) => {
    lines.push("");
    lines.push(`-- === ${title} (${arr.length}) ===`);
    for (const v of arr) lines.push(v);
  };
  section("urls", cls.urls);
  section("webhooks", cls.webhooks);
  section("keys", cls.keys);
  section("ui", cls.ui);
  section("remotes", cls.remotes);
  section("strings", cls.readable);
  return stampSource(lines.join("\n"), ["command: .dump"]);
}
