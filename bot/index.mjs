#!/usr/bin/env node
/**
 * 6.5mz Discord deobfuscator bot
 * Prefix: .   Slash: /deobf
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
} from "discord.js";
import { runJob, ENGINE_LIST, detect, fiveLinePreview } from "../engines/pipeline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DATA = path.join(ROOT, "data");
const STATUS = path.join(DATA, "bot-status.json");
const LAST = path.join(DATA, "last");
const JOBS = path.join(DATA, "jobs");
fs.mkdirSync(LAST, { recursive: true });
fs.mkdirSync(JOBS, { recursive: true });

const pending = new Map();

function botToken() {
  return (process.env.DISCORD_BOT_TOKEN || "").trim();
}

function botAppId() {
  return (process.env.DISCORD_APP_ID || "").trim();
}

function writeStatus(patch) {
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(STATUS, "utf8"));
  } catch {
    cur = {};
  }
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  fs.writeFileSync(STATUS, JSON.stringify(next, null, 2));
}

function savePending(jobId, job) {
  const dir = path.join(JOBS, jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "source.lua"), job.source, "latin1");
  const { source, ...meta } = job;
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ ...meta, at: Date.now() }));
  pending.set(jobId, { ...job, at: job.at || Date.now() });
}

function loadPending(jobId) {
  if (pending.has(jobId)) return pending.get(jobId);
  const dir = path.join(JOBS, jobId);
  const metaPath = path.join(dir, "meta.json");
  const srcPath = path.join(dir, "source.lua");
  if (!fs.existsSync(metaPath) || !fs.existsSync(srcPath)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const job = { ...meta, source: fs.readFileSync(srcPath, "latin1") };
    pending.set(jobId, job);
    return job;
  } catch {
    return null;
  }
}

function hydratePending() {
  try {
    for (const id of fs.readdirSync(JOBS)) {
      loadPending(id);
    }
  } catch {
    /* ignore */
  }
}
hydratePending();

const helpText = `**6.5mz deobf**

Prefix \`.\` needs **Message Content Intent** turned on in the Developer Portal. Slash commands work without it.

\`\`\`
.deobf  /deobf
        file or url, then pick one of the 13 deobfuscators

.luarmorfetch  /luarmorfetch
        loader url / file / loadstring
        sends the captured loadstring files
        plus the first 5 lines of each

.help  /help
\`\`\`

\`.deobf https://...\` downloads the file first. Green button = detected obfuscator.`;

const DEOBF_PICKS = [
  { id: "f77", label: "77fuscator" },
  { id: "clyde", label: "Clyde" },
  { id: "flowauth", label: "FlowAuth" },
  { id: "ironveil", label: "Ironveil" },
  { id: "luaobfuscator", label: "LuaObfuscator" },
  { id: "luast", label: "Luast" },
  { id: "luraph_v15_1", label: "Luraph 15.1" },
  { id: "moonsec", label: "Moonsec" },
  { id: "prometheus", label: "Prometheus" },
  { id: "centurion", label: "Centurion" },
  { id: "hercules", label: "Hercules" },
  { id: "ironbrew2", label: "IronBrew 2" },
  { id: "luraph_v14x", label: "Luraph 14.x/15" },
];

function scoresEmbed(scores, best) {
  const lines = scores
    .slice(0, 12)
    .map((s) => {
      const pct = Math.round(s.confidence * 100);
      const mark = s.id === best?.id ? "●" : "○";
      const beta = s.beta ? " β" : "";
      return `${mark} **${s.label}**${beta} — ${pct}%`;
    })
    .join("\n");
  return lines || "no fingerprints";
}

function engineButtons(jobId, scores, best, { skip = new Set() } = {}) {
  const top = [];
  const seen = new Set(skip);
  const push = (id, label, style) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    top.push({ id, label, style });
  };
  if (best?.id && best.id !== "unknown") push(best.id, best.label, ButtonStyle.Success);
  for (const e of ENGINE_LIST.filter((x) => x.real)) {
    push(e.id, e.label, e.id === best?.id ? ButtonStyle.Success : ButtonStyle.Secondary);
  }
  if (!skip.has("unknown")) push("unknown", "Hard lift", ButtonStyle.Secondary);
  const rows = [];
  const used = new Set();
  for (let i = 0; i < top.length && rows.length < 5; i += 5) {
    const row = new ActionRowBuilder();
    for (const b of top.slice(i, i + 5)) {
      const cid = `run:${jobId}:${b.id}`;
      if (used.has(cid)) continue;
      used.add(cid);
      row.addComponents(
        new ButtonBuilder().setCustomId(cid).setLabel(b.label.slice(0, 80)).setStyle(b.style),
      );
    }
    if (row.components.length) rows.push(row);
  }
  return rows;
}

