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
const YTDLP_FRAGMENTS = Math.max(1, parseInt(process.env.YTDLP_FRAGMENTS || "8", 10) || 8);

// ── Speed: default extractor client ───────────────────────────────────────────
// Used by ytdlpCookieArgs() when YTDLP_EXTRACTOR_ARGS is NOT set on the VPS. The
// default "web" client makes yt-dlp fetch and run YouTube's player JS to solve
// the n-signature challenge — slow, and its stream URLs are often throttled.
// Keeping "default" first preserves every format, while android/web_safari add
// faster, un-throttled paths. If you configure YTDLP_EXTRACTOR_ARGS (e.g. for a
// PO-token provider) your value wins and this default is ignored.
const DEFAULT_EXTRACTOR_ARGS = process.env.YTDLP_EXTRACTOR_ARGS
  ? "" // handled in ytdlpCookieArgs — avoid double-adding
  : "youtube:player_client=default,android,web_safari";

// ── Speed: aria2c external downloader ─────────────────────────────────────────
// aria2c opens many parallel connections per stream (typically 3–10× faster than
// yt-dlp's native downloader). Auto-enabled when aria2c is found on PATH; force
// on with YTDLP_ARIA2=1 or off with YTDLP_ARIA2=0. Both download routes build to
// a temp file (not stdout), so aria2c is safe for audio and video alike.
const ARIA2_AVAILABLE = (() => {
  try { require("child_process").execFileSync("aria2c", ["--version"], { stdio: "ignore" }); return true; }
  catch (e) { return false; }
})();
const USE_ARIA2 = process.env.YTDLP_ARIA2 === "1" || (process.env.YTDLP_ARIA2 !== "0" && ARIA2_AVAILABLE);
const ARIA2_DL_ARGS = process.env.YTDLP_ARIA2_ARGS || "-x16 -s16 -k1M";
function ytdlpDownloaderArgs() {
  return USE_ARIA2 ? ["--downloader", "aria2c", "--downloader-args", "aria2c:" + ARIA2_DL_ARGS] : [];
}

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
// Default concurrency scales with CPU cores (2–4) so several visitors aren't
// queued behind one job on a multi-core box; still overridable via env.
const YT_CONCURRENCY_DEFAULT = String(Math.max(2, Math.min((os.cpus() || []).length || 2, 4)));
const YT_MAX_CONCURRENT = Math.max(1, parseInt(process.env.YT_MAX_CONCURRENT || process.env.MAX_CONCURRENT || YT_CONCURRENCY_DEFAULT, 10) || 2);
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
  // Speed: for M4A/MP4 at the standard bitrate, pick YouTube's native AAC stream
  // (~128 kbps). yt-dlp then keeps it as-is instead of decoding Opus and
  // re-encoding to AAC — faster and one lossy generation fewer. A plan that asks
  // for a different bitrate still gets a real encode at that bitrate, as before.
  if (fmt.audioFormat === "m4a" && (!opts.bitrate || opts.bitrate === "128")) {
    args.unshift("-f", "ba[ext=m4a]/ba[acodec^=mp4a]/ba/b");
  }
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

  if (has(/server busy, too many lookups/)) {
    return { category: "busy", message: "The server is busy right now.", hint: "Please try again in a few seconds.", detail };
  }
  if (has(/does not pass filter \(!is_live|does not pass filter \(live_status|live event will begin|premieres in|this live event|is_upcoming/)) {
    return { category: "live", message: "This is a live stream or a premiere that hasn't finished yet, so it can't be downloaded.", hint: "Try again after the stream has ended and YouTube has finished processing it.", detail };
  }
  if (has(/does not pass filter \(duration/)) {
    return { category: "too-long", message: "This video is longer than the maximum length this downloader allows.", hint: "Try a shorter video.", detail };
  }
  if (has(/drm protected|is drm/)) {
    return { category: "drm", message: "This video is copy-protected (DRM), so it can't be downloaded.", hint: "Protected content such as paid movies cannot be fetched.", detail };
  }
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
  if (has(/video unavailable|removed|terminated|no longer available|copyright|content isn.?t available|recording is not available/)) {
    return { category: "unavailable", message: "This video is unavailable (removed, private, or taken down).", hint: "Try a different video.", detail };
  }
  if (
    has(/unable to extract/) || has(/unable to download (webpage|json)/) || has(/unsupported url/) ||
    has(/nonetype/) || has(/no video formats|requested format|only images are available|needs to be reloaded/) || has(/failed to parse json|unable to parse/)
  ) {
    return { category: "extractor", message: "The downloader couldn't read this video — it's probably out of date.", hint: "Update yt-dlp on the server (yt-dlp -U or pip install -U yt-dlp), then restart.", detail };
  }
  if (has(/http error 403|forbidden/)) {
    return { category: "blocked", message: "YouTube refused to send this video to the server.", hint: "Usually an out-of-date yt-dlp or a blocked server IP: update yt-dlp, then add cookies.txt or a proxy if it continues.", detail };
  }
  if (has(/timed out|timeout|connection reset|connection refused|name resolution|getaddrinfo|network is unreachable|incompleteread|remote end closed|http error 5\d\d|proxy/)) {
    return { category: "network", message: "A temporary network problem stopped this download.", hint: "Please try again. If it keeps happening, check the server's connection / proxy.", detail };
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

// yt-dlp format selection for (up to) the given height.
//
// Fixed in 1.8.0: the old selector tried "a single ready-made MP4" first. YouTube
// only offers that at 360p now, so EVERY 720p/1080p request quietly came back as
// 360p. Now: best video at or below the requested height + best audio (merged by
// ffmpeg), and the sort order below breaks ties in favour of H.264 + AAC so the
// MP4 plays everywhere. A single ready-made file is still used when it really is
// the requested height (e.g. 360p). Above 1080p YouTube has no H.264, so those
// tiers are VP9/AV1 video inside the MP4.
function videoFormatSelector(height) {
  const h = parseInt(height, 10);
  const cap = Number.isFinite(h) && h > 0 ? `[height<=${h}]` : "";
  return [`bv*${cap}+ba`, `b${cap}`, "bv*+ba", "b"].join("/");
}
function videoFormatSort(height) {
  const h = parseInt(height, 10);
  return (Number.isFinite(h) && h > 0 ? `res:${h}` : "res") + ",vcodec:h264,acodec:aac";
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
// Proxies that just failed (bot-check, dead/slow connection) are rested for a
// few minutes so the next requests don't waste time on them (1.10.0). If every
// proxy is resting, the whole pool is used again.
const proxyCooldown = new Map(); // proxy -> timestamp (ms) until which it is skipped
function pickProxy() {
  const pool = loadProxyPool();
  if (!pool.length) return "";
  const now = Date.now();
  const rested = pool.filter((p) => !(proxyCooldown.get(p) > now));
  const from = rested.length ? rested : pool;
  return from[Math.floor(Math.random() * from.length)];
}
function noteProxyFailure(proxy, stderr) {
  if (!proxy) return;
  const text = String(stderr || "");
  let ms = 0;
  if (/sign in to confirm|not a bot|http error 429|too many requests|rate.?limit/i.test(text)) ms = 10 * 60 * 1000;
  else if (/unable to connect to proxy|proxyerror|tunnel connection failed|timed out|timeout|connection refused|connection reset|remote end closed/i.test(text)) ms = 3 * 60 * 1000;
  if (ms) proxyCooldown.set(proxy, Date.now() + ms);
}

// `forcedProxy` (optional): use exactly this proxy ("" = none) instead of picking
// a random one. A download that reuses cached metadata MUST go out through the
// same proxy that fetched it, because YouTube's media URLs are bound to that IP.
// `fallback` (optional): the extra attempt after a retryable failure. It uses
// YTDLP_FALLBACK_EXTRACTOR_ARGS if set; otherwise, when no YTDLP_EXTRACTOR_ARGS is
// configured, it drops our built-in client list and lets yt-dlp use its own
// current defaults (which its maintainers keep working as YouTube changes).
function ytdlpCookieArgs(forcedProxy, fallback) {
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
  const proxy = typeof forcedProxy === "string" ? forcedProxy : pickProxy();
  if (proxy) args.push("--proxy", proxy);
  // Extra extractor-args — PO-token provider + preferred player clients — so
  // bot-check tuning needs no code change. Multiple groups separated by ";;",
  // each passed as its own --extractor-args flag, e.g.:
  //   youtube:player_client=default,mweb,tv;;youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416
  let extra = process.env.YTDLP_EXTRACTOR_ARGS || DEFAULT_EXTRACTOR_ARGS;
  if (fallback) {
    extra = process.env.YTDLP_FALLBACK_EXTRACTOR_ARGS !== undefined
      ? process.env.YTDLP_FALLBACK_EXTRACTOR_ARGS
      : (process.env.YTDLP_EXTRACTOR_ARGS || "");
  }
  if (extra) {
    for (const part of extra.split(";;")) {
      const v = part.trim();
      if (v) args.push("--extractor-args", v);
    }
  }
  return args;
}

// Does this yt-dlp stderr look like YouTube's bot-check / rate-limit? Those are
// per-IP, so retrying with a different proxy from the pool often succeeds.
function isBotCheckError(stderr) {
  return /sign in to confirm|not a bot|confirm your age|http error 429|too many requests|rate.?limit/i.test(String(stderr || ""));
}

// Extra attempts (each re-picks a proxy) when a bot-check is hit; 0 disables it.
const YT_PROXY_RETRIES = Math.max(0, parseInt(process.env.YT_PROXY_RETRIES || "3", 10) || 0);

// ═════════════════════════════════════════════════════════════════════════════
// Reliability layer (1.8.0)
// ═════════════════════════════════════════════════════════════════════════════

// Failures worth ONE more attempt: a network blip, YouTube refusing the media
// request (HTTP 403 — usually cured by a fresh extraction / another proxy), or an
// extractor hiccup. Deterministic failures (private, removed, region, age-gate,
// live) are deliberately not matched, so they fail fast with their real reason.
function isRetryableError(text) {
  return /timed out|timeout|connection reset|connection aborted|connection refused|temporary failure in name resolution|getaddrinfo|network is unreachable|incompleteread|remote end closed|http error 5\d\d|unable to connect to proxy|proxyerror|tunnel connection failed|http error 403|unable to extract|only images are available|requested format is not available|no video formats|needs to be reloaded|failed to parse json/i
    .test(String(text || ""));
}

// Refuse things that can never finish cleanly BEFORE downloading: a running or
// scheduled live stream would otherwise record until the job timeout. Optional
// YT_MAX_DURATION_S caps video length (0 = no cap). Also make yt-dlp fail loudly
// instead of silently skipping missing fragments (which yields a cut-off file).
const YT_MAX_DURATION_S = Math.max(0, parseInt(process.env.YT_MAX_DURATION_S || "0", 10) || 0);
function downloadGuardArgs() {
  let filter = "!is_live & live_status!=is_upcoming";
  if (YT_MAX_DURATION_S) filter += ` & duration<=?${YT_MAX_DURATION_S}`;
  return ["--match-filter", filter, "--abort-on-unavailable-fragments"];
}

// yt-dlp reports a --match-filter skip on STDOUT; pull just that line out so the
// error classifier can name the real reason.
function skipNoteFrom(stdoutTail) {
  const m = String(stdoutTail || "").match(/[^\r\n]*does not pass filter[^\r\n]*/i);
  return m ? "ERROR: " + m[0].trim() : "";
}

// Bound simultaneous metadata/search yt-dlp processes so a burst of lookups
// can't exhaust the VPS (each one is a full Python process).
const YT_INFO_MAX_CONCURRENT = Math.max(1, parseInt(process.env.YT_INFO_MAX_CONCURRENT || "6", 10) || 6);
const YT_INFO_MAX_WAITING = Math.max(1, parseInt(process.env.YT_INFO_MAX_WAITING || "60", 10) || 60);
// A lookup gives up on a silent connection (dead proxy) after this many seconds
// and moves on to another proxy, instead of yt-dlp's default 20 s. 0 = default.
const YT_LOOKUP_SOCKET_TIMEOUT_S = Math.max(0, parseInt(process.env.YT_LOOKUP_SOCKET_TIMEOUT_S || "12", 10) || 0);
function lookupNetArgs() {
  return YT_LOOKUP_SOCKET_TIMEOUT_S ? ["--socket-timeout", String(YT_LOOKUP_SOCKET_TIMEOUT_S)] : [];
}
let lookupsActive = 0;
const lookupsWaiting = [];
function releaseLookup() {
  lookupsActive--;
  const next = lookupsWaiting.shift();
  if (next) { lookupsActive++; next(); }
}

// Run a buffered yt-dlp call. Args are rebuilt for every attempt with a freshly
// picked proxy. Retries: up to YT_PROXY_RETRIES on a bot-check, plus one extra
// attempt on a retryable failure using the fallback extractor settings. The
// callback also receives the proxy the final attempt used.
function execYtdlp(buildArgs, opts, cb) {
  let attempt = 0;
  let softRetried = false;
  const start = () => {
    let finished = false;
    const done = (err, stdout, stderr, proxy) => { if (finished) return; finished = true; releaseLookup(); cb(err, stdout, stderr, proxy); };
    const run = (fallback) => {
      attempt++;
      const proxy = pickProxy();
      execFile(YTDLP_BIN, buildArgs(proxy, fallback), opts, (err, stdout, stderr) => {
        if (err) noteProxyFailure(proxy, stderr);
        if (err && attempt <= YT_PROXY_RETRIES && isBotCheckError(stderr)) {
          console.warn(`[yt-retry] bot-check, retry ${attempt}/${YT_PROXY_RETRIES}`);
          return run(fallback);
        }
        if (err && !softRetried && !err.killed && isRetryableError(stderr)) {
          softRetried = true;
          console.warn("[yt-retry] lookup failed, one more try with fallback settings: " + String(stderr).trim().split(/\r?\n/).pop().slice(0, 160));
          return run(true);
        }
        done(err, stdout, stderr, proxy);
      });
    };
    run(false);
  };
  if (lookupsActive < YT_INFO_MAX_CONCURRENT) { lookupsActive++; start(); }
  else if (lookupsWaiting.length >= YT_INFO_MAX_WAITING) cb(new Error("busy"), "", "ERROR: server busy, too many lookups in progress");
  else lookupsWaiting.push(start);
}

// One JSON line per download request when it ends — greppable in `pm2 logs`.
function logRequest(req, res, evt, extra) {
  const t0 = Date.now();
  res.on("close", () => {
    try {
      console.log(JSON.stringify(Object.assign({ t: new Date().toISOString(), evt }, extra, {
        status: res.statusCode,
        ok: !!res.writableFinished && res.statusCode < 400,
        bytes: Number(res.getHeader("content-length")) || 0,
        ms: Date.now() - t0,
      })));
    } catch (e) {}
  });
}

// ── yt-dlp freshness ──────────────────────────────────────────────────────────
// An out-of-date yt-dlp is the most common reason videos stop working. Check its
// age at start and twice a day, warn in the log, and report it in /yt-diag.
// YTDLP_AUTO_UPDATE=1 additionally runs `yt-dlp -U` on that schedule (works for
// the standalone yt-dlp file; pip/apt installs must be updated with their own
// tool — see update-ytdlp.sh). No restart is needed: every job starts yt-dlp anew.
const YTDLP_STALE_DAYS = Math.max(7, parseInt(process.env.YTDLP_STALE_DAYS || "45", 10) || 45);
const YTDLP_AUTO_UPDATE = process.env.YTDLP_AUTO_UPDATE === "1";
const ytdlpStatus = { version: "", ageDays: null, stale: false, autoUpdate: YTDLP_AUTO_UPDATE, lastUpdate: "" };

function checkYtdlpVersion(done) {
  execFile(YTDLP_BIN, ["--version"], { timeout: 15000 }, (err, stdout) => {
    const v = err ? "" : String(stdout || "").trim().split(/\r?\n/)[0];
    ytdlpStatus.version = v || "(not runnable)";
    const m = v.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})/);
    if (m) {
      const age = Math.floor((Date.now() - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400000);
      ytdlpStatus.ageDays = age;
      ytdlpStatus.stale = age > YTDLP_STALE_DAYS;
      if (ytdlpStatus.stale) console.warn(`[yt-dlp] version ${v} is ${age} days old — YouTube downloads may fail. Update it (bash update-ytdlp.sh, or set YTDLP_AUTO_UPDATE=1).`);
    }
    if (done) done();
  });
}

function autoUpdateYtdlp() {
  if (!YTDLP_AUTO_UPDATE) return checkYtdlpVersion();
  execFile(YTDLP_BIN, ["-U"], { timeout: 180000 }, (err, stdout, stderr) => {
    const last = String((stdout || "") + "\n" + (stderr || "")).trim().split(/\r?\n/).pop() || "";
    ytdlpStatus.lastUpdate = new Date().toISOString() + " " + (err ? "failed: " : "") + last.slice(0, 200);
    console.log("[yt-dlp] auto-update: " + ytdlpStatus.lastUpdate);
    checkYtdlpVersion();
  });
}
setTimeout(autoUpdateYtdlp, 3000).unref();
setInterval(autoUpdateYtdlp, 12 * 60 * 60 * 1000).unref();

// ── Temp sweeper for THIS router's files ──────────────────────────────────────
// Each job deletes its own temp files, but a crash / SIGKILL / restart mid-job
// strands them, and server.js's sweeper only knows the SoundCloud prefixes. Remove
// our "ytgrab-<id>.*" files and "ytgrabv-*" work dirs once they are far older
// than the longest possible job. The metadata cache dir is never touched.
const YT_TEMP_MAX_AGE_MS = Math.max(YT_TIMEOUT_S * 2, 3600) * 1000;
function sweepYtTemp() {
  const dir = os.tmpdir();
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  const cutoff = Date.now() - YT_TEMP_MAX_AGE_MS;
  let removed = 0;
  for (const name of names) {
    if (!/^ytgrab-[0-9a-f]{16}\./.test(name) && !/^ytgrabv-/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs > cutoff) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed++;
    } catch (e) {}
  }
  if (removed) console.log(`[yt-sweep] removed ${removed} stale temp item(s)`);
}
setTimeout(sweepYtTemp, 10000).unref();
setInterval(sweepYtTemp, 15 * 60 * 1000).unref();

// ═════════════════════════════════════════════════════════════════════════════
// Speed layer (1.8.0): caches + metadata reuse. No route, parameter or response
// shape changes — only how often yt-dlp / YouTube actually has to be asked.
// ═════════════════════════════════════════════════════════════════════════════
const envSeconds = (name, def) => {
  const n = parseInt(process.env[name] === undefined ? String(def) : process.env[name], 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
};
// How long one video's metadata is reused: for repeat /yt-info + /yt-video-info
// answers AND to let the following download skip its own extraction. YouTube's
// media URLs stay valid for hours; 30 min is deliberately conservative. 0 = off.
const YT_INFO_CACHE_S = envSeconds(process.env.YT_INFO_CACHE_S !== undefined ? "YT_INFO_CACHE_S" : "YT_INFO_CACHE_TTL_S", 1800);
const YT_INFO_CACHE_MAX = Math.max(10, envSeconds("YT_INFO_CACHE_MAX", 200));
const YT_PLAYLIST_CACHE_S = envSeconds("YT_PLAYLIST_CACHE_S", 300);
const YT_SEARCH_CACHE_S = envSeconds("YT_SEARCH_CACHE_S", 600);
const YT_SUGGEST_CACHE_S = envSeconds("YT_SUGGEST_CACHE_S", 3600);
// Direct search against YouTube's own search endpoint (no yt-dlp process start).
// Any failure silently falls back to the old yt-dlp search. 0 = always yt-dlp.
const YT_FAST_SEARCH = process.env.YT_FAST_SEARCH !== "0";
// One keep-alive pool for the direct HTTPS calls (suggest + fast search), so
// each keystroke doesn't pay a fresh TCP + TLS handshake.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 8, timeout: 30000 });

// Tiny TTL + LRU cache (Map keeps insertion order → oldest entry is first).
function makeTtlCache(ttlSeconds, maxEntries) {
  const map = new Map();
  const ttlMs = ttlSeconds * 1000;
  return {
    get(key) {
      if (!ttlMs) return undefined;
      const hit = map.get(key);
      if (!hit) return undefined;
      if (Date.now() - hit.at > ttlMs) { map.delete(key); return undefined; }
      map.delete(key); map.set(key, hit); // refresh LRU position
      return hit.value;
    },
    set(key, value) {
      if (!ttlMs) return;
      map.delete(key);
      map.set(key, { at: Date.now(), value });
      while (map.size > maxEntries) map.delete(map.keys().next().value);
    },
    get size() { return map.size; },
  };
}

const playlistCache = makeTtlCache(YT_PLAYLIST_CACHE_S, 100);
const searchCache = makeTtlCache(YT_SEARCH_CACHE_S, 500);
const suggestCache = makeTtlCache(YT_SUGGEST_CACHE_S, 3000);
const cacheStats = { infoHit: 0, infoMiss: 0, infoFast: 0, infoFastMiss: 0, infoReused: 0, infoReuseFailed: 0, searchHit: 0, searchFast: 0, searchYtdlp: 0, suggestHit: 0 };

// Stable cache key for one video: its 11-char id when we can see it, else the URL.
function videoCacheKey(url) {
  try {
    const u = new URL(String(url));
    let id = u.searchParams.get("v") || "";
    if (!id) {
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{6,20})/);
      if (m) id = m[1];
    }
    if (!id && u.hostname.toLowerCase().endsWith("youtu.be")) id = u.pathname.split("/").filter(Boolean)[0] || "";
    if (/^[A-Za-z0-9_-]{6,20}$/.test(id)) return "v:" + id;
  } catch (e) {}
  return "u:" + String(url);
}

// ── Video metadata cache ──────────────────────────────────────────────────────
// The raw `yt-dlp -J` output (0.3–1 MB each) is kept on DISK, not in memory, and
// handed back to yt-dlp with --load-info-json so a download that follows an info
// lookup skips the whole extraction step. Only the two small response bodies
// stay in memory.
const INFO_CACHE_DIR = path.join(os.tmpdir(), "ytgrab-infocache");
try { fs.rmSync(INFO_CACHE_DIR, { recursive: true, force: true }); } catch (e) {}
try { fs.mkdirSync(INFO_CACHE_DIR, { recursive: true }); } catch (e) {}

const infoCache = new Map();    // key -> { at, file, proxy, single, video, playlist }
const infoInflight = new Map(); // key -> Promise (collapses simultaneous lookups)
// Videos that can never be fetched (private, removed, region-blocked, DRM, live)
// keep their error for a minute, so repeat lookups / the download click answer
// at once instead of running the whole extraction again.
const infoErrors = makeTtlCache(60, 500); // key -> { status, body }
const PERMANENT_ERROR_CATEGORIES = ["private", "unavailable", "geo", "drm", "live", "too-long"];

function dropInfo(key) {
  const e = infoCache.get(key);
  if (!e) return;
  infoCache.delete(key);
  if (e.file) fs.unlink(e.file, () => {});
}

function freshInfo(key) {
  if (!YT_INFO_CACHE_S) return null;
  const e = infoCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > YT_INFO_CACHE_S * 1000) { dropInfo(key); return null; }
  return e;
}

