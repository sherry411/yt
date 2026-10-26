/**
 * TrackGrab — YouTube add-on router.
 *
 * A NON-DESTRUCTIVE, drop-in Express router that adds YouTube support to the
 * existing TrackGrab backend, powering the WordPress plugin:
 *   • SCloud YouTube Downloader  (y2mate-style audio downloader)
 *
 * It mirrors the SoundCloud routes in server.js (same yt-dlp + ffmpeg, same
 * HMAC download-link signature, same priority-aware queue idea) but scoped to
 * YouTube URLs and mounted on its OWN paths so nothing in server.js changes:
 *
 *   GET  /yt-info        → { title, uploader, thumbnail, duration, ... } or a playlist
 *   GET  /yt-download    → signed, streams the extracted audio (attachment)
 *   GET  /yt-video-info  → { title, ..., qualities:[{height,label,...}] } for one video
 *   GET  /yt-video-download → signed, streams a muxed MP4 at the chosen quality
 *   GET  /yt-diag        → yt-dlp / ffmpeg health for the YouTube routes
 *
 * ── Wiring (one line in server.js) ──
 *      const ytRouter = require("./youtube");
 *      app.use(ytRouter);
 *
 * That's it. yt-dlp already extracts YouTube natively, so no new dependency is
 * needed. The shared secret defaults to the SAME value server.js uses, so the
 * signed links from the WordPress plugins are accepted out of the box; set your
 * own SCLOUD_API_SECRET on both sides for real security.
 */

const express = require("express");
const { execFile, spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const https = require("https");

const router = express.Router();

// ── Config (shares server.js's env; safe defaults keep it working as-is) ──────
const YTDLP_BIN = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG_LOCATION = process.env.FFMPEG_LOCATION || "";
const YTDLP_CACHE_DIR = process.env.YTDLP_CACHE_DIR || path.join(os.tmpdir(), "yt-dlp-cache");
const YTDLP_FRAGMENTS = Math.max(1, parseInt(process.env.YTDLP_FRAGMENTS || "4", 10) || 4);

// Same shared-default secret as server.js so the WordPress plugins' signed links
// validate immediately. Override with SCLOUD_API_SECRET on both sides for security.
const SCLOUD_SHARED_DEFAULT_SECRET =
  "58a6bad22af816266aa838514070d59a2f36a94d426d1f44a1e144d9024db3b7";
const API_SECRET =
  process.env.SCLOUD_API_OPEN === "1"
    ? ""
    : process.env.SCLOUD_API_SECRET || process.env.API_SECRET || SCLOUD_SHARED_DEFAULT_SECRET;

const SIG_LEEWAY_S = Math.max(0, parseInt(process.env.SIG_LEEWAY_S || "600", 10) || 600);

// Bound concurrent YouTube jobs so the box stays responsive; Pro ("priority")
// links jump the queue. Independent of server.js's SoundCloud queue.
const YT_MAX_CONCURRENT = Math.max(1, parseInt(process.env.YT_MAX_CONCURRENT || process.env.MAX_CONCURRENT || "2", 10) || 2);
const YT_MAX_QUEUE = Math.max(1, parseInt(process.env.YT_MAX_QUEUE || process.env.MAX_QUEUE || "30", 10) || 30);
const YT_TIMEOUT_S = Math.max(60, parseInt(process.env.YT_DOWNLOAD_TIMEOUT_S || process.env.DOWNLOAD_TIMEOUT_S || "900", 10) || 900);

// ── Formats (identical semantics to server.js) ───────────────────────────────
// lossless (wav/flac) ignore bitrate; canEmbed = tag/cover embedding supported.
const DOWNLOAD_FORMATS = {
  mp3:  { audioFormat: "mp3",  ext: "mp3",  mime: "audio/mpeg", lossless: false, canEmbed: true  },
  m4a:  { audioFormat: "m4a",  ext: "m4a",  mime: "audio/mp4",  lossless: false, canEmbed: true  },
  mp4:  { audioFormat: "m4a",  ext: "mp4",  mime: "audio/mp4",  lossless: false, canEmbed: true  },
  wav:  { audioFormat: "wav",  ext: "wav",  mime: "audio/wav",  lossless: true,  canEmbed: false },
  flac: { audioFormat: "flac", ext: "flac", mime: "audio/flac", lossless: true,  canEmbed: true  },
};

// ── Video (muxed MP4) config ──────────────────────────────────────────────────
// Heights the video downloader may offer. The WordPress plugin (fed by the plan)
// decides which of these a given visitor can pick and signs the chosen one, so
// the backend simply honours the signed height (bounded here to a known set).
const VIDEO_HEIGHTS = [144, 240, 360, 480, 720, 1080, 1440, 2160];

const VIDEO_CONTAINERS = {
  mp4:  "video/mp4",
  mkv:  "video/x-matroska",
  webm: "video/webm",
};

// ── URL validation / canonicalization for YouTube ─────────────────────────────
const YT_HOSTS = [
  "youtube.com", "www.youtube.com", "m.youtube.com",
  "music.youtube.com", "youtu.be", "www.youtu.be",
];

function isYouTubeUrl(raw) {
  try {
    const u = new URL(String(raw));
    const host = u.hostname.toLowerCase();
    return YT_HOSTS.includes(host) || host.endsWith(".youtube.com");
  } catch (e) {
    return false;
  }
}

// Is this URL a playlist/mix page (not a single watch/short)?
function isYouTubePlaylistUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (u.pathname.startsWith("/playlist")) return true;
    // A bare list= with no v= is a playlist page; a watch?v=...&list=... is a video.
    if (u.searchParams.get("list") && !u.searchParams.get("v") && !u.pathname.startsWith("/watch")) return true;
    return false;
  } catch (e) {
    return false;
  }
}