function pickerPayload(jobId, det, name, bytes) {
  const bestId = det?.best?.id || "";
  const rows = [];
  for (let i = 0; i < DEOBF_PICKS.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const b of DEOBF_PICKS.slice(i, i + 5)) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`run:${jobId}:${b.id}`)
          .setLabel(b.label.slice(0, 80))
          .setStyle(b.id === bestId ? ButtonStyle.Success : ButtonStyle.Secondary),
      );
    }
    if (row.components.length) rows.push(row);
  }
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cancel:${jobId}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    ),
  );
  const hit = DEOBF_PICKS.find((b) => b.id === bestId);
  const detected = hit ? hit.label : "pick one";
  const embed = new EmbedBuilder()
    .setColor(0x5dba7a)
    .setTitle("Choose a deobfuscator")
    .setDescription(`Detected: **${detected}**${hit ? " (green)" : ""}\n${name || "input.lua"} · ${Math.round((bytes || 0) / 1024)} KB`)
    .setFooter({ text: "13 deobfuscators" });
  return {
    content: "Choose a deobfuscator",
    embeds: [embed],
    components: rows,
  };
}

function jobDetection(job) {
  return {
    unknown: !!job.unknown,
    best: job.bestId ? { id: job.bestId, label: job.bestLabel || job.bestId } : null,
    scores: Array.isArray(job.scores) ? job.scores : [],
  };
}

function previewBox(text) {
  const p = fiveLinePreview(text || "");
  return "```lua\n" + p.slice(0, 900) + "\n```";
}

function saveLast(userId, filename, text, extra = {}) {
  const dir = path.join(LAST, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, filename);
  fs.writeFileSync(file, text);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ file, filename, at: Date.now(), ...extra }));
  return file;
}

function getLast(userId) {
  const meta = path.join(LAST, String(userId), "meta.json");
  if (!fs.existsSync(meta)) return null;
  try {
    return JSON.parse(fs.readFileSync(meta, "utf8"));
  } catch {
    return null;
  }
}

function isDeniedBody(buf, status) {
  if (status === 401 || status === 403) {
    const head = Buffer.isBuffer(buf) ? buf.toString("utf8", 0, 800) : String(buf || "").slice(0, 800);
    if (/<!DOCTYPE|<html|unauthorized|not authorized|error code:|AccessDenied|This content is no longer available/i.test(head)) {
      return true;
    }
    if (buf.length < 400) return true;
  }
  return false;
}

async function downloadBuffer(url, extraHeaders = {}) {
  const headers = {
    "User-Agent": "DiscordBot (https://github.com/discordjs/discord.js, 14.16.3) Node.js/22",
    Accept: "*/*",
    ...extraHeaders,
  };
  const tok = botToken();
  if (tok && /discord(app)?\.com|discord\.gg/i.test(url) && !headers.Authorization) {
    headers.Authorization = `Bot ${tok}`;
  }
  const res = await fetch(url, { headers, redirect: "follow" });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, type: res.headers.get("content-type") || "" };
}

async function downloadAttachment(attach) {
  const urls = [attach.url, attach.proxyURL].filter(Boolean);
  const attempts = [];
  const tok = botToken();
  for (const url of urls) {
    attempts.push({ url, headers: {} });
    if (tok) attempts.push({ url, headers: { Authorization: `Bot ${tok}` } });
    attempts.push({
      url,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });
  }
  let last = null;
  for (const a of attempts) {
    try {
      const got = await downloadBuffer(a.url, a.headers);
      last = got;
      if (!isDeniedBody(got.buf, got.status) && got.buf.length > 0) return got;
    } catch {
      /* next */
    }
  }
  if (last && last.buf.length > 8 && !isDeniedBody(last.buf, last.status)) return last;
  const hint = last ? `host returned ${last.status} ${last.status === 403 ? "unauthorized" : ""}`.trim() : "download failed";
  throw new Error(`${hint}. Re-upload the file or paste the loadstring — Discord blocked the attachment URL.`);
}