// Cached metadata a download may reuse (single videos only, file still on disk).
function reusableInfo(url) {
  const e = freshInfo(videoCacheKey(url));
  if (!e || !e.file || e.playlist) return null;
  try { if (!fs.existsSync(e.file)) return null; } catch (err) { return null; }
  return e;
}

const infoPruneTimer = setInterval(() => {
  for (const key of Array.from(infoCache.keys())) freshInfo(key);
}, 5 * 60 * 1000);
infoPruneTimer.unref();

function playlistShape(meta) {
  const tracks = meta.entries.filter((e) => e && (e.url || e.id || e.webpage_url)).map(flatTrackShape);
  return {
    type: "playlist",
    header: {
      playlist_title: meta.title || "Playlist",
      uploader: meta.uploader || meta.channel || "",
      uploader_url: meta.uploader_url || meta.channel_url || "",
      thumbnail: bestThumb(meta) || (tracks[0] && tracks[0].thumbnail) || "",
    },
    total: meta.playlist_count || tracks.length,
    tracks,
  };
}

function singleShape(meta, url) {
  return {
    type: "single",
    title: meta.title,
    uploader: meta.uploader || meta.channel || "",
    thumbnail: bestThumb(meta),
    duration: typeof meta.duration === "number" ? meta.duration : null,
    view_count: meta.view_count,
    like_count: meta.like_count,
    url: meta.webpage_url || url,
  };
}

