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
        // ── Part 9 (optional): set ONLY if YouTube blocks the VPS IP ──
        // Cookies exported from a logged-in browser (Netscape cookies.txt):
        // YTDLP_COOKIES: "/home/deploy/trackgrab-backend/cookies.txt",
        // ...or read live from a browser profile on the VPS: "chrome" | "firefox"
        // YTDLP_COOKIES_FROM_BROWSER: "chrome",
        // Residential/HTTP/SOCKS proxy for yt-dlp:
        // YTDLP_PROXY: "http://user:pass@host:port",
      },
    },
  ],
};