async function grabSource(message, extra) {
  const attach = message.attachments?.first?.() || [...(message.attachments?.values?.() || [])][0];
  if (attach) {
    const got = await downloadAttachment(attach);
    return { source: got.buf.toString("latin1"), name: attach.name || "input.lua", bytes: got.buf.length };
  }
  const ref = message.reference?.messageId;
  if (ref) {
    try {
      const orig = await message.channel.messages.fetch(ref);
      const a = orig.attachments?.first?.();
      if (a) {
        const got = await downloadAttachment(a);
        return { source: got.buf.toString("latin1"), name: a.name || "input.lua", bytes: got.buf.length };
      }
      if (orig.content) return { source: orig.content, name: "message.lua", bytes: orig.content.length };
    } catch (e) {
      if (/host returned|unauthorized|403/i.test(String(e.message || e))) throw e;
    }
  }
  if (extra && extra.trim()) return { source: extra.trim(), name: "paste.lua", bytes: extra.trim().length };
  return null;
}

function reconRow(jobId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`recon:${jobId}`).setLabel("Reconstruct logic").setStyle(ButtonStyle.Success),
  );
}

async function deliverResult(target, result, userId, filenameBase, jobId) {
  if (!result.ok) {
    const err = result.error || "deobfuscation failed";
    const extra = result.reconstructAvailable ? "\nReconstruct remakes the script from recovered logic." : "";
    const components = result.reconstructAvailable && jobId ? [reconRow(jobId)] : [];
    await target.edit?.({ content: `**Failed**\n${err}${extra}`, embeds: [], components }).catch(async () => {
      await target.reply?.({ content: `**Failed**\n${err}${extra}`, components });
    });
    return;
  }
  const name = `${filenameBase || "result"}.lua`;
  const file = saveLast(userId, name, result.text, { source: result.source || "" });
  const extras = Array.isArray(result.files) ? result.files : [];
  const atts = [
    ...(result.filesOnly
      ? []
      : [new AttachmentBuilder(Buffer.from(result.text || "", "utf8"), { name })]),
    ...extras.slice(0, 10).map((f, i) =>
      new AttachmentBuilder(Buffer.from(String(f.text || ""), "utf8"), {
        name: String(f.name || `loadstring${i}.txt`).slice(0, 80),
      }),
    ),
  ].slice(0, 10);
  const head = result.partial ? "Partial" : "Deobfuscated";
  const extraNote = extras.length && !result.filesOnly ? `\n${extras.length} extra file(s) attached.` : "";
  const body = result.previewBlocks
    ? String(result.previewBlocks)
    : `**${head}** — ${result.engine || result.detection?.best?.label || "engine"}${extraNote}\n${previewBox(result.text)}`;
  const components = result.partial && jobId ? [reconRow(jobId)] : [];
  const payload = { content: body.slice(0, 1900), files: atts, embeds: [], components };
  try {
    if (target.edit) await target.edit(payload);
    else await target.reply(payload);
  } catch {
    await target.channel?.send?.(payload);
  }
  return file;
}

async function executeMode(interactionOrMsg, { mode, source, name, engine, forceUnknown, reconstruct, userId, jobId }) {
  const isIx = typeof interactionOrMsg.editReply === "function";
  const logs = [];
  const tick = async () => {
    const tail = logs.slice(-8).join("\n").slice(0, 1400);
    const content = `**running ${mode}** \`${name}\`\n\`\`\`\n${tail}\n\`\`\``;
    try {
      if (isIx) await interactionOrMsg.editReply({ content, components: [] });
      else await interactionOrMsg.edit({ content, embeds: [], components: [] });
    } catch {
      /* ignore */
    }
  };
  let lastTick = 0;
  const result = await runJob({
    mode,
    source,
    obfuscator: engine || "auto",
    forceUnknown: !!forceUnknown,
    reconstruct: !!reconstruct,
    onLog: (l) => {
      logs.push(l);
      const now = Date.now();
      if (now - lastTick > 2500) {
        lastTick = now;
        tick();
      }
    },
  });
  await deliverResult(
    isIx ? { edit: (p) => interactionOrMsg.editReply(p), channel: interactionOrMsg.channel } : interactionOrMsg,
    result,
    userId,
    name.replace(/\.[^.]+$/, "") + "." + mode,
    jobId,
  );
  return result;
}