function videoShape(meta, url) {
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

  return {
    type: "single",
    title: meta.title,
    uploader: meta.uploader || meta.channel || "",
    thumbnail: bestThumb(meta),
    duration: typeof meta.duration === "number" ? meta.duration : null,
    view_count: meta.view_count,
    url: meta.webpage_url || url,
    qualities,
  };
}

// Full metadata for ONE video URL, served from cache when fresh. Resolves to the
// cache entry; rejects with { status, body } (the exact JSON error the routes
// have always returned). `tag` only labels the log line.
function getVideoInfo(url, tag) {
  const key = videoCacheKey(url);
  const hit = freshInfo(key);
  if (hit) { cacheStats.infoHit++; return Promise.resolve(hit); }
  const pending = infoInflight.get(key);
  if (pending) return pending;
  const knownBad = infoErrors.get(key);
  if (knownBad) return Promise.reject(knownBad);
  cacheStats.infoMiss++;

  const p = new Promise((resolve, reject) => {
    const buildArgs = (proxy, fallback) => ["-J", "--no-warnings", "--no-playlist", "--cache-dir", YTDLP_CACHE_DIR, ...lookupNetArgs(), ...ytdlpCookieArgs(proxy, fallback), url];
    execYtdlp(buildArgs, { timeout: 45000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr, proxy) => {
      if (err) {
        console.error(`yt-dlp ${tag} error:`, stderr);
        const info = classifyDownloadError(stderr);
        const failure = { status: 500, body: { error: info.message, category: info.category, hint: info.hint } };
        if (PERMANENT_ERROR_CATEGORIES.includes(info.category)) infoErrors.set(key, failure);
        return reject(failure);
      }
      let meta;
      try { meta = JSON.parse(stdout); } catch (e) { return reject({ status: 500, body: { error: "Failed to parse video data" } }); }
      if (!meta) return reject({ status: 500, body: { error: "No video data" } });

      if (meta.is_live === true || meta.live_status === "is_live" || meta.live_status === "is_upcoming") {
        const failure = liveError();
        infoErrors.set(key, failure);
        return reject(failure);
      }
      if (YT_MAX_DURATION_S && typeof meta.duration === "number" && meta.duration > YT_MAX_DURATION_S) {
        const failure = tooLongError();
        infoErrors.set(key, failure);
        return reject(failure);
      }

      const isList = Array.isArray(meta.entries);
      const entry = {
        at: Date.now(),
        file: "",
        proxy: proxy || "",
        playlist: isList ? playlistShape(meta) : null,
        single: isList ? null : singleShape(meta, url),
        video: videoShape(meta, url),
      };
      if (!YT_INFO_CACHE_S) return resolve(entry);

      const store = () => {
        dropInfo(key);
        infoCache.set(key, entry);
        while (infoCache.size > YT_INFO_CACHE_MAX) dropInfo(infoCache.keys().next().value);
        resolve(entry);
      };
      if (isList) return store();
      // Keep the raw JSON so the download that usually follows can reuse it.
      const file = path.join(INFO_CACHE_DIR, crypto.randomBytes(10).toString("hex") + ".json");
      fs.writeFile(file, stdout, (werr) => {
        if (!werr) entry.file = file;
        store();
      });
    });
  });
  infoInflight.set(key, p);
  const clear = () => { if (infoInflight.get(key) === p) infoInflight.delete(key); };
  p.then(clear, clear);
  return p;
}

