// The shared API secret is loaded from an UNTRACKED file (secret.key) so it
// never lands in git / GitHub (this repo is public). Create it once per machine,
// inside this folder:
//     echo "your-64-char-secret" > secret.key
// Falls back to the SCLOUD_API_SECRET env var if that is set instead.
const fs = require("fs");
const path = require("path");
let SCLOUD_API_SECRET = (process.env.SCLOUD_API_SECRET || "").trim();
if (!SCLOUD_API_SECRET) {
  try { SCLOUD_API_SECRET = fs.readFileSync(path.join(__dirname, "secret.key"), "utf8").trim(); } catch (e) {}
}

// Optional machine-specific overrides from an UNTRACKED env.local file (one
// KEY=VALUE per line) — e.g. YTDLP_PROXY, YTDLP_EXTRACTOR_ARGS, YTDLP_COOKIES.
// Kept out of git so the public repo carries no server-specific config and
// `git pull` never conflicts with it.
const localEnv = {};
try {
  const raw = fs.readFileSync(path.join(__dirname, "env.local"), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) localEnv[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch (e) {}

module.exports = {
  apps: [
    {
      name: "trackgrab",
      script: "./server.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      restart_delay: 3000,
      max_memory_restart: "700M",
      kill_timeout: 12000,
      listen_timeout: 10000,
      time: true,
      env: {
        NODE_ENV: "production",
        PORT: "3001",
        MAX_CONCURRENT: "2",
        MAX_QUEUE: "30",
        DOWNLOAD_TIMEOUT_S: "900",
        YTDLP_FRAGMENTS: "4",
        CORS_ALLOWED_ORIGINS: "https://youtubemp4download.com,https://www.youtubemp4download.com",
        SCLOUD_API_SECRET,
        M4A_BITRATE: "128",
        // Server-specific knobs (cookies / proxy / PO-token extractor-args) live
        // in an untracked env.local file; they are merged in here and override
        // the defaults above. Example env.local lines:
        //   YTDLP_PROXY=http://user:pass@host:port
        //   YTDLP_EXTRACTOR_ARGS=youtube:player_client=default,mweb,tv;;youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416
        ...localEnv,
      },
    },
  ],
};