const token = botToken();
const appId = botAppId();
if (!token) {
  writeStatus({ online: false, error: "missing token" });
  console.error("[6.5mz] missing bot token");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

async function registerSlash() {
  if (!appId) return;
  const cmds = [
    new SlashCommandBuilder()
      .setName("deobf")
      .setDescription("Deobfuscate a Lua/Luau file")
      .addAttachmentOption((o) => o.setName("file").setDescription("Obfuscated .lua").setRequired(false))
      .addStringOption((o) => o.setName("source").setDescription("URL, loadstring, or pasted snippet"))
      .addStringOption((o) =>
        o
          .setName("engine")
          .setDescription("Force an engine (default: detect then choose)")
          .addChoices(
            { name: "Choose after download", value: "choose" },
            { name: "77fuscator", value: "f77" },
            { name: "Clyde", value: "clyde" },
            { name: "FlowAuth", value: "flowauth" },
            { name: "Ironveil", value: "ironveil" },
            { name: "LuaObfuscator", value: "luaobfuscator" },
            { name: "Luast", value: "luast" },
            { name: "Luraph 15.1", value: "luraph_v15_1" },
            { name: "Moonsec", value: "moonsec" },
            { name: "Prometheus", value: "prometheus" },
            { name: "Centurion", value: "centurion" },
            { name: "Hercules", value: "hercules" },
            { name: "IronBrew 2", value: "ironbrew2" },
            { name: "Luraph 14.x/15", value: "luraph_v14x" },
          ),
      ),
    new SlashCommandBuilder().setName("help").setDescription("6.5mz deobf commands"),
    new SlashCommandBuilder()
      .setName("luarmorfetch")
      .setDescription("Dump every loadstring file from a Luarmor loader")
      .addAttachmentOption((o) => o.setName("file").setDescription("Loader .lua").setRequired(false))
      .addStringOption((o) => o.setName("source").setDescription("URL, script_key loader, or loadstring")),
  ].map((c) => c.toJSON());
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(appId), { body: cmds });
}

client.once(Events.ClientReady, async (c) => {
  writeStatus({
    online: true,
    error: null,
    username: c.user.tag,
    userId: c.user.id,
    guilds: c.guilds.cache.size,
  });
  c.user.setPresence({ activities: [{ name: ".help · 6.5mz deobf" }], status: "online" });
  try {
    await registerSlash();
  } catch (e) {
    console.error("[6.5mz] slash register", e.message);
  }
  console.log("[6.5mz] online as", c.user.tag);
});