// ═════════════════════════════════════════════════════════════════════════════
// Instant lookups (1.10.0)
// ═════════════════════════════════════════════════════════════════════════════
// A full `yt-dlp -J` extraction takes 10–25 s on a busy server (Python start,
// several player requests through a proxy, signature solving). The page only
// needs the title, thumbnail, length and the list of qualities to show the
// result, and YouTube's own player endpoint returns exactly that in well under a
// second. So /yt-info and /yt-video-info now:
//   1. start the full extraction in the BACKGROUND, exactly as before, so the
//      download that follows finds its metadata ready in the cache; and
//   2. answer the visitor from the quick request as soon as it arrives.
// If the quick request can't answer (blocked, changed, age-gated, unusual video)
// the route simply waits for the full extraction like it always did — so lookups
// can only get faster, never break. YT_FAST_INFO=0 switches it off.
const YT_FAST_INFO = process.env.YT_FAST_INFO !== "0";
const YT_FAST_INFO_TIMEOUT_MS = Math.max(500, parseInt(process.env.YT_FAST_INFO_TIMEOUT_MS || "3000", 10) || 3000);

function liveError() {
  return { status: 400, body: { error: "This is a live stream or a premiere that hasn't finished yet, so it can't be downloaded.", category: "live", hint: "Try again after the stream has ended and YouTube has finished processing it." } };
}
function tooLongError() {
  return { status: 400, body: { error: "This video is longer than the maximum length this downloader allows.", category: "too-long", hint: "Try a shorter video." } };
}

// Two player "clients" are asked at once: the app client lists every quality
// with its size; the web client reliably returns the title/length even when the
// app client is refused. Neither response is used for downloading.
const FAST_CLIENTS = [
  {
    context: { clientName: "IOS", clientVersion: "20.10.4", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.2.22D82", hl: "en", gl: "US" },
    headers: { "User-Agent": "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)", "X-YouTube-Client-Name": "5", "X-YouTube-Client-Version": "20.10.4" },
  },
  {
    context: { clientName: "WEB", clientVersion: "2.20250101.00.00", hl: "en", gl: "US" },
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" },
  },
];

function fastPlayerRequest(client, id) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ context: { client: client.context }, videoId: id, contentCheckOk: true, racyCheckOk: true });
    const upReq = https.request(
      "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
      {
        method: "POST",
        agent: keepAliveAgent,
        timeout: YT_FAST_INFO_TIMEOUT_MS,
        headers: Object.assign({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Accept-Language": "en-US,en;q=0.9" }, client.headers),
      },
      (up) => {
        if (up.statusCode !== 200) { up.resume(); return reject(new Error("HTTP " + up.statusCode)); }
        const chunks = [];
        let size = 0;
        up.on("data", (c) => { size += c.length; if (size > 6 * 1024 * 1024) { up.destroy(new Error("too large")); return; } chunks.push(c); });
        up.on("error", reject);
        up.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); } });
      }
    );
    // Hard cap on the whole exchange, not just on socket silence.
    const cap = setTimeout(() => upReq.destroy(new Error("timeout")), YT_FAST_INFO_TIMEOUT_MS);
    upReq.on("close", () => clearTimeout(cap));
    upReq.on("timeout", () => upReq.destroy(new Error("timeout")));
    upReq.on("error", reject);
    upReq.end(body);
  });
}

// Turn the player responses into the same bodies the routes have always sent.
// Returns { single, video } — `video` is null when no quality list is available
// (then /yt-video-info waits for yt-dlp). Throws when nothing usable came back.
function shapeFastInfo(id, responses) {
  const url = `https://www.youtube.com/watch?v=${id}`;
  let details = null;
  let formats = [];
  let answered = 0;
  let gone = 0;
  for (const r of responses) {
    if (!r || typeof r !== "object") continue;
    answered++;
    const ps = r.playabilityStatus || {};
    if (ps.status === "ERROR") { gone++; continue; }
    // Only trust a response that says the video plays, or the web client's
    // routine "The page needs to be reloaded" refusal (its details are still
    // right). Anything else — age gate, private, members-only, an unavailable
    // stream recording, a bot check — is left to yt-dlp to judge.
    const playable = ps.status === "OK";
    if (!playable && !(ps.status === "UNPLAYABLE" && /reloaded/i.test(String(ps.reason || "")))) continue;
    const d = r.videoDetails;
    if (d && d.videoId === id && d.title && (!details || playable)) details = d;
    const af = r.streamingData && Array.isArray(r.streamingData.adaptiveFormats) ? r.streamingData.adaptiveFormats : [];
    if (playable && af.length > formats.length) formats = af;
  }
  // Every client says the video does not exist → answer that straight away.
  if (answered > 1 && gone === answered) {
    const e = { status: 500, body: { error: "This video is unavailable (removed, private, or taken down).", category: "unavailable", hint: "Try a different video." } };
    e.final = true;
    throw e;
  }
  if (!details) throw new Error("no details");
  if (details.isLive === true || details.isUpcoming === true) { const e = liveError(); e.final = true; throw e; }

  const duration = parseInt(details.lengthSeconds, 10);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("no duration");
  if (YT_MAX_DURATION_S && duration > YT_MAX_DURATION_S) { const e = tooLongError(); e.final = true; throw e; }

  const views = parseInt(details.viewCount, 10);
  const meta = {
    title: details.title,
    uploader: details.author || "",
    thumbnails: details.thumbnail && Array.isArray(details.thumbnail.thumbnails) ? details.thumbnail.thumbnails : [],
    duration,
    view_count: Number.isFinite(views) ? views : undefined,
    webpage_url: url,
    // Same field names videoShape() reads from yt-dlp's format list.
    formats: formats.map((f) => {
      const isVideo = /^video\//.test(String(f.mimeType || ""));
      const bytes = parseInt(f.contentLength, 10) ||
        Math.round(((parseInt(f.averageBitrate || f.bitrate, 10) || 0) / 8) * ((parseInt(f.approxDurationMs, 10) || duration * 1000) / 1000));
      return { vcodec: isVideo ? "v" : "none", acodec: isVideo ? "none" : "a", height: isVideo ? f.height : undefined, filesize: bytes || 0 };
    }),
  };
  if (!bestThumb(meta)) meta.thumbnail = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

  const video = videoShape(meta, url);
  return { single: singleShape(meta, url), video: video.qualities.length ? video : null };
}

const fastInfoCache = makeTtlCache(Math.min(YT_INFO_CACHE_S || 300, 1800), 500); // id -> { single, video }
const fastInflight = new Map();

function fastVideoInfo(id) {
  const hit = fastInfoCache.get(id);
  if (hit) return Promise.resolve(hit);
  let p = fastInflight.get(id);
  if (p) return p;
  p = Promise.all(FAST_CLIENTS.map((c) => fastPlayerRequest(c, id).catch(() => null)))
    .then((responses) => {
      const shaped = shapeFastInfo(id, responses);
      // Only keep a complete answer; a details-only one is retried next time.
      if (shaped.video) fastInfoCache.set(id, shaped);
      return shaped;
    });
  fastInflight.set(id, p);
  const clear = () => { if (fastInflight.get(id) === p) fastInflight.delete(id); };
  p.then(clear, clear);
  return p;
}