// Strip tracking params and normalize to a clean canonical URL.
function normalizeYouTubeUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (u.hostname.toLowerCase() === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0] || "";
      const t = u.searchParams.get("t");
      const out = new URL("https://www.youtube.com/watch");
      if (id) out.searchParams.set("v", id);
      if (t) out.searchParams.set("t", t);
      return out.toString();
    }
    // Drop known tracking/context params but keep v / list / index / t.
    ["si", "feature", "pp", "ab_channel", "utm_source", "utm_medium", "utm_campaign"].forEach((p) =>
      u.searchParams.delete(p)
    );
    return u.toString();
  } catch (e) {
    return String(raw);
  }
}

// ── Signature check (byte-for-byte the same scheme as server.js) ──────────────
function downloadSigCheck(q) {
  if (!API_SECRET) return { ok: true, reason: "" };
  const exp = parseInt(q.exp || "0", 10);
  if (!exp) return { ok: false, reason: "missing" };
  if (Date.now() / 1000 > exp + SIG_LEEWAY_S) return { ok: false, reason: "expired" };
  let payload = (q.url || "") + "\n" + (q.format || "") + "\n" + (q.title || "") + "\n" + String(q.exp);
  if (String(q.v || "") === "2") {
    payload += "\n" + (q.bitrate || "") + "\n" + (q.meta || "") + "\n" + (q.priority || "");
  } else {
    if (q.bitrate) payload += "\n" + q.bitrate;
    if (q.meta) payload += "\n" + q.meta;
  }
  const expected = crypto.createHmac("sha256", API_SECRET).update(payload).digest("hex");
  const a = Buffer.from(String(q.sig || ""));
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, reason: ok ? "" : "badsig" };
}

function apiKeyOk(req) {
  if (!API_SECRET) return true;
  return (req.get("x-api-key") || "") === API_SECRET;
}

// ── Helpers copied/adapted from server.js ─────────────────────────────────────
function bestThumb(obj) {
  if (!obj) return "";
  if (typeof obj.thumbnail === "string" && obj.thumbnail) return obj.thumbnail;
  const arr = Array.isArray(obj.thumbnails) ? obj.thumbnails : [];
  let best = "", bestW = -1;
  for (const t of arr) {
    if (t && t.url && typeof t.width === "number" && t.width > bestW) { best = t.url; bestW = t.width; }
  }
  if (best) return best;
  for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] && arr[i].url) return arr[i].url; }
  return "";
}

function flatTrackShape(e) {
  const id = e.id || "";
  const turl = e.url || e.webpage_url || (id ? `https://www.youtube.com/watch?v=${id}` : "");
  return {
    title: e.title || "Untitled",
    url: turl,
    uploader: e.uploader || e.channel || "",
    duration: typeof e.duration === "number" ? e.duration : null,
    thumbnail: bestThumb(e),
  };
}

function normalizeBitrate(raw) {
  const n = parseInt(String(raw || ""), 10);
  if (!Number.isFinite(n)) return "";
  if (n < 64) return "64";
  if (n > 320) return "320";
  return String(n);
}

function buildYtdlpArgs(fmt, opts) {
  const args = ["-x", "--audio-format", fmt.audioFormat];
  if (!fmt.lossless) {
    args.push("--audio-quality", opts.bitrate ? `${opts.bitrate}K` : "0");
  }
  if (opts.meta && fmt.canEmbed) {
    args.push("--embed-metadata");
    if (!fmt.lossless) {
      args.push("--embed-thumbnail", "--convert-thumbnails", "jpg");
    }
  }
  return args;
}

function classifyDownloadError(stderr) {
  const s = String(stderr || "");
  const low = s.toLowerCase();
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const detail = lines.length ? lines[lines.length - 1].slice(0, 300) : "";
  const has = (re) => re.test(low);

  if (
    has(/ffmpeg (is )?not (installed|found)/) || has(/ffprobe/) || has(/postprocessing/) ||
    has(/you have requested.*but ffmpeg/) || has(/preferred audio format/) || has(/ffmpeg-location/)
  ) {
    return { category: "ffmpeg", message: "The server's audio encoder (ffmpeg) is missing or failed.", hint: "Install ffmpeg + ffprobe on the server and put them on PATH (or set FFMPEG_LOCATION).", detail };
  }
  if (has(/sign in to confirm|not a bot|age.?restrict|age.?gate|confirm your age/)) {
    return { category: "restricted", message: "YouTube is asking the server to sign in (age-restricted or bot check).", hint: "Provide cookies to yt-dlp (YTDLP_COOKIES) or try a different video.", detail };
  }
  if (has(/private video|members-only|join this channel|this video is private/)) {
    return { category: "private", message: "This video is private or members-only, so it can't be downloaded.", hint: "Only public videos can be fetched.", detail };
  }
  if (has(/not available in your country|geo-?block|blocked it in your country|region/)) {
    return { category: "geo", message: "This video is region-blocked from the server's location.", hint: "It isn't available where the server is hosted.", detail };
  }
  if (has(/http error 429|too many requests|rate.?limit/)) {
    return { category: "ratelimit", message: "YouTube is rate-limiting the server right now.", hint: "Wait a minute and try again; if constant, lower YT_MAX_CONCURRENT.", detail };
  }
  if (has(/video unavailable|removed|terminated|no longer available|copyright/)) {
    return { category: "unavailable", message: "This video is unavailable (removed, private, or taken down).", hint: "Try a different video.", detail };
  }
  if (
    has(/unable to extract/) || has(/unable to download (webpage|json)/) || has(/unsupported url/) ||
    has(/nonetype/) || has(/no video formats|requested format/) || has(/failed to parse json|unable to parse/)
  ) {
    return { category: "extractor", message: "The downloader couldn't read this video — it's probably out of date.", hint: "Update yt-dlp on the server (yt-dlp -U or pip install -U yt-dlp), then restart.", detail };
  }
  return { category: "unknown", message: "The server couldn't produce this file.", hint: "Check the server logs for the yt-dlp / ffmpeg error. Most often it's an out-of-date yt-dlp.", detail };
}

