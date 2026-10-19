export const STAMP = "-- deobf by 6.5mz";

export function stampSource(text, extraLines = []) {
  const body = String(text ?? "").replace(/^\uFEFF/, "");
  const extras = extraLines.filter(Boolean).map((l) => (l.startsWith("--") ? l : `-- ${l}`));
  const stripped = body.replace(/^-- deobf by 6\.5mz\n(?:-- .*\n)*/, "");
  return [STAMP, ...extras, "", stripped.replace(/^\n+/, "")].join("\n");
}

export function fiveLinePreview(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .filter((l, i, arr) => !(i < 8 && l.startsWith("--") && !l.includes("function") && !l.includes("local")))
    .filter((l) => l.trim() !== "");
  const take = lines.slice(0, 5);
  if (!take.length) {
    return String(text ?? "")
      .split(/\r?\n/)
      .slice(0, 5)
      .join("\n");
  }
  return take.join("\n");
}

export function looksTruncated(source) {
  const s = String(source ?? "").trim();
  if (!s) return { truncated: true, reason: "empty input" };
  if (s.length < 40 && /^(loadstring|script_key|getgenv)/i.test(s)) {
    return { truncated: false };
  }
  const start = s.slice(0, 24).replace(/^\uFEFF/, "");
  if (start.startsWith("{") && !/^[A-Za-z_]/.test(s)) {
    return {
      truncated: true,
      reason: "file starts with '{': Discord paste/upload truncated the script. Attach the original .lua file (do not paste 100KB+ into chat).",
    };
  }
  const opens = (s.match(/\(/g) || []).length;
  const closes = (s.match(/\)/g) || []).length;
  if (s.length > 2000 && opens > closes + 12 && /\\[0-9]{1,3}$/.test(s.slice(-20))) {
    return { truncated: true, reason: "script ends mid-escape sequence — the upload was cut off" };
  }
  return { truncated: false };
}