// What the two info routes call. `want` is "single" (/yt-info) or "video"
// (/yt-video-info). Resolves to the response body; rejects with { status, body }.
function lookupVideo(url, tag, want) {
  const key = videoCacheKey(url);
  const pick = (entry) => (want === "single" ? (entry.playlist || entry.single) : entry.video);

  const hit = freshInfo(key);
  if (hit) { cacheStats.infoHit++; return Promise.resolve(pick(hit)); }

  // Always start (or join) the full extraction: it is what the download needs.
  const full = getVideoInfo(url, tag);
  const id = key.startsWith("v:") ? key.slice(2) : "";
  if (!YT_FAST_INFO || id.length !== 11) return full.then(pick);

  return new Promise((resolve, reject) => {
    let settled = false;
    let fastDone = false;
    let fullFailed = false;
    let fullErr = null;
    const ok = (body) => { if (!settled) { settled = true; resolve(body); } };
    const bad = (e) => { if (!settled) { settled = true; reject(e); } };

    full.then(
      (entry) => ok(pick(entry)),
      (e) => { fullFailed = true; fullErr = e; if (fastDone) bad(e); }
    );
    fastVideoInfo(id).then(
      (f) => {
        fastDone = true;
        if (fullFailed) return bad(fullErr);          // yt-dlp already said no → its reason wins
        const body = want === "single" ? f.single : f.video;
        if (body) { if (!settled) cacheStats.infoFast++; return ok(body); }
        cacheStats.infoFastMiss++;                     // no quality list → wait for yt-dlp
      },
      (e) => {
        fastDone = true;
        if (e && e.final && e.status && e.body) return bad({ status: e.status, body: e.body });
        cacheStats.infoFastMiss++;
        if (fullFailed) bad(fullErr);
      }
    );
  });
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

  const fail = (e) => {
    if (e && e.status && e.body) return res.status(e.status).json(e.body);
    console.error("yt-info unexpected error:", e);
    return res.status(500).json({ error: "No video data" });
  };

  // Single video: shared metadata cache (also primes the download that follows).
  if (!playlist) {
    return lookupVideo(url, "yt-info", "single").then((body) => res.json(body), fail);
  }

  // Playlist / mix: short-lived cache of the flat track list.
  const cached = playlistCache.get(url);
  if (cached) return res.json(cached);

  const buildArgs = (proxy, fallback) => ["-J", "--no-warnings", "--cache-dir", YTDLP_CACHE_DIR, ...lookupNetArgs(), ...ytdlpCookieArgs(proxy, fallback), "--flat-playlist", url];
  execYtdlp(buildArgs, { timeout: 45000, maxBuffer: 48 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      console.error("yt-dlp yt-info error:", stderr);
      const info = classifyDownloadError(stderr);
      return res.status(500).json({ error: info.message, category: info.category, hint: info.hint });
    }
    let meta;
    try { meta = JSON.parse(stdout); } catch (e) { return res.status(500).json({ error: "Failed to parse video data" }); }
    if (!meta) return res.status(500).json({ error: "No video data" });

    const body = Array.isArray(meta.entries) ? playlistShape(meta) : singleShape(meta, url);
    if (Array.isArray(meta.entries)) playlistCache.set(url, body);
    res.json(body);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Instant browser hand-off (1.9.0)
// ═════════════════════════════════════════════════════════════════════════════
// The WordPress tool starts a download by pointing the browser at the signed
// link. The browser only "owns" a download (so it survives closing the tab or
// the whole site) once it has received the response HEADERS. Until 1.9.0 those
// were sent only after the complete file had been built on the server, so
// closing the page during that wait cancelled everything.
//
// Now, for a normal browser navigation, the headers go out as soon as the video
// is known to be downloadable (metadata is usually already cached from the
// lookup, so that is immediate) and the job is accepted. The browser shows the
// download straight away; the bytes follow when the file is ready.
//
// Trade-offs, by design:
//   • the size isn't known yet, so no Content-Length → the browser shows the
//     amount received but no percentage / time left;
//   • a failure after the headers can't be a JSON message any more — the
//     connection is cut so the browser marks the download as failed instead of
//     saving an empty file.
// In-page fetch()/XHR clients are NOT affected: they keep the old behaviour
// (Content-Length + JSON errors). YT_EARLY_HEADERS=0 turns the hand-off off.
const YT_EARLY_HEADERS = process.env.YT_EARLY_HEADERS !== "0";

// True for a top-level browser navigation (link click / address bar), false for
// fetch()/XHR. Browsers without Sec-Fetch-* headers are recognised by Accept.
function isNavigation(req) {
  const mode = req.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return /text\/html/i.test(req.get("accept") || "");
}
function wantsEarlyHeaders(req) {
  return YT_EARLY_HEADERS && isNavigation(req);
}

function sendEarlyHeaders(res, fileName, mime) {
  if (res.headersSent || res.destroyed) return false;
  res.status(200);
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.setHeader("Content-Type", mime);
  res.setHeader("Cache-Control", "no-store");
  // Tell nginx not to hold the headers / body back in its buffer.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  return true;
}

const htmlEscape = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Report a download-route failure. Headers already sent → cut the connection
// (failed download, never a silent empty file). A browser navigation gets a
// small readable page instead of raw JSON; API clients get the same JSON as ever.
function failDl(req, res, status, body) {
  if (res.headersSent) { if (!res.writableEnded) res.destroy(); return; }
  if (!isNavigation(req)) return res.status(status).json(body);
  const title = htmlEscape(body.message || body.error || "Download failed");
  const hint = htmlEscape(body.hint || "");
  res.status(status).type("html").send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>Download could not start</title>` +
    `<style>body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f9;color:#1d2330;display:flex;min-height:100vh;align-items:center;justify-content:center}` +
    `main{max-width:440px;margin:24px;padding:28px;background:#fff;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 10px}p{margin:0 0 18px;color:#556}` +
    `button{font:inherit;padding:10px 18px;border:0;border-radius:9px;background:#1d2330;color:#fff;cursor:pointer}</style></head>` +
    `<body><main><h1>${title}</h1>${hint ? `<p>${hint}</p>` : "<p>Please go back and try again.</p>"}` +
    `<button type="button" onclick="if(history.length>1){history.back()}else{window.close()}">Go back</button></main></body></html>`
  );
}

// Before committing to an early 200, make sure the video can actually be
// downloaded (private / removed / live / age-gated are caught here and still get
// a proper error). Uses the shared metadata cache, so right after a lookup this
// costs nothing — and the metadata it fetches is reused by the download itself.
function preflightThen(req, res, url, early, onOk, onFail) {
  if (!early || !YT_INFO_CACHE_S) return onOk();
  getVideoInfo(url, "download-preflight").then(
    () => {
      if (res.destroyed || req.destroyed) { onFail(); return; }
      onOk();
    },
    (e) => {
      onFail();
      if (res.destroyed) return;
      if (e && e.status && e.body) return failDl(req, res, e.status, Object.assign({ message: e.body.error }, e.body));
      failDl(req, res, 500, { error: "Download failed", message: "The server couldn't prepare this download." });
    }
  );
}

// ── GET /yt-download ──────────────────────────────────────────────────────────
router.get("/yt-download", (req, res) => {
  const raw = req.query.url;
  const title = req.query.title || "audio";
  const requested = String(req.query.format || "mp3").toLowerCase();
  const fmt = DOWNLOAD_FORMATS[requested];
  if (!fmt) return failDl(req, res, 400, { error: "Unsupported output format" });

  const opts = { bitrate: normalizeBitrate(req.query.bitrate), meta: String(req.query.meta || "") === "1" };
  const priority = String(req.query.v || "") === "2" && String(req.query.priority || "") === "1";

  const sigCheck = downloadSigCheck(req.query);
  if (!sigCheck.ok) {
    console.warn(`[yt-sig] rejected reason=${sigCheck.reason} exp=${req.query.exp || ""} now=${Math.floor(Date.now() / 1000)}`);
    return failDl(req, res, 403, { error: "Invalid or expired download link", code: "bad_link", reason: sigCheck.reason });
  }
  if (!raw || !isYouTubeUrl(raw)) return failDl(req, res, 400, { error: "Invalid YouTube URL" });
  const url = normalizeYouTubeUrl(raw);

  const safeTitle = String(title).replace(/[^a-zA-Z0-9_\- ]/g, "").trim() || "audio";
  const early = wantsEarlyHeaders(req);
  let earlySent = false; // response headers already handed to the browser
  let served = false;    // the finished file has started streaming
  logRequest(req, res, "yt-download", { early, video: videoCacheKey(url), format: requested, bitrate: opts.bitrate || "", priority });
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

  const startJob = () => scheduleJob(priority, (release) => {
    if (res.writableEnded || req.destroyed) { cleanup(); release(); return; }
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      if (earlySent && !served && !res.writableEnded) res.destroy(); // failed → browser shows a failed download
      release();
    };
    res.on("finish", releaseSlot);
    res.on("close", releaseSlot);

    let current = null;
    let aborted = false;
    let softRetried = false;
    let waitedForInfo = false;

    const runAttempt = (attempt, allowReuse, fallback) => {
      if (aborted) { cleanup(); releaseSlot(); return; }
      // The lookup's extraction for this video is still running → wait for it and
      // reuse its result instead of starting a second one next to it.
      const inflight = allowReuse && !waitedForInfo ? infoInflight.get(videoCacheKey(url)) : null;
      if (inflight) {
        waitedForInfo = true;
        const again = () => runAttempt(attempt, allowReuse, fallback);
        return void inflight.then(again, again);
      }
      cleanup(); // clear any partial output left by a previous attempt

      // Speed: if /yt-info (or /yt-video-info) looked this video up recently, hand
      // yt-dlp that saved metadata so it starts downloading immediately instead of
      // repeating the whole extraction. Must use the same proxy as that lookup.
      const cached = allowReuse ? reusableInfo(url) : null;
      if (cached) cacheStats.infoReused++;
      const proxy = cached ? cached.proxy : pickProxy();

      const ytdlp = spawn(YTDLP_BIN, [
        ...buildYtdlpArgs(fmt, opts),
        ...ytdlpDownloaderArgs(),
        ...downloadGuardArgs(),
        "--concurrent-fragments", String(YTDLP_FRAGMENTS),
        "--retries", "3",
        "--fragment-retries", "5",
        "--cache-dir", YTDLP_CACHE_DIR,
        "--postprocessor-args", "ffmpeg:-threads 0",
        ...(FFMPEG_LOCATION ? ["--ffmpeg-location", FFMPEG_LOCATION] : []),
        ...ytdlpCookieArgs(proxy, fallback),
        "--no-mtime",
        "-o", outTemplate,
        "--no-playlist",
        "--no-progress",
        ...(cached ? ["--load-info-json", cached.file] : [url]),
      ]);
      current = ytdlp;
      // Drain stdout (an unread pipe can stall yt-dlp) and keep its tail: that is
      // where a "does not pass filter" skip (live stream / too long) is reported.
      let stdoutTail = "";
      ytdlp.stdout.on("data", (d) => { stdoutTail = (stdoutTail + d.toString()).slice(-4096); });

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
            failDl(req, res, 500, { error: "Download failed", category: "ytdlp-missing", message: "yt-dlp isn't installed or isn't on the server's PATH.", hint: "Install yt-dlp (or set YTDLP_PATH) and restart." });
          } else {
            failDl(req, res, 500, { error: "Download failed", category: "spawn", message: "The server couldn't start the download process.", hint: "Check the server logs." });
          }
        }
        releaseSlot();
      });

      ytdlp.on("close", async (code) => {
        clearTimeout(jobTimer);
        if (aborted) { cleanup(); releaseSlot(); return; }
        let produced = null;
        try {
          const dir = os.tmpdir();
          const base = prefix + ".";
          const extOf = (f) => f.slice(base.length).toLowerCase();
          const files = fs.readdirSync(dir).filter((f) => f.startsWith(base) && !f.endsWith(".part"));
          const pick = files.find((f) => extOf(f) === fmt.ext) || files.find((f) => extOf(f) === fmt.audioFormat);
          if (pick) produced = path.join(dir, pick);
        } catch (e) {}
        if (!produced && !cached && !timedOut) noteProxyFailure(proxy, stderr);

        // The saved metadata didn't work (expired/rejected media URL) → forget it
        // and run once more the normal way. Doesn't count as a proxy retry.
        if (!timedOut && !produced && cached) {
          cacheStats.infoReuseFailed++;
          dropInfo(videoCacheKey(url));
          console.warn("[yt-cache] audio: cached metadata failed, re-extracting. " + String(stderr).trim().split(/\r?\n/).pop().slice(0, 200));
          return runAttempt(attempt, false);
        }

        // Retry with a fresh proxy on a bot-check when nothing was produced.
        if (!timedOut && !produced && isBotCheckError(stderr) && attempt < YT_PROXY_RETRIES) {
          console.warn(`[yt-retry] audio bot-check, retry ${attempt + 1}/${YT_PROXY_RETRIES}`);
          return runAttempt(attempt + 1, false);
        }

        // One more try (fresh extraction, fresh proxy, fallback client settings)
        // on a network blip / refused media request / extractor hiccup.
        if (!timedOut && !produced && !softRetried && isRetryableError(stderr)) {
          softRetried = true;
          console.warn("[yt-retry] audio: retrying once with fallback settings: " + String(stderr).trim().split(/\r?\n/).pop().slice(0, 160));
          return runAttempt(attempt, false, true);
        }

        if (timedOut) {
          console.error(`yt-dlp timed out after ${YT_TIMEOUT_S}s for ${url}`);
          cleanup();
          failDl(req, res, 504, { error: "Download timed out", category: "timeout", message: "The server took too long to build this file.", hint: "Try again; if it repeats, lower concurrency." });
          releaseSlot();
          return;
        }
        if (!produced) {
          console.error("yt-dlp failed (code " + code + "), no output. stderr:\n" + stderr);
          const info = classifyDownloadError(stderr + "\n" + skipNoteFrom(stdoutTail));
          cleanup();
          failDl(req, res, 500, { error: "Conversion failed", category: info.category, message: info.message, hint: info.hint, detail: info.detail });
          releaseSlot();
          return;
        }
        if (code !== 0) console.warn("yt-dlp exited " + code + " but output exists; serving anyway. stderr:", stderr);

        const verified = await verifyDownloadedOutput(produced, requested);
        if (!verified.ok) {
          console.error(`yt-dlp produced the wrong format for ${requested}: ${verified.detail}`);
          cleanup();
          failDl(req, res, 500, { error: "Wrong output format", category: "wrong-output-format", message: `The server could not produce a valid ${requested.toUpperCase()} file.`, hint: "Check yt-dlp/FFmpeg versions and the VPS logs." });
          releaseSlot();
          return;
        }

        const safeFile = `${safeTitle}.${fmt.ext}`;
        if (!res.headersSent) res.setHeader("Content-Disposition", `attachment; filename="${safeFile}"; filename*=UTF-8''${encodeURIComponent(safeFile)}`);
        if (!res.headersSent) res.setHeader("Content-Type", fmt.mime);
        if (!res.headersSent) res.setHeader("Accept-Ranges", "bytes");
        try { if (!res.headersSent) res.setHeader("Content-Length", fs.statSync(produced).size); } catch (e) {}

        served = true;
        const stream = fs.createReadStream(produced, { highWaterMark: 1024 * 1024 });
        stream.on("error", () => { cleanup(); failDl(req, res, 500, { error: "Read failed" }); releaseSlot(); });
        stream.on("close", cleanup);
        stream.pipe(res);
      });
    };

    req.on("aborted", () => { aborted = true; if (current && current.exitCode === null) current.kill(); cleanup(); releaseSlot(); });
    res.on("close", () => { if (!res.writableEnded) { aborted = true; if (current && current.exitCode === null) current.kill(); cleanup(); } });

    runAttempt(0, true);
  });

  preflightThen(req, res, url, early, () => {
    if (startJob()) {
      if (early) earlySent = sendEarlyHeaders(res, `${safeTitle}.${fmt.ext}`, fmt.mime);
      return;
    }
    return failDl(req, res, 503, { error: "Server busy", category: "queue-full", message: "The download queue is full right now.", hint: "Please wait a moment and try again." });
  }, cleanup);
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

  lookupVideo(url, "yt-video-info", "video").then(
    (body) => res.json(body),
    (e) => {
      if (e && e.status && e.body) return res.status(e.status).json(e.body);
      console.error("yt-video-info unexpected error:", e);
      return res.status(500).json({ error: "No video data" });
    }
  );
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
    return failDl(req, res, 403, { error: "Invalid or expired download link", code: "bad_link", reason: sigCheck.reason });
  }
  if (!raw || !isYouTubeUrl(raw)) return failDl(req, res, 400, { error: "Invalid YouTube URL" });
  const url = normalizeYouTubeUrl(raw);

  const safeTitle = String(title).replace(/[^a-zA-Z0-9_\- ]/g, "").trim() || "video";
  const early = wantsEarlyHeaders(req);
  let earlySent = false; // response headers already handed to the browser
  let served = false;    // the finished file has started streaming
  logRequest(req, res, "yt-video-download", { early, video: videoCacheKey(url), quality: quality || "best", priority });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytgrabv-"));

  function cleanup() {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
  }

  const startJob = () => scheduleJob(priority, (release) => {
    if (res.writableEnded || req.destroyed) { cleanup(); release(); return; }
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      if (earlySent && !served && !res.writableEnded) res.destroy(); // failed → browser shows a failed download
      release();
    };

    const outTemplate = path.join(workDir, "out.%(ext)s");
    let finished = false;
    let current = null;
    let aborted = false;
    let softRetried = false;
    let waitedForInfo = false;
    const finish = () => { if (finished) return; finished = true; cleanup(); releaseSlot(); };

    const runAttempt = (attempt, allowReuse, fallback) => {
      if (aborted) { finish(); return; }
      // The lookup's extraction for this video is still running → wait for it and
      // reuse its result instead of starting a second one next to it.
      const inflight = allowReuse && !waitedForInfo ? infoInflight.get(videoCacheKey(url)) : null;
      if (inflight) {
        waitedForInfo = true;
        const again = () => runAttempt(attempt, allowReuse, fallback);
        return void inflight.then(again, again);
      }
      // Clear any partial output left by a previous attempt.
      try { for (const f of fs.readdirSync(workDir)) fs.rmSync(path.join(workDir, f), { recursive: true, force: true }); } catch (e) {}

      // Speed: reuse the metadata /yt-video-info just fetched (same proxy) so the
      // download starts at once instead of repeating the extraction.
      const cached = allowReuse ? reusableInfo(url) : null;
      if (cached) cacheStats.infoReused++;
      const proxy = cached ? cached.proxy : pickProxy();

      const ytdlp = spawn(YTDLP_BIN, [
        "-f", videoFormatSelector(quality),
        "-S", videoFormatSort(quality),
        "--merge-output-format", "mp4",
        ...ytdlpDownloaderArgs(),
        ...downloadGuardArgs(),
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
        ...ytdlpCookieArgs(proxy, fallback),
        "--no-mtime",
        "-o", outTemplate,
        "--no-playlist",
        "--no-progress",
        ...(cached ? ["--load-info-json", cached.file] : [url]),
      ]);
      current = ytdlp;
      // Drain stdout (an unread pipe can stall yt-dlp) and keep its tail: that is
      // where a "does not pass filter" skip (live stream / too long) is reported.
      let stdoutTail = "";
      ytdlp.stdout.on("data", (d) => { stdoutTail = (stdoutTail + d.toString()).slice(-4096); });

      let stderr = "";
      let timedOut = false;
      const jobTimer = setTimeout(() => { timedOut = true; if (ytdlp.exitCode === null) ytdlp.kill("SIGKILL"); }, YT_TIMEOUT_S * 1000);

      ytdlp.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 65536) stderr = stderr.slice(-65536); });

      ytdlp.on("error", (err) => {
        clearTimeout(jobTimer);
        console.error("yt video spawn error:", err);
        if (!res.headersSent) {
          if (err && err.code === "ENOENT") {
            failDl(req, res, 500, { error: "Download failed", category: "ytdlp-missing", message: "yt-dlp isn't installed or isn't on the server's PATH.", hint: "Install yt-dlp (or set YTDLP_PATH) and restart." });
          } else {
            failDl(req, res, 500, { error: "Download failed", category: "spawn", message: "The server couldn't start the download process.", hint: "Check the server logs." });
          }
        } else {
          try { res.destroy(); } catch (e) {}
        }
        finish();
      });

      ytdlp.on("close", (code) => {
        clearTimeout(jobTimer);
        if (aborted) { finish(); return; }
        // Find the finished MP4 in the work dir.
        let produced = null;
        try {
          const files = fs.readdirSync(workDir).filter((f) => f.startsWith("out.") && !f.endsWith(".part"));
          const pick = files.find((f) => f.toLowerCase().endsWith(".mp4")) || files[0];
          if (pick) produced = path.join(workDir, pick);
        } catch (e) {}
        if (!produced && !cached && !timedOut) noteProxyFailure(proxy, stderr);

        // The saved metadata didn't work (expired/rejected media URL) → forget it
        // and run once more the normal way. Doesn't count as a proxy retry.
        if (!timedOut && !produced && cached) {
          cacheStats.infoReuseFailed++;
          dropInfo(videoCacheKey(url));
          console.warn("[yt-cache] video: cached metadata failed, re-extracting. " + String(stderr).trim().split(/\r?\n/).pop().slice(0, 200));
          return runAttempt(attempt, false);
        }

        // Retry with a fresh proxy on a bot-check when nothing was produced.
        if (!timedOut && !produced && isBotCheckError(stderr) && attempt < YT_PROXY_RETRIES) {
          console.warn(`[yt-retry] video bot-check, retry ${attempt + 1}/${YT_PROXY_RETRIES}`);
          return runAttempt(attempt + 1, false);
        }

        // One more try (fresh extraction, fresh proxy, fallback client settings)
        // on a network blip / refused media request / extractor hiccup.
        if (!timedOut && !produced && !softRetried && isRetryableError(stderr)) {
          softRetried = true;
          console.warn("[yt-retry] video: retrying once with fallback settings: " + String(stderr).trim().split(/\r?\n/).pop().slice(0, 160));
          return runAttempt(attempt, false, true);
        }

        if (timedOut) {
          console.error(`yt-dlp (video) timed out for ${url}`);
          failDl(req, res, 504, { error: "Download timed out", category: "timeout", message: "The server took too long to build this video.", hint: "Try a lower quality; if it repeats, lower concurrency." });
          finish();
          return;
        }
        if (!produced) {
          console.error("yt-dlp (video) failed (code " + code + "), no output. stderr:\n" + stderr);
          const info = classifyDownloadError(stderr + "\n" + skipNoteFrom(stdoutTail));
          failDl(req, res, 500, { error: "Download failed", category: info.category, message: info.message, hint: info.hint, detail: info.detail });
          finish();
          return;
        }
        if (code !== 0) console.warn("yt-dlp (video) exited " + code + " but output exists; serving anyway.");

        // Serve the real MP4 with a correct Content-Length → accurate progress bar.
        const safeFile = `${safeTitle}.mp4`;
        if (!res.headersSent) res.setHeader("Content-Disposition", `attachment; filename="${safeFile}"; filename*=UTF-8''${encodeURIComponent(safeFile)}`);
        if (!res.headersSent) res.setHeader("Content-Type", "video/mp4");
        if (!res.headersSent) res.setHeader("Cache-Control", "no-store");
        if (!res.headersSent) res.setHeader("Accept-Ranges", "bytes");
        try { if (!res.headersSent) res.setHeader("Content-Length", fs.statSync(produced).size); } catch (e) {}

        served = true;
        const stream = fs.createReadStream(produced, { highWaterMark: 1024 * 1024 });
        stream.on("error", () => { failDl(req, res, 500, { error: "Read failed" }); finish(); });
        stream.on("close", finish);
        stream.pipe(res);
      });
    };

    // Client went away → stop the work immediately.
    req.on("aborted", () => { aborted = true; if (current && current.exitCode === null) current.kill("SIGKILL"); finish(); });
    res.on("close", () => { if (!res.writableEnded) { aborted = true; if (current && current.exitCode === null) current.kill("SIGKILL"); } finish(); });

    runAttempt(0, true);
  });

  preflightThen(req, res, url, early, () => {
    if (startJob()) {
      if (early) earlySent = sendEarlyHeaders(res, `${safeTitle}.mp4`, "video/mp4");
      return;
    }
    cleanup();
    return failDl(req, res, 503, { error: "Server busy", category: "queue-full", message: "The download queue is full right now.", hint: "Please wait a moment and try again." });
  }, cleanup);
});