function ffprobeProbePath() {
  return FFMPEG_LOCATION ? path.join(FFMPEG_LOCATION, "ffprobe") : (process.env.FFPROBE_PATH || "ffprobe");
}

function verifyDownloadedOutput(input, requested) {
  return new Promise((resolve) => {
    const pf = spawn(ffprobeProbePath(), [
      "-v", "error", "-show_entries", "format=format_name:stream=codec_name,codec_type",
      "-of", "json", input,
    ]);
    let out = "";
    pf.stdout.on("data", (d) => { out += d.toString(); if (out.length > 20000) out = out.slice(-20000); });
    pf.on("error", (e) => resolve({ ok: false, detail: e.code || e.message || "ffprobe_failed" }));
    pf.on("close", () => {
      try {
        const data = JSON.parse(out);
        const container = String(data && data.format && data.format.format_name || "").toLowerCase();
        const codecs = (Array.isArray(data && data.streams) ? data.streams : [])
          .filter((s) => s && s.codec_type === "audio")
          .map((s) => String(s.codec_name || "").toLowerCase());
        const ok =
          (requested === "mp3" && container.includes("mp3") && codecs.includes("mp3")) ||
          ((requested === "m4a" || requested === "mp4") && /mov|mp4|m4a/.test(container) && codecs.includes("aac")) ||
          (requested === "wav" && container.includes("wav") && codecs.some((c) => c.startsWith("pcm_"))) ||
          (requested === "flac" && container.includes("flac") && codecs.includes("flac"));
        resolve({ ok, detail: `container=${container || "?"}; codecs=${codecs.join(",") || "?"}` });
      } catch (e) {
        resolve({ ok: false, detail: "invalid_ffprobe_output" });
      }
    });
  });
}

// ── Video helpers ─────────────────────────────────────────────────────────────
// Signature for the video downloader. Byte-for-byte layout the WordPress video
// plugin must reproduce: url \n quality \n title \n exp \n priority
function videoSigCheck(q) {
  if (!API_SECRET) return { ok: true, reason: "" };
  const exp = parseInt(q.exp || "0", 10);
  if (!exp) return { ok: false, reason: "missing" };
  if (Date.now() / 1000 > exp + SIG_LEEWAY_S) return { ok: false, reason: "expired" };
  const payload = (q.url || "") + "\n" + (q.quality || "") + "\n" + (q.title || "") + "\n" + String(q.exp) + "\n" + (q.priority || "");
  const expected = crypto.createHmac("sha256", API_SECRET).update(payload).digest("hex");
  const a = Buffer.from(String(q.sig || ""));
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, reason: ok ? "" : "badsig" };
}

// Clamp a requested quality to a known height, or "" for "best available".
function normalizeVideoHeight(raw) {
  const s = String(raw || "").toLowerCase();
  if (s === "" || s === "best" || s === "max") return "";
  const n = parseInt(s.replace(/p$/, ""), 10);
  if (!Number.isFinite(n)) return "";
  // Snap to the nearest allowed height at or below the request.
  let pick = 0;
  for (const h of VIDEO_HEIGHTS) { if (h <= n && h > pick) pick = h; }
  return pick > 0 ? String(pick) : String(VIDEO_HEIGHTS[0]);
}

// yt-dlp format selector for (up to) the given height. Prefers a single
// progressive MP4 (streams to stdout instantly, no post-merge wait); then a
// merged H.264/AAC MP4; then anything that fits. Falls back with no cap last.
function videoFormatSelector(height) {
  const h = parseInt(height, 10);
  const cap = Number.isFinite(h) && h > 0 ? `[height<=${h}]` : "";
  return [
    `b${cap}[ext=mp4][vcodec^=avc1]`,          // progressive MP4 (instant stream)
    `b${cap}[ext=mp4]`,
    `bv*${cap}[vcodec^=avc1]+ba[acodec^=mp4a]`, // merged H.264 + AAC → clean MP4
    `bv*${cap}[ext=mp4]+ba[ext=m4a]`,
    `bv*${cap}+ba`,
    `b${cap}`,
    `bv*+ba`,
    `b`,
  ].join("/");
}

// Confirm the produced file actually carries a video stream (any container).
function verifyVideoOutput(input) {
  return new Promise((resolve) => {
    const pf = spawn(ffprobeProbePath(), [
      "-v", "error", "-show_entries", "format=format_name:stream=codec_name,codec_type",
      "-of", "json", input,
    ]);
    let out = "";
    pf.stdout.on("data", (d) => { out += d.toString(); if (out.length > 20000) out = out.slice(-20000); });
    pf.on("error", (e) => resolve({ ok: false, detail: e.code || e.message || "ffprobe_failed" }));
    pf.on("close", () => {
      try {
        const data = JSON.parse(out);
        const container = String(data && data.format && data.format.format_name || "").toLowerCase();
        const hasVideo = (Array.isArray(data && data.streams) ? data.streams : [])
          .some((s) => s && s.codec_type === "video");
        resolve({ ok: hasVideo, detail: `container=${container || "?"}; video=${hasVideo}` });
      } catch (e) {
        resolve({ ok: false, detail: "invalid_ffprobe_output" });
      }
    });
  });
}