function parsePrefix(content) {
  let text = String(content || "")
    .replace(/^\uFEFF/, "")
    .replace(/\u200b/g, "")
    .trim();
  text = text.replace(/^<@!?\d+>\s*/, "");
  text = text.replace(/^[\uFF0E\u2024\uFE52\u3002]/, ".");
  if (!text.startsWith(".")) return null;
  const [rawCmd, ...rest] = text.slice(1).split(/\s+/);
  const cmd = (rawCmd || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!cmd) return null;
  return { cmd, extra: rest.join(" ") };
}

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.partial) {
      try {
        message = await message.fetch();
      } catch {
        return;
      }
    }
  } catch {
    return;
  }
  if (!message || message.author?.bot) return;
  const parsed = parsePrefix(message.content);
  const dmWithFile = !parsed && !message.guildId && message.attachments?.size;
  if (!parsed && !dmWithFile) return;
  const cmd = parsed?.cmd || "deobf";
  const extra = parsed?.extra || "";

  try {
    if (cmd === "help") {
      await message.reply({ embeds: [new EmbedBuilder().setColor(0x5dba7a).setTitle("6.5mz deobf").setDescription(helpText)] });
      return;
    }
    if (cmd === "get") {
      if (extra.trim() || message.attachments?.size) {
        const grabbed = await grabSource(message, extra);
        if (!grabbed) {
          await message.reply("Pass a URL / loadstring, or attach a file.");
          return;
        }
        const status = await message.reply({ content: `**fetching** \`${grabbed.name}\`…` });
        await executeMode(status, {
          mode: "get",
          source: grabbed.source,
          name: grabbed.name,
          userId: message.author.id,
          forceUnknown: true,
        });
        return;
      }
      const last = getLast(message.author.id);
      if (!last || !fs.existsSync(last.file)) {
        await message.reply("No saved result. Run `.deobf` first, or `.get <url>` to sneak-fetch a file.");
        return;
      }
      await message.reply({
        content: "Last result",
        files: [new AttachmentBuilder(last.file, { name: last.filename })],
      });
      return;
    }

    if (cmd === "luarmorfetch") {
      const grabbed = await grabSource(message, extra);
      if (!grabbed) {
        await message.reply("Attach the loader, or paste the URL / `loadstring(game:HttpGet(...))()`.");
        return;
      }
      const status = await message.reply({ content: `**luarmor fetch** \`${grabbed.name}\` — hooking loadstring…` });
      await executeMode(status, {
        mode: "luarmorfetch",
        source: grabbed.source,
        name: grabbed.name,
        userId: message.author.id,
        forceUnknown: true,
      });
      return;
    }

    const modeMap = { deobf: "deobf", dump: "dump", logui: "logui", genvlog: "genvlog", l: "l" };
    const mode = modeMap[cmd];
    if (!mode) return;

    const grabbed = await grabSource(message, extra);
    if (!grabbed) {
      await message.reply("Attach a `.lua` file, reply to one, or pass a URL / loadstring.");
      return;
    }

    const status = await message.reply({
      content: /https?:\/\//i.test(grabbed.source.slice(0, 500))
        ? `**fetching** \`${grabbed.name}\` then choose a deobfuscator…`
        : `**file ready** \`${grabbed.name}\` (${Math.round(grabbed.bytes / 1024)} KB) — choose a deobfuscator…`,
    });

    if (mode !== "deobf") {
      await executeMode(status, {
        mode,
        source: grabbed.source,
        name: grabbed.name,
        userId: message.author.id,
        forceUnknown: true,
      });
      return;
    }

    const detectionJob = await runJob({
      mode: "detect",
      source: grabbed.source,
      onLog: () => {},
    });
    if (detectionJob.damaged) {
      await status.edit({ content: `**Damaged input**\n${detectionJob.error}` });
      return;
    }
    if (detectionJob.error && !detectionJob.ok && !detectionJob.needsUnknownConfirm) {
      await status.edit({ content: `**Failed**\n${detectionJob.error}` });
      return;
    }
    const peeled = detectionJob.source || grabbed.source;
    const det = detectionJob.detection || detect(peeled);
    const jobId = `${message.id}`;
    savePending(jobId, {
      source: peeled,
      name: grabbed.name,
      userId: message.author.id,
      channelId: message.channel.id,
      at: Date.now(),
      bestId: det.best?.id || "unknown",
      bestLabel: det.best?.label || "Hard lift",
      unknown: !!det.unknown,
      scores: det.scores || [],
    });

    await status.edit(pickerPayload(jobId, det, grabbed.name, peeled.length || grabbed.bytes));
  } catch (e) {
    await message.reply("Error: " + (e.message || e)).catch(() => {});
  }
});