// ── GET /yt-search ────────────────────────────────────────────────────────────
// Keyword search → list of matching videos. The WordPress tool shows the results
// and lets the visitor pick one to download.
//
// Speed (1.8.0): results are cached for a few minutes, and a search that isn't
// cached is answered by ONE direct HTTPS request to YouTube's own search endpoint
// (kept-alive connection) instead of starting a yt-dlp process. If that direct
// request fails or looks wrong for any reason, the original yt-dlp `ytsearch`
// path below runs exactly as before, so search can only get faster, not break.
function parseClock(text) {
  const parts = String(text || "").trim().split(":").map((p) => parseInt(p, 10));
  if (!parts.length || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function fastSearch(q, limit) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      context: { client: { clientName: "WEB", clientVersion: "2.20250101.00.00", hl: "en", gl: "US" } },
      query: q,
      params: "EgIQAQ%3D%3D", // videos only
    });
    const upReq = https.request(
      "https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
      {
        method: "POST",
        agent: keepAliveAgent,
        timeout: 4000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      (up) => {
        if (up.statusCode !== 200) { up.resume(); return reject(new Error("HTTP " + up.statusCode)); }
        const chunks = [];
        let size = 0;
        up.on("data", (c) => { size += c.length; if (size > 8 * 1024 * 1024) { up.destroy(new Error("too large")); return; } chunks.push(c); });
        up.on("error", reject);
        up.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const sections = data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents;
            const results = [];
            for (const s of sections) {
              const items = (s && s.itemSectionRenderer && s.itemSectionRenderer.contents) || [];
              for (const it of items) {
                const v = it && it.videoRenderer;
                if (!v || !/^[A-Za-z0-9_-]{11}$/.test(String(v.videoId || ""))) continue;
                const id = v.videoId;
                const title = v.title && (v.title.simpleText || (Array.isArray(v.title.runs) ? v.title.runs.map((r) => r.text).join("") : ""));
                const owner = v.ownerText || v.longBylineText || v.shortBylineText;
                const uploader = (owner && Array.isArray(owner.runs) && owner.runs[0] && owner.runs[0].text) || "";
                const views = v.viewCountText && v.viewCountText.simpleText ? String(v.viewCountText.simpleText).replace(/[^0-9]/g, "") : "";
                let thumb = "", bestW = -1;
                for (const t of (v.thumbnail && Array.isArray(v.thumbnail.thumbnails) ? v.thumbnail.thumbnails : [])) {
                  if (t && t.url && (t.width || 0) > bestW) { thumb = t.url; bestW = t.width || 0; }
                }
                if (thumb.startsWith("//")) thumb = "https:" + thumb;
                results.push({
                  id,
                  title: title || "Untitled",
                  url: `https://www.youtube.com/watch?v=${id}`,
                  uploader,
                  duration: v.lengthText ? parseClock(v.lengthText.simpleText) : null,
                  view_count: views ? parseInt(views, 10) : null,
                  thumbnail: thumb || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
                });
                if (results.length >= limit) break;
              }
              if (results.length >= limit) break;
            }
            resolve(results);
          } catch (e) { reject(e); }
        });
      }
    );
    upReq.on("timeout", () => upReq.destroy(new Error("timeout")));
    upReq.on("error", reject);
    upReq.end(body);
  });
}