// Optional cookies + proxy for yt-dlp — all read from env so the VPS can be
// configured without touching code (see Part 9 of the setup guide). Use these
// when YouTube blocks the datacenter IP ("Sign in to confirm you're not a bot",
// 429, empty output) or a video is age-restricted:
//   YTDLP_COOKIES              → path to a cookies.txt (Netscape format)
//   YTDLP_COOKIES_FROM_BROWSER → browser profile on the VPS, e.g. "chrome"
//   YTDLP_PROXY                → "http://user:pass@host:port" or "socks5://host:port"
// A cookies file (if present) wins over a browser profile; proxy is independent.
// Proxy pool: a single YTDLP_PROXY env, and/or a proxies.txt file next to the
// app (gitignored) with one proxy per line — Webshare "host:port:user:pass",
// plain "host:port", or a full "scheme://user:pass@host:port" URL. A random
// proxy is picked per request so a pool of IPs shares the load.
let _proxyPool = null;
function loadProxyPool() {
  if (_proxyPool) return _proxyPool;
  const pool = [];
  const single = (process.env.YTDLP_PROXY || "").trim();
  if (single) pool.push(single);
  try {
    const raw = fs.readFileSync(path.join(__dirname, "proxies.txt"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      if (/^[a-z0-9]+:\/\//i.test(t)) { pool.push(t); continue; }       // full URL
      const p = t.split(":");
      if (p.length === 4) pool.push(`http://${p[2]}:${p[3]}@${p[0]}:${p[1]}`); // host:port:user:pass
      else if (p.length === 2) pool.push(`http://${p[0]}:${p[1]}`);            // host:port
    }
  } catch (e) {}
  _proxyPool = pool;
  return pool;
}
function pickProxy() {
  const pool = loadProxyPool();
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : "";
}

function ytdlpCookieArgs() {
  const args = [];
  let file = process.env.YTDLP_COOKIES || "";
  const browser = process.env.YTDLP_COOKIES_FROM_BROWSER || "";
  // If no explicit path is set, auto-use a cookies.txt dropped next to the app
  // (gitignored) — just upload the file and restart, no config edit needed.
  if (!file) {
    const local = path.join(__dirname, "cookies.txt");
    if (fs.existsSync(local)) file = local;
  }
  if (file && fs.existsSync(file)) args.push("--cookies", file);
  else if (browser) args.push("--cookies-from-browser", browser);
  const proxy = pickProxy();
  if (proxy) args.push("--proxy", proxy);
  // Extra extractor-args — PO-token provider + preferred player clients — so
  // bot-check tuning needs no code change. Multiple groups separated by ";;",
  // each passed as its own --extractor-args flag, e.g.:
  //   youtube:player_client=default,mweb,tv;;youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416
  const extra = process.env.YTDLP_EXTRACTOR_ARGS || "";
  if (extra) {
    for (const part of extra.split(";;")) {
      const v = part.trim();
      if (v) args.push("--extractor-args", v);
    }
  }
  return args;
}

// ── Priority-aware job queue (independent of server.js's) ─────────────────────
let activeJobs = 0;
const jobQueue = [];

function pumpQueue() {
  while (activeJobs < YT_MAX_CONCURRENT && jobQueue.length) {
    const job = jobQueue.shift();
    activeJobs++;
    let released = false;
    const release = () => { if (released) return; released = true; activeJobs--; pumpQueue(); };
    try { job.run(release); } catch (e) { console.error("yt job run error:", e); release(); }
  }
}

function scheduleJob(priority, run) {
  if (activeJobs >= YT_MAX_CONCURRENT && jobQueue.length >= YT_MAX_QUEUE) return false;
  const job = { priority: priority ? 1 : 0, run };
  if (job.priority) {
    let i = 0;
    while (i < jobQueue.length && jobQueue[i].priority >= job.priority) i++;
    jobQueue.splice(i, 0, job);
  } else {
    jobQueue.push(job);
  }
  pumpQueue();
  return true;
}

// ── GET /yt-info ──────────────────────────────────────────────────────────────
// Single video → full metadata. Playlist/mix → flat entries[] list.
router.get("/yt-info", (req, res) => {
  if (!apiKeyOk(req)) return res.status(401).json({ error: "Unauthorized" });

  const raw = req.query.url;
  if (!raw || typeof raw !== "string" || !isYouTubeUrl(raw)) {
    return res.status(400).json({ error: "Invalid YouTube URL", hint: "Paste a link like https://www.youtube.com/watch?v=... or https://youtu.be/..." });
  }
  const url = normalizeYouTubeUrl(raw);
  const playlist = isYouTubePlaylistUrl(url);

  const args = ["-J", "--no-warnings", "--cache-dir", YTDLP_CACHE_DIR, ...ytdlpCookieArgs()];
  if (playlist) {
    args.push("--flat-playlist");
  } else {
    args.push("--no-playlist");
  }
  args.push(url);

  execFile(YTDLP_BIN, args, { timeout: 45000, maxBuffer: 48 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      console.error("yt-dlp yt-info error:", stderr);
      const info = classifyDownloadError(stderr);
      return res.status(500).json({ error: info.message, category: info.category, hint: info.hint });
    }
    let meta;
    try { meta = JSON.parse(stdout); } catch (e) { return res.status(500).json({ error: "Failed to parse video data" }); }
    if (!meta) return res.status(500).json({ error: "No video data" });

    if (Array.isArray(meta.entries)) {
      const tracks = meta.entries.filter((e) => e && (e.url || e.id || e.webpage_url)).map(flatTrackShape);
      return res.json({
        type: "playlist",
        header: {
          playlist_title: meta.title || "Playlist",
          uploader: meta.uploader || meta.channel || "",
          uploader_url: meta.uploader_url || meta.channel_url || "",
          thumbnail: bestThumb(meta) || (tracks[0] && tracks[0].thumbnail) || "",
        },
        total: meta.playlist_count || tracks.length,
        tracks,
      });
    }

    res.json({
      type: "single",
      title: meta.title,
      uploader: meta.uploader || meta.channel || "",
      thumbnail: bestThumb(meta),
      duration: typeof meta.duration === "number" ? meta.duration : null,
      view_count: meta.view_count,
      like_count: meta.like_count,
      url: meta.webpage_url || url,
    });
  });
});

// ── GET /yt-download ──────────────────────────────────────────────────────────
router.get("/yt-download", (req, res) => {
  const raw = req.query.url;
  const title = req.query.title || "audio";
  const requested = String(req.query.format || "mp3").toLowerCase();
  const fmt = DOWNLOAD_FORMATS[requested];
  if (!fmt) return res.status(400).json({ error: "Unsupported output format" });

  const opts = { bitrate: normalizeBitrate(req.query.bitrate), meta: String(req.query.meta || "") === "1" };
  const priority = String(req.query.v || "") === "2" && String(req.query.priority || "") === "1";

  const sigCheck = downloadSigCheck(req.query);
  if (!sigCheck.ok) {
    console.warn(`[yt-sig] rejected reason=${sigCheck.reason} exp=${req.query.exp || ""} now=${Math.floor(Date.now() / 1000)}`);
    return res.status(403).json({ error: "Invalid or expired download link", code: "bad_link", reason: sigCheck.reason });
  }
  if (!raw || !isYouTubeUrl(raw)) return res.status(400).json({ error: "Invalid YouTube URL" });
  const url = normalizeYouTubeUrl(raw);

  const safeTitle = String(title).replace(/[^a-zA-Z0-9_\- ]/g, "").trim() || "audio";
  const workId = crypto.randomBytes(8).toString("hex");
  const prefix = `ytgrab-${workId}`;
  const outTemplate = path.join(os.tmpdir(), `${prefix}.%(ext)s`);

  function cleanup() {
    try {
      const dir = os.tmpdir();
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(prefix)) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} }
      }
    } catch (e) {}
  }

  const accepted = scheduleJob(priority, (release) => {
    if (res.writableEnded || req.destroyed) { cleanup(); release(); return; }
    let slotReleased = false;
    const releaseSlot = () => { if (slotReleased) return; slotReleased = true; release(); };
    res.on("finish", releaseSlot);
    res.on("close", releaseSlot);

    const ytdlp = spawn(YTDLP_BIN, [
      ...buildYtdlpArgs(fmt, opts),
      "--concurrent-fragments", String(YTDLP_FRAGMENTS),
      "--retries", "3",
      "--fragment-retries", "5",
      "--cache-dir", YTDLP_CACHE_DIR,
      "--postprocessor-args", "ffmpeg:-threads 0",
      ...(FFMPEG_LOCATION ? ["--ffmpeg-location", FFMPEG_LOCATION] : []),
      ...ytdlpCookieArgs(),
      "--no-mtime",
      "-o", outTemplate,
      "--no-playlist",
      "--no-progress",
      url,
    ]);

    let stderr = "";
    let timedOut = false;
    ytdlp.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 65536) stderr = stderr.slice(-65536); });
    const jobTimer = setTimeout(() => { timedOut = true; if (ytdlp.exitCode === null) ytdlp.kill("SIGKILL"); }, YT_TIMEOUT_S * 1000);

    ytdlp.on("error", (err) => {
      clearTimeout(jobTimer);
      console.error("yt spawn error:", err);
      cleanup();
      if (!res.headersSent) {
        if (err && err.code === "ENOENT") {
          res.status(500).json({ error: "Download failed", category: "ytdlp-missing", message: "yt-dlp isn't installed or isn't on the server's PATH.", hint: "Install yt-dlp (or set YTDLP_PATH) and restart." });
        } else {
          res.status(500).json({ error: "Download failed", category: "spawn", message: "The server couldn't start the download process.", hint: "Check the server logs." });
        }
      }
      releaseSlot();
    });

    ytdlp.on("close", async (code) => {
      clearTimeout(jobTimer);
      let produced = null;
      try {
        const dir = os.tmpdir();
        const base = prefix + ".";
        const extOf = (f) => f.slice(base.length).toLowerCase();
        const files = fs.readdirSync(dir).filter((f) => f.startsWith(base) && !f.endsWith(".part"));
        const pick = files.find((f) => extOf(f) === fmt.ext) || files.find((f) => extOf(f) === fmt.audioFormat);
        if (pick) produced = path.join(dir, pick);
      } catch (e) {}

      if (timedOut) {
        console.error(`yt-dlp timed out after ${YT_TIMEOUT_S}s for ${url}`);
        cleanup();
        if (!res.headersSent) res.status(504).json({ error: "Download timed out", category: "timeout", message: "The server took too long to build this file.", hint: "Try again; if it repeats, lower concurrency." });
        releaseSlot();
        return;
      }
      if (!produced) {
        console.error("yt-dlp failed (code " + code + "), no output. stderr:\n" + stderr);
        const info = classifyDownloadError(stderr);
        cleanup();
        if (!res.headersSent) res.status(500).json({ error: "Conversion failed", category: info.category, message: info.message, hint: info.hint, detail: info.detail });
        releaseSlot();
        return;
      }
      if (code !== 0) console.warn("yt-dlp exited " + code + " but output exists; serving anyway. stderr:", stderr);

      const verified = await verifyDownloadedOutput(produced, requested);
      if (!verified.ok) {
        console.error(`yt-dlp produced the wrong format for ${requested}: ${verified.detail}`);
        cleanup();
        if (!res.headersSent) res.status(500).json({ error: "Wrong output format", category: "wrong-output-format", message: `The server could not produce a valid ${requested.toUpperCase()} file.`, hint: "Check yt-dlp/FFmpeg versions and the VPS logs." });
        releaseSlot();
        return;
      }

      const safeFile = `${safeTitle}.${fmt.ext}`;
      res.setHeader("Content-Disposition", `attachment; filename="${safeFile}"; filename*=UTF-8''${encodeURIComponent(safeFile)}`);
      res.setHeader("Content-Type", fmt.mime);
      res.setHeader("Accept-Ranges", "bytes");
      try { res.setHeader("Content-Length", fs.statSync(produced).size); } catch (e) {}

      const stream = fs.createReadStream(produced);
      stream.on("error", () => { cleanup(); if (!res.headersSent) res.status(500).json({ error: "Read failed" }); releaseSlot(); });
      stream.on("close", cleanup);
      stream.pipe(res);
    });

    req.on("aborted", () => { if (ytdlp.exitCode === null) ytdlp.kill(); cleanup(); releaseSlot(); });
    res.on("close", () => { if (!res.writableEnded && ytdlp.exitCode === null) ytdlp.kill(); if (!res.writableEnded) cleanup(); });
  });

  if (!accepted) {
    return res.status(503).json({ error: "Server busy", category: "queue-full", message: "The download queue is full right now.", hint: "Please wait a moment and try again." });
  }
});

