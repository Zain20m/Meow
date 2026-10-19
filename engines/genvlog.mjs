import { stampSource } from "./stamp.mjs";
import { extractStrings } from "./static-lift.mjs";

function decode(raw) {
  return String(raw ?? "")
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([0-9]{1,3})/g, (_, n) => String.fromCharCode(Number(n) & 255));
}

export function genvLog(source) {
  const s = String(source ?? "");
  const assigns = [];
  const keys = new Set();
  const seen = new Set();

  const push = (key, value) => {
    key = decode(key).trim();
    if (!key || key.length > 80 || /https?:|function |local /.test(key)) return;
    if (seen.has(key + "\0" + value)) return;
    seen.add(key + "\0" + value);
    keys.add(key);
    assigns.push({ key, value: String(value ?? "").trim().slice(0, 220) });
  };

  const patterns = [
    /getgenv\(\)\s*(?:\.\s*([A-Za-z_][\w]*)|\s*\[\s*(["'])((?:\\.|[^\\])*?)\2\s*\])\s*=\s*([^\n]+)/g,
    /(?:shared|genv|_G)\s*(?:\.\s*([A-Za-z_][\w]*)|\s*\[\s*(["'])((?:\\.|[^\\])*?)\2\s*\])\s*=\s*([^\n]+)/g,
    /getrenv\(\)\s*(?:\.\s*([A-Za-z_][\w]*)|\s*\[\s*(["'])((?:\\.|[^\\])*?)\2\s*\])\s*=\s*([^\n]+)/g,
    /getgenv\s*\(\s*\)\s*\[\s*(["'])((?:\\.|[^\\])*?)\1\s*\]\s*=\s*([^\n]+)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(s))) {
      const key = m[1] || m[3] || m[2];
      const val = m[4] || m[3] || "";
      push(key, val);
    }
  }

  const callSet = /(?:getgenv|getrenv)\(\)\s*\[\s*(["'])((?:\\.|[^\\])*?)\1\s*\]/g;
  let m;
  while ((m = callSet.exec(s))) push(m[2], "true");

  const dotted = /getgenv\(\)\.([A-Za-z_][\w]*)/g;
  while ((m = dotted.exec(s))) push(m[1], "true");

  for (const str of extractStrings(s, { max: 4000 })) {
    if (/^[A-Za-z_][\w]{2,40}$/.test(str) && /TARGET|WEBHOOK|KEY|URL|USER|TOGGLE|SPEED|MODE|SCRIPT|HWID|AIM|ESP|CONFIG|THEME/i.test(str)) {
      push(str, "true");
    }
  }

  const lines = [];
  lines.push("-- getgenv log (executable)");
  lines.push(`-- assigns ${assigns.length}, keys ${keys.size}`);
  lines.push("local genv = (getgenv and getgenv()) or _G");
  lines.push("local observed = {}");
  lines.push("");
  for (const a of assigns.slice(0, 200)) {
    const rhs = /^[A-Za-z_][\w.]*$/.test(a.value) || /^(true|false|nil|-?\d+(\.\d+)?)$/.test(a.value)
      ? a.value
      : JSON.stringify(a.value);
    lines.push(`observed[${JSON.stringify(a.key)}] = ${rhs}`);
    lines.push(`genv[${JSON.stringify(a.key)}] = observed[${JSON.stringify(a.key)}]`);
  }
  for (const k of keys) {
    if (!assigns.some((a) => a.key === k)) {
      lines.push(`observed[${JSON.stringify(k)}] = true`);
      lines.push(`genv[${JSON.stringify(k)}] = true`);
    }
  }
  if (!keys.size) {
    lines.push("-- no plaintext getgenv writes in this layer");
    lines.push("-- obfuscated VMs hide keys until after deobf / luraph lift");
  }
  lines.push("return { assigns = observed, count = " + assigns.length + " }");
  return stampSource(lines.join("\n"), ["command: .genvlog"]);
}