client.on(Events.InteractionCreate, async (ix) => {
  try {
    if (ix.isChatInputCommand()) {
      if (ix.commandName === "help") {
        await ix.reply({ embeds: [new EmbedBuilder().setColor(0x5dba7a).setTitle("6.5mz deobf").setDescription(helpText)] });
        return;
      }
      if (ix.commandName === "luarmorfetch") {
        await ix.deferReply();
        const file = ix.options.getAttachment("file");
        const srcOpt = ix.options.getString("source") || "";
        let source = srcOpt;
        let name = "loader.lua";
        if (file) {
          const got = await downloadAttachment(file);
          source = got.buf.toString("latin1");
          name = file.name || name;
        }
        if (!source) {
          await ix.editReply("Attach the loader or pass the URL / loadstring.");
          return;
        }
        await executeMode(ix, {
          mode: "luarmorfetch",
          source,
          name,
          userId: ix.user.id,
          forceUnknown: true,
        });
        return;
      }
      if (ix.commandName === "deobf") {
        await ix.deferReply();
        const file = ix.options.getAttachment("file");
        const srcOpt = ix.options.getString("source");
        const engine = ix.options.getString("engine") || "choose";
        let source = srcOpt || "";
        let name = "paste.lua";
        if (file) {
          const got = await downloadAttachment(file);
          source = got.buf.toString("latin1");
          name = file.name || name;
        }
        if (!source) {
          await ix.editReply("Attach a file or pass a URL / loadstring.");
          return;
        }
        if (engine === "choose") {
          const detectionJob = await runJob({ mode: "detect", source, onLog: () => {} });
          const peeled = detectionJob.source || source;
          const det = detectionJob.detection || detect(peeled);
          const jobId = `s${ix.id}`;
          savePending(jobId, {
            source: peeled,
            name,
            userId: ix.user.id,
            channelId: ix.channelId,
            at: Date.now(),
            bestId: det.best?.id || "unknown",
            bestLabel: det.best?.label || "Hard lift",
            unknown: !!det.unknown,
            scores: det.scores || [],
          });
          await ix.editReply(pickerPayload(jobId, det, name, peeled.length));
          return;
        }
        await executeMode(ix, { mode: "deobf", source, name, engine, userId: ix.user.id, forceUnknown: true });
      }
      return;
    }

    if (!ix.isButton()) return;
    const [kind, jobId, engine] = ix.customId.split(":");
    if (kind === "cancel") {
      pending.delete(jobId);
      await ix.update({ content: "Cancelled.", embeds: [], components: [] });
      return;
    }
    const job = loadPending(jobId);
    if (!job) {
      await ix.reply({ content: "Job expired. Run `.deobf` again.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (kind === "recon") {
      await ix.update({ content: `**reconstructing logic** on ${job.name}…`, embeds: [], components: [] });
      const fake = { edit: (p) => ix.editReply(p), channel: ix.channel };
      await executeMode(fake, {
        mode: "deobf",
        source: job.source,
        name: job.name,
        engine: "unknown",
        userId: job.userId,
        forceUnknown: true,
        reconstruct: true,
        jobId,
      });
      return;
    }
    if (kind !== "run") return;
    await ix.update({ content: `**running** \`${engine}\` on ${job.name}…`, embeds: [], components: [] });
    const fake = {
      edit: (p) => ix.editReply(p),
      channel: ix.channel,
    };
    await executeMode(fake, {
      mode: "deobf",
      source: job.source,
      name: job.name,
      engine,
      userId: job.userId,
      forceUnknown: engine === "unknown",
      jobId,
    });
  } catch (e) {
    try {
      if (ix.deferred || ix.replied) await ix.followUp({ content: "Error: " + (e.message || e), flags: MessageFlags.Ephemeral });
      else await ix.reply({ content: "Error: " + (e.message || e), flags: MessageFlags.Ephemeral });
    } catch {
      /* ignore */
    }
  }
});

setInterval(() => {
  try {
    const now = Date.now();
    for (const [k, v] of pending) {
      if (now - (v.at || 0) > 30 * 60 * 1000) pending.delete(k);
    }
  } catch {
    /* never crash the bot from the sweeper */
  }
}, 60_000);

process.on("SIGINT", () => {
  writeStatus({ online: false, error: "stopped" });
  client.destroy();
  process.exit(0);
});
process.on("uncaughtException", (e) => {
  console.error("[6.5mz] uncaught", e);
  if (client?.isReady?.()) {
    writeStatus({ online: true, error: String(e.message || e).slice(0, 180) });
  } else {
    writeStatus({ online: false, error: e.message });
  }
});
process.on("unhandledRejection", (e) => {
  console.error("[6.5mz] rejection", e);
});

writeStatus({ online: false, error: "connecting", username: null });
client.login(token).catch((e) => {
  writeStatus({ online: false, error: e.message || String(e) });
  console.error("[6.5mz] login failed", e);
  process.exit(1);
});