// ── GET /yt-video-info ────────────────────────────────────────────────────────
// Single video → metadata + the list of downloadable video qualities (heights).
router.get("/yt-video-info", (req, res) => {
  if (!apiKeyOk(req)) return res.status(401).json({ error: "Unauthorized" });

  const raw = req.query.url;
  if (!raw || typeof raw !== "string" || !isYouTubeUrl(raw)) {
    return res.status(400).json({ error: "Invalid YouTube URL", hint: "Paste a link like https://www.youtube.com/watch?v=... or https://youtu.be/..." });
  }
  if (isYouTubePlaylistUrl(raw)) {
    return res.status(400).json({ error: "Please paste a single video link, not a playlist." });
  }
  const url = normalizeYouTubeUrl(raw);

  const args = ["-J", "--no-warnings", "--no-playlist", "--cache-dir", YTDLP_CACHE_DIR, ...ytdlpCookieArgs(), url];
  execFile(YTDLP_BIN, args, { timeout: 45000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      console.error("yt-dlp yt-video-info error:", stderr);
      const info = classifyDownloadError(stderr);
      return res.status(500).json({ error: info.message, category: info.category, hint: info.hint });
    }
    let meta;
    try { meta = JSON.parse(stdout); } catch (e) { return res.status(500).json({ error: "Failed to parse video data" }); }
    if (!meta) return res.status(500).json({ error: "No video data" });

    const fmts = Array.isArray(meta.formats) ? meta.formats : [];
    const sizeOf = (f) => Number((f && (f.filesize || f.filesize_approx)) || 0);

    // Best audio-only size, added to video-only tiers to estimate the merged size.
    let bestAudio = 0;
    for (const f of fmts) {
      if (!f || (f.vcodec && f.vcodec !== "none") || f.acodec === "none" || !f.acodec) continue;
      const sz = sizeOf(f);
      if (sz > bestAudio) bestAudio = sz;
    }

    // Per tier: keep the largest estimated total download size (video + audio).
    const tiers = new Map(); // tier -> estimated bytes
    for (const f of fmts) {
      if (!f || f.vcodec === "none" || !f.vcodec) continue;
      const h = typeof f.height === "number" ? f.height : parseInt(f.height, 10);
      if (!Number.isFinite(h) || h <= 0) continue;
      let tier = 0;
      for (const t of VIDEO_HEIGHTS) { if (t <= h && t > tier) tier = t; }
      if (tier <= 0) continue;
      const hasAudio = f.acodec && f.acodec !== "none";
      const vsize = sizeOf(f);
      const total = vsize > 0 ? (hasAudio ? vsize : vsize + bestAudio) : 0;
      const cur = tiers.get(tier);
      if (cur === undefined || total > cur) tiers.set(tier, total);
    }

    const qualities = Array.from(tiers.keys())
      .sort((a, b) => b - a)
      .map((h) => ({ height: h, label: h + "p", ext: "mp4", size: tiers.get(h) || 0 }));

    res.json({
      type: "single",
      title: meta.title,
      uploader: meta.uploader || meta.channel || "",
      thumbnail: bestThumb(meta),
      duration: typeof meta.duration === "number" ? meta.duration : null,
      view_count: meta.view_count,
      url: meta.webpage_url || url,
      qualities,
    });
  });
});