const searchInflight = new Map(); // cacheKey -> Promise (collapses identical searches)

router.get("/yt-search", (req, res) => {
  if (!apiKeyOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const q = String(req.query.q || req.query.query || "").trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: "Missing search query" });

  let limit = parseInt(req.query.limit || "12", 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 12;
  if (limit > 25) limit = 25;

  const cacheKey = limit + ":" + q.toLowerCase();
  const hit = searchCache.get(cacheKey);
  if (hit) { cacheStats.searchHit++; return res.json({ query: q, count: hit.length, results: hit }); }

  // Original yt-dlp search — still the source of truth whenever the fast path
  // can't answer. `ytsearchN:<query>` is a yt-dlp INPUT SPEC passed as a single
  // argv element to execFile (no shell is spawned), so the query text can never
  // inject arguments or shell metacharacters — it is handled verbatim by yt-dlp.
  const viaYtdlp = () => new Promise((resolve, reject) => {
    cacheStats.searchYtdlp++;
    const spec = `ytsearch${limit}:${q}`;
    const buildArgs = (proxy, fallback) => ["-J", "--flat-playlist", "--no-warnings", "--cache-dir", YTDLP_CACHE_DIR, ...ytdlpCookieArgs(proxy, fallback), spec];
    execYtdlp(buildArgs, { timeout: 30000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.error("yt-dlp yt-search error:", stderr);
        const info = classifyDownloadError(stderr);
        return reject({ status: 500, body: { error: info.message || "Search failed", category: info.category, hint: info.hint } });
      }
      let meta;
      try { meta = JSON.parse(stdout); } catch (e) { return reject({ status: 500, body: { error: "Failed to parse search results" } }); }
      const entries = meta && Array.isArray(meta.entries) ? meta.entries : [];
      resolve(entries
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
        }));
    });
  });

  let pending = searchInflight.get(cacheKey);
  if (!pending) {
    const fast = YT_FAST_SEARCH
      ? fastSearch(q, limit).then((results) => {
          // Too few rows for the request → don't trust it, ask yt-dlp instead.
          if (results.length < Math.min(limit, 5)) throw new Error("only " + results.length + " result(s)");
          cacheStats.searchFast++;
          return results;
        })
      : Promise.reject(new Error("disabled"));
    pending = fast
      .catch((e) => {
        if (YT_FAST_SEARCH) console.warn("[yt-search] fast path unavailable (" + String((e && e.message) || e).slice(0, 120) + "), using yt-dlp");
        return viaYtdlp();
      })
      .then((results) => { if (results.length) searchCache.set(cacheKey, results); return results; });
    searchInflight.set(cacheKey, pending);
    const clear = () => { if (searchInflight.get(cacheKey) === pending) searchInflight.delete(cacheKey); };
    pending.then(clear, clear);
  }

  pending.then(
    (results) => res.json({ query: q, count: results.length, results }),
    (e) => {
      if (e && e.status && e.body) return res.status(e.status).json(e.body);
      console.error("yt-search unexpected error:", e);
      return res.status(500).json({ error: "Search failed" });
    }
  );
});

