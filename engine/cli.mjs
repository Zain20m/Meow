#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { runJob, ENGINE_LIST } from "./pipeline.mjs";

function parseArgs(argv) {
  const args = { mode: "deobf", input: null, output: null, obfuscator: "auto", reconstruct: false, forceUnknown: false, url: null, insta: false };
  const rest = argv.slice(2);
  if (rest[0] && !rest[0].startsWith("-")) {
    if (["deobf", "dump", "logui", "genvlog", "detect", "get", "help", "l", "playbook"].includes(rest[0])) {
      args.mode = rest.shift();
    }
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--obfuscator" || a === "-e") args.obfuscator = rest[++i];
    else if (a === "--output" || a === "-o") args.output = rest[++i];
    else if (a === "--reconstruct") args.reconstruct = true;
    else if (a === "--force-unknown") args.forceUnknown = true;
    else if (a === "--insta") args.insta = true;
    else if (a === "--url") args.url = rest[++i];
    else if (a === "--json") args.json = true;
    else if (!a.startsWith("-") && !args.input) args.input = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.mode === "help") {
    process.stdout.write(`6.5mz deobf
  node engines/cli.mjs deobf <file> [-e engine] [-o out] [--reconstruct] [--force-unknown]
  node engines/cli.mjs dump|logui|genvlog|detect <file>
engines: auto ${ENGINE_LIST.map((e) => e.id).join(" ")}
`);
    return;
  }
  let source = "";
  if (args.input && fs.existsSync(args.input)) {
    source = fs.readFileSync(args.input, "latin1");
  } else if (args.url) {
    source = args.url;
  } else if (!process.stdin.isTTY) {
    source = fs.readFileSync(0, "latin1");
  } else {
    process.stderr.write("[!] no input\n");
    process.exit(2);
  }

  const result = await runJob({
    mode: args.mode,
    source,
    url: args.url,
    obfuscator: args.obfuscator,
    reconstruct: args.reconstruct,
    forceUnknown: args.forceUnknown,
    insta: args.insta,
    onLog: (l) => process.stderr.write(l + "\n"),
  });

  if (result.text && args.output) {
    fs.writeFileSync(args.output, result.text);
    process.stderr.write("[+] " + path.resolve(args.output) + "\n");
  }
  if (Array.isArray(result.files) && result.files.length && args.output) {
    const dir = path.join(path.dirname(args.output), "captures");
    fs.mkdirSync(dir, { recursive: true });
    const manifest = [];
    for (const f of result.files) {
      const name = String(f.name || "dump.lua").replace(/[^\w.\-]+/g, "_").slice(0, 80);
      fs.writeFileSync(path.join(dir, name), f.text || "", "utf8");
      manifest.push({ name, bytes: Buffer.byteLength(String(f.text || ""), "utf8") });
    }
    result.filesDir = dir;
    result.fileManifest = manifest;
    delete result.files;
  }

  if (args.json) {
    const payload = { ...result, text: undefined };
    process.stdout.write(JSON.stringify(payload));
    process.stdout.write("\n");
  } else if (result.text && !args.output) {
    process.stdout.write(result.text);
    if (!result.text.endsWith("\n")) process.stdout.write("\n");
  } else if (!result.ok && !result.needsUnknownConfirm) {
    process.stderr.write("[!] " + (result.error || "failed") + "\n");
    process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write("[!] " + (e.stack || e.message || e) + "\n");
  process.exit(1);
});