// ── GET /yt-video-download ────────────────────────────────────────────────────
// Builds a REAL, seekable MP4 (moov atom at the front, +faststart) in a temp
// file, then streams that file with a correct Content-Length. Muxing video+audio
// to stdout can only produce MPEG-TS, which many players (iPhone, Windows Media
// Player, editors) reject even when the file is named .mp4 — so we build to disk
// first. This relies on the api host being direct (no 100s Cloudflare cap) with
// a long Nginx read timeout, so the browser waits through the short build.
router.get("/yt-video-download", (req, res) => {
  const raw = req.query.url;
  const title = req.query.title || "video";
  const quality = normalizeVideoHeight(req.query.quality);
  const priority = String(req.query.priority || "") === "1";

  const sigCheck = videoSigCheck(req.query);
  if (!sigCheck.ok) {
    console.warn(`[yt-vsig] rejected reason=${sigCheck.reason} exp=${req.query.exp || ""} now=${Math.floor(Date.now() / 1000)}`);
    return res.status(403).json({ error: "Invalid or expired download link", code: "bad_link", reason: sigCheck.reason });
  }
  if (!raw || !isYouTubeUrl(raw)) return res.status(400).json({ error: "Invalid YouTube URL" });
  const url = normalizeYouTubeUrl(raw);

  const safeTitle = String(title).replace(/[^a-zA-Z0-9_\- ]/g, "").trim() || "video";
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytgrabv-"));

  function cleanup() {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
  }

  const accepted = scheduleJob(priority, (release) => {
    if (res.writableEnded || req.destroyed) { cleanup(); release(); return; }
    let slotReleased = false;
    const releaseSlot = () => { if (slotReleased) return; slotReleased = true; release(); };

    const outTemplate = path.join(workDir, "out.%(ext)s");

    const ytdlp = spawn(YTDLP_BIN, [
      "-f", videoFormatSelector(quality),
      "--merge-output-format", "mp4",
      // Real MP4 with the moov atom at the front so it plays everywhere and can
      // start playing before it is fully downloaded.
      "--postprocessor-args", "ffmpeg:-movflags +faststart -threads 0",
      "--concurrent-fragments", String(YTDLP_FRAGMENTS),
      "--retries", "3",
      "--fragment-retries", "5",
      "--cache-dir", YTDLP_CACHE_DIR,
      // Keep every intermediate fragment inside our throwaway work dir.
      "--paths", "temp:" + workDir,
      ...(FFMPEG_LOCATION ? ["--ffmpeg-location", FFMPEG_LOCATION] : []),
      ...ytdlpCookieArgs(),
      "--no-mtime",
      "-o", outTemplate,
      "--no-playlist",
      "--no-progress",
      url,
    ]);

    let stderr = "";
    let timedOut = false;
    let finished = false;

    const finish = () => { if (finished) return; finished = true; clearTimeout(jobTimer); cleanup(); releaseSlot(); };

    // Overall ceiling: kill a build that runs too long.
    const jobTimer = setTimeout(() => { timedOut = true; if (ytdlp.exitCode === null) ytdlp.kill("SIGKILL"); }, YT_TIMEOUT_S * 1000);

    ytdlp.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 65536) stderr = stderr.slice(-65536); });

    ytdlp.on("error", (err) => {
      clearTimeout(jobTimer);
      console.error("yt video spawn error:", err);
      if (!res.headersSent) {
        if (err && err.code === "ENOENT") {
          res.status(500).json({ error: "Download failed", category: "ytdlp-missing", message: "yt-dlp isn't installed or isn't on the server's PATH.", hint: "Install yt-dlp (or set YTDLP_PATH) and restart." });
        } else {
          res.status(500).json({ error: "Download failed", category: "spawn", message: "The server couldn't start the download process.", hint: "Check the server logs." });
        }
      } else {
        try { res.end(); } catch (e) {}
      }
      finish();
    });

    ytdlp.on("close", (code) => {
      clearTimeout(jobTimer);
      // Find the finished MP4 in the work dir.
      let produced = null;
      try {
        const files = fs.readdirSync(workDir).filter((f) => f.startsWith("out.") && !f.endsWith(".part"));
        const pick = files.find((f) => f.toLowerCase().endsWith(".mp4")) || files[0];
        if (pick) produced = path.join(workDir, pick);
      } catch (e) {}

      if (timedOut) {
        console.error(`yt-dlp (video) timed out for ${url}`);
        if (!res.headersSent) res.status(504).json({ error: "Download timed out", category: "timeout", message: "The server took too long to build this video.", hint: "Try a lower quality; if it repeats, lower concurrency." });
        finish();
        return;
      }
      if (!produced) {
        console.error("yt-dlp (video) failed (code " + code + "), no output. stderr:\n" + stderr);
        const info = classifyDownloadError(stderr);
        if (!res.headersSent) res.status(500).json({ error: "Download failed", category: info.category, message: info.message, hint: info.hint, detail: info.detail });
        finish();
        return;
      }
      if (code !== 0) console.warn("yt-dlp (video) exited " + code + " but output exists; serving anyway.");

      // Serve the real MP4 with a correct Content-Length → accurate progress bar.
      const safeFile = `${safeTitle}.mp4`;
      res.setHeader("Content-Disposition", `attachment; filename="${safeFile}"; filename*=UTF-8''${encodeURIComponent(safeFile)}`);
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Accept-Ranges", "bytes");
      try { res.setHeader("Content-Length", fs.statSync(produced).size); } catch (e) {}

      const stream = fs.createReadStream(produced);
      stream.on("error", () => { if (!res.headersSent) res.status(500).json({ error: "Read failed" }); finish(); });
      stream.on("close", finish);
      stream.pipe(res);
    });

    // Client went away → stop the work immediately.
    req.on("aborted", () => { if (ytdlp.exitCode === null) ytdlp.kill("SIGKILL"); finish(); });
    res.on("close", () => { if (!res.writableEnded && ytdlp.exitCode === null) ytdlp.kill("SIGKILL"); finish(); });
  });

  if (!accepted) {
    cleanup();
    return res.status(503).json({ error: "Server busy", category: "queue-full", message: "The download queue is full right now.", hint: "Please wait a moment and try again." });
  }
});

