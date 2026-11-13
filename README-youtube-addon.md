# TrackGrab — YouTube add-on (`youtube.js`)

Adds YouTube support to the TrackGrab backend. The fixed 1.4.1 package already
mounts this router in `server.js`; yt-dlp handles YouTube without another npm
dependency.

## Install

Deploy the complete 1.4.1 backend folder and restart the service. No manual route
change is needed in that package.

If you are adding only `youtube.js` to an older TrackGrab backend, copy it next to
`server.js`, then mount it once after `express.json()`:

   ```js
   // YouTube routes (/yt-info, /yt-download, /yt-diag).
   const ytRouter = require("./youtube");
   app.use(ytRouter);
   ```

Then restart the older service (`pm2 restart trackgrab`, or however it runs).

## Verify

- `https://<your-api>/yt-diag` → shows yt-dlp path, queue, and whether the secret is set.
- `https://<your-api>/yt-info?url=https://youtu.be/dQw4w9WgXcQ` (send header
  `X-API-Key: <your secret>`) → returns the video's title/thumbnail/duration.

## Endpoints

| Route | Purpose |
|-------|---------|
| `GET /yt-info?url=…` | Video metadata (or a playlist's flat track list). Needs `X-API-Key`. |
| `GET /yt-download?url=…&format=…&title=…&exp=…&v=2&sig=…` | Signed link; streams the extracted audio as an attachment. |
| `GET /yt-diag` | Health of the YouTube routes. |

## Config

Shares your existing env. Notable ones:

- `SCLOUD_API_SECRET` — **must equal** the "Shared API secret" set in both
  WordPress plugins. Always set a fresh value in production; never rely on the
  compatibility fallback embedded in older packages.
- Reliability / speed knobs added in 1.8.0 (all optional): `YTDLP_AUTO_UPDATE`,
  `YTDLP_STALE_DAYS`, `YTDLP_FALLBACK_EXTRACTOR_ARGS`, `YT_MAX_DURATION_S`,
  `YT_INFO_MAX_CONCURRENT`, `YT_INFO_CACHE_MAX`, `YT_PLAYLIST_CACHE_S`,
  `YT_SEARCH_CACHE_S`, `YT_SUGGEST_CACHE_S`, `YT_FAST_SEARCH` — see `.env.example`
  and the 1.8.0 section of `CHANGELOG.md`. `GET /yt-diag` shows yt-dlp's version
  and age, the lookup load and the cache counters.
- `YT_MAX_CONCURRENT` (default 2), `YT_MAX_QUEUE` (30), `YT_DOWNLOAD_TIMEOUT_S` (900).
- `YTDLP_COOKIES` (path to a cookies.txt) or `YTDLP_COOKIES_FROM_BROWSER` —
  optional, helps with age-restricted videos or "sign in to confirm you're not a bot".
- `YTDLP_PATH`, `FFMPEG_LOCATION`, `YTDLP_CACHE_DIR`, `YTDLP_FRAGMENTS` — same as `server.js`.

## Notes

- The download-link signature is byte-for-byte the same scheme as `server.js`'s
  SoundCloud `/download`, so the WordPress plugins sign links exactly the way the
  downloader already does.
- The YouTube job queue is **separate** from the SoundCloud one, so YouTube load
  never starves SoundCloud downloads (and vice-versa).
- Keep `yt-dlp` updated (`yt-dlp -U`) — YouTube changes often; a stale binary is the
  most common cause of "couldn't read this video".