// ── GET /yt-suggest ─────────────────────────────────────────────────────────
// Autocomplete suggestions from YouTube's public suggest endpoint, proxied here
// so the browser isn't blocked by CORS. Always resolves (empty list on any
// problem) so a hiccup never breaks typing. Returns { query, suggestions:[...] }.
//
// Speed (1.8.0): answers are cached (same prefix typed again = instant) and the
// upstream connection is kept alive, so a keystroke no longer pays a new TLS
// handshake. The upstream wait is capped at 2.5 s so typing never stalls.
router.get("/yt-suggest", (req, res) => {
  if (!apiKeyOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const q = String(req.query.q || req.query.query || "").trim().slice(0, 150);
  if (!q) return res.json({ query: "", suggestions: [] });
  const hl = (String(req.query.hl || "en").replace(/[^a-zA-Z-]/g, "").slice(0, 8)) || "en";

  const cacheKey = hl.toLowerCase() + ":" + q.toLowerCase();
  const hit = suggestCache.get(cacheKey);
  if (hit) { cacheStats.suggestHit++; return res.json({ query: q, suggestions: hit }); }

  const api =
    "https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=" +
    encodeURIComponent(hl) + "&q=" + encodeURIComponent(q);

  let done = false;
  const finish = (suggestions, cacheable) => {
    if (done) return;
    done = true;
    const list = suggestions || [];
    if (cacheable) suggestCache.set(cacheKey, list); // never cache a failure
    res.json({ query: q, suggestions: list });
  };

  const upReq = https.get(api, { agent: keepAliveAgent, timeout: 2500, headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json, text/javascript, */*" } }, (up) => {
    let raw = "";
    up.setEncoding("utf8");
    up.on("data", (c) => { raw += c; if (raw.length > 65536) { up.destroy(); } });
    up.on("end", () => {
      let parsed = null, out = [];
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      const good = up.statusCode === 200 && Array.isArray(parsed) && Array.isArray(parsed[1]);
      if (good) {
        out = parsed[1]
          .map((x) => (Array.isArray(x) ? x[0] : x))
          .filter((s) => typeof s === "string" && s)
          .slice(0, 10);
      }
      finish(out, good);
    });
    up.on("error", () => finish([], false));
  });
  upReq.on("timeout", () => { upReq.destroy(); finish([], false); });
  upReq.on("error", () => finish([], false));
});

// ── GET /yt-diag ──────────────────────────────────────────────────────────────
router.get("/yt-diag", (req, res) => {
  res.json({
    routes: ["/yt-info", "/yt-download", "/yt-video-info", "/yt-video-download", "/yt-search", "/yt-suggest"],
    downloads: { active: activeJobs, queued: jobQueue.length, concurrency: YT_MAX_CONCURRENT, queueLimit: YT_MAX_QUEUE },
    ytdlpPath: YTDLP_BIN,
    ffmpegLocation: FFMPEG_LOCATION || "(PATH)",
    secret: API_SECRET ? "set" : "open",
    ytdlp: ytdlpStatus,
    earlyHeaders: YT_EARLY_HEADERS,
    lookups: { active: lookupsActive, waiting: lookupsWaiting.length, concurrency: YT_INFO_MAX_CONCURRENT },
    // Performance knobs
    extractorArgs: (process.env.YTDLP_EXTRACTOR_ARGS || DEFAULT_EXTRACTOR_ARGS) || "(default web client)",
    aria2c: USE_ARIA2 ? "on" : (ARIA2_AVAILABLE ? "available (disabled)" : "not installed"),
    fragments: YTDLP_FRAGMENTS,
    infoCache: YT_INFO_CACHE_S ? { ttlSeconds: YT_INFO_CACHE_S, entries: infoCache.size } : "disabled",
    fastInfo: YT_FAST_INFO ? { timeoutMs: YT_FAST_INFO_TIMEOUT_MS, entries: fastInfoCache.size } : "disabled",
    proxies: { total: loadProxyPool().length, resting: Array.from(proxyCooldown.values()).filter((t) => t > Date.now()).length },
    cache: {
      searchEntries: searchCache.size,
      suggestEntries: suggestCache.size,
      fastSearch: YT_FAST_SEARCH,
      stats: cacheStats,
    },
  });
});

// Expose status for the health check in server.js "/" if you want it.
router.getStatus = () => ({ active: activeJobs, queued: jobQueue.length });

module.exports = router;