// ── GET /yt-search ────────────────────────────────────────────────────────────
// Keyword search. Turns a typed phrase into a list of matching videos using
// yt-dlp's built-in ytsearch (no extra dependency, no API key for YouTube). The
// WordPress tool shows the results and lets the visitor pick one to download.
router.get("/yt-search", (req, res) => {
  if (!apiKeyOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const q = String(req.query.q || req.query.query || "").trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: "Missing search query" });

  let limit = parseInt(req.query.limit || "12", 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 12;
  if (limit > 25) limit = 25;

  // `ytsearchN:<query>` is a yt-dlp INPUT SPEC passed as a single argv element to
  // execFile (no shell is spawned), so the query text can never inject arguments
  // or shell metacharacters — it is handled verbatim by yt-dlp.
  const spec = `ytsearch${limit}:${q}`;
  const args = ["-J", "--flat-playlist", "--no-warnings", "--cache-dir", YTDLP_CACHE_DIR, ...ytdlpCookieArgs(), spec];

  execFile(YTDLP_BIN, args, { timeout: 30000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      console.error("yt-dlp yt-search error:", stderr);
      const info = classifyDownloadError(stderr);
      return res.status(500).json({ error: info.message || "Search failed", category: info.category, hint: info.hint });
    }
    let meta;
    try { meta = JSON.parse(stdout); } catch (e) { return res.status(500).json({ error: "Failed to parse search results" }); }
    const entries = meta && Array.isArray(meta.entries) ? meta.entries : [];
    const results = entries
      .filter((e) => e && (e.id || e.url || e.webpage_url))
      .map((e) => {
        const id = e.id || "";
        const vurl = e.webpage_url || (id ? `https://www.youtube.com/watch?v=${id}` : (e.url || ""));
        return {
          id,
          title: e.title || "Untitled",
          url: vurl,
          uploader: e.uploader || e.channel || e.uploader_id || "",
          duration: typeof e.duration === "number" ? e.duration : null,
          view_count: typeof e.view_count === "number" ? e.view_count : null,
          thumbnail: bestThumb(e) || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : ""),
        };
      });
    res.json({ query: q, count: results.length, results });
  });
});

// ── GET /yt-suggest ─────────────────────────────────────────────────────────
// Autocomplete suggestions from YouTube's public suggest endpoint, proxied here
// so the browser isn't blocked by CORS. Always resolves (empty list on any
// problem) so a hiccup never breaks typing. Returns { query, suggestions:[...] }.
router.get("/yt-suggest", (req, res) => {
  if (!apiKeyOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const q = String(req.query.q || req.query.query || "").trim().slice(0, 150);
  if (!q) return res.json({ query: "", suggestions: [] });
  const hl = (String(req.query.hl || "en").replace(/[^a-zA-Z-]/g, "").slice(0, 8)) || "en";

  const api =
    "https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=" +
    encodeURIComponent(hl) + "&q=" + encodeURIComponent(q);

  let done = false;
  const finish = (suggestions) => { if (done) return; done = true; res.json({ query: q, suggestions: suggestions || [] }); };

  const upReq = https.get(api, { timeout: 6000, headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json, text/javascript, */*" } }, (up) => {
    let raw = "";
    up.setEncoding("utf8");
    up.on("data", (c) => { raw += c; if (raw.length > 65536) { up.destroy(); } });
    up.on("end", () => {
      let parsed = null, out = [];
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (Array.isArray(parsed) && Array.isArray(parsed[1])) {
        out = parsed[1]
          .map((x) => (Array.isArray(x) ? x[0] : x))
          .filter((s) => typeof s === "string" && s)
          .slice(0, 10);
      }
      finish(out);
    });
    up.on("error", () => finish([]));
  });
  upReq.on("timeout", () => { upReq.destroy(); finish([]); });
  upReq.on("error", () => finish([]));
});

// ── GET /yt-diag ──────────────────────────────────────────────────────────────
router.get("/yt-diag", (req, res) => {
  res.json({
    routes: ["/yt-info", "/yt-download", "/yt-video-info", "/yt-video-download", "/yt-search", "/yt-suggest"],
    downloads: { active: activeJobs, queued: jobQueue.length, concurrency: YT_MAX_CONCURRENT, queueLimit: YT_MAX_QUEUE },
    ytdlpPath: YTDLP_BIN,
    ffmpegLocation: FFMPEG_LOCATION || "(PATH)",
    secret: API_SECRET ? "set" : "open",
  });
});

// Expose status for the health check in server.js "/" if you want it.
router.getStatus = () => ({ active: activeJobs, queued: jobQueue.length });

module.exports = router;
