# Changelog

## 1.10.0 — instant lookups

Only `youtube.js` has code changes. No route, parameter, signature or CORS change; responses keep their shape. The WordPress plugins need no update for this.

- **Lookups answer in under a second.** A fresh `/yt-info` / `/yt-video-info` used to wait for the whole `yt-dlp -J` extraction (measured 13–25 s on the live server). The title, thumbnail, length and the quality list with sizes now come from one quick request to YouTube's own player endpoint, while the full extraction runs in the background exactly as before so the download that follows finds its metadata ready. If the quick request cannot answer (blocked, age-gated, unusual video, YouTube changed something) the route waits for yt-dlp as it always did. `YT_FAST_INFO=0` switches it off; `YT_FAST_INFO_TIMEOUT_MS` (3000) caps the quick request. The quick request does not use the proxy pool.
- **A download started while that background extraction is still running waits for it** and reuses its result, instead of starting a second extraction next to it.
- **Videos that do not exist are refused at once** (all player clients report it), and a permanent failure (private, removed, region-blocked, DRM, live) is remembered for 60 s so a repeat lookup or the download click does not run the extraction again.
- **Failing proxies are rested.** A proxy that hits a bot-check is skipped for 10 minutes, one with a dead/slow connection for 3 minutes (the whole pool is used again if all are resting). `/yt-diag` shows `proxies.total` / `proxies.resting`.
- **Lookups give up on a silent connection after 12 s** (`YT_LOOKUP_SOCKET_TIMEOUT_S`, yt-dlp's default is 20 s) and move on to another proxy.
- Trade-off: the quick answer shows YouTube's 640 px thumbnail and its own spelling of the channel name; once the full extraction is cached, repeat lookups show yt-dlp's values as before. A video the quick request accepts but yt-dlp then cannot fetch now reports its error at the download click instead of at the lookup.
- `/yt-diag` adds `fastInfo` and the counters `infoFast` / `infoFastMiss`.

## 1.9.0 — instant browser hand-off

- **Downloads register in the browser immediately.** When the browser navigates to a signed `/yt-download` or `/yt-video-download` link, the response headers are now sent as soon as the video is confirmed downloadable (metadata is normally already cached from the lookup) and the job is accepted — not after the whole file has been built. The browser's own download manager takes over at that moment, so the download keeps going if the visitor closes the tab or leaves the site. The bytes follow when the file is ready.
- Trade-offs: the size is not known that early, so these responses have no `Content-Length` (the browser shows bytes received, no percentage); and a failure after the headers cuts the connection so the browser shows a failed download instead of saving an empty file.
- Only real browser navigations get this (`Sec-Fetch-Mode: navigate`, or an HTML `Accept` header on older browsers). `fetch()`/XHR clients keep the previous behaviour exactly (`Content-Length`, JSON errors). `YT_EARLY_HEADERS=0` switches it off.
- Errors that happen before the headers are shown to a navigating browser as a small readable page with a "Go back" button instead of raw JSON. API clients still get the same JSON.
- `X-Accel-Buffering: no` is sent with the early headers so nginx passes them on at once.

## 1.8.0 — reliability + second speed pass

Only `youtube.js` has code changes. No route, parameter, signature or CORS change; success responses keep their shape. The WordPress plugins need no update.

### Fixed
- **720p / 1080p requests were delivered as 360p.** The quality selector tried "one ready-made MP4" first, and YouTube only offers that at 360p now. It now takes the best video at or below the requested height plus the best audio, preferring H.264 + AAC so the MP4 plays everywhere. Above 1080p YouTube has no H.264, so those tiers are VP9/AV1 inside the MP4. Real-resolution files are larger and take longer than the 360p ones that were being sent before.
- **Live streams and unfinished premieres** are refused up front with a clear `category: "live"` error (lookup: HTTP 400; download: yt-dlp `--match-filter`), instead of recording until the 15-minute job timeout.
- **Cut-off files.** Downloads now pass `--abort-on-unavailable-fragments`, so a missing fragment fails the job instead of silently producing a truncated file.
- **Stranded YouTube temp files.** The existing sweeper only knew the SoundCloud prefixes; `ytgrab-*` / `ytgrabv-*` leftovers from crashes or restarts are now removed once they are older than twice the job timeout (min. 1 h).
- **Unread yt-dlp stdout** in both download routes is now drained.
- The 1.7.0 cache keyed on the full URL, so `youtu.be/ID`, `watch?v=ID`, `/shorts/ID` and the audio/video tools each paid their own extraction. One per-video cache now serves all of them.
- Docs/scripts restarted a PM2 app called `trackgrab-backend`; the app in `ecosystem.config.cjs` is `trackgrab`.

### Reliability
- **One extra attempt on retryable failures** (network blip, HTTP 403 on the media request, extractor hiccup) for lookups, searches and downloads — with a fresh proxy, a fresh extraction and fallback client settings: `YTDLP_FALLBACK_EXTRACTOR_ARGS` if set, otherwise yt-dlp's own default clients when `YTDLP_EXTRACTOR_ARGS` is not configured. Deterministic failures (private, removed, region, age-gate) are not retried.
- **Clearer errors.** New categories next to the existing ones: `live`, `too-long`, `drm`, `blocked` (YouTube refused the media request), `network`, `busy`. Same JSON fields as before (`error`/`category`/`message`/`hint`/`detail`).
- **yt-dlp freshness.** Version and age are checked at start and every 12 h, a warning is logged when it is older than `YTDLP_STALE_DAYS` (45), and `/yt-diag` reports it. `YTDLP_AUTO_UPDATE=1` also runs `yt-dlp -U` on that schedule (standalone yt-dlp file only; pip installs use `update-ytdlp.sh`).
- **Lookup load guard.** At most `YT_INFO_MAX_CONCURRENT` (6) metadata/search yt-dlp processes run at once; up to `YT_INFO_MAX_WAITING` (60) wait, beyond that the answer is a clean "server busy".
- **Optional length cap.** `YT_MAX_DURATION_S` (0 = off) rejects over-length videos with `category: "too-long"`.
- **Request log.** Each download request ends with one JSON line (`evt`, video id, format/quality, status, bytes, ms) for `pm2 logs`.

### Speed
- **Downloads skip the second extraction.** The metadata from the info lookup is kept on disk (`<tmp>/ytgrab-infocache`, wiped at start, max `YT_INFO_CACHE_MAX` = 200 videos) and handed back to yt-dlp with `--load-info-json`, through the same proxy the lookup used. If it is rejected the job re-runs the normal way automatically.
- Simultaneous lookups of one video collapse into a single yt-dlp run. Playlists are cached for `YT_PLAYLIST_CACHE_S` (300 s).
- **Search**: cached (`YT_SEARCH_CACHE_S`, 600 s); an uncached search is one direct HTTPS request to YouTube's search endpoint, falling back to yt-dlp `ytsearch` on any failure. `YT_FAST_SEARCH=0` forces yt-dlp. The direct request does not use the proxy pool.
- **Suggestions**: cached (`YT_SUGGEST_CACHE_S`, 3600 s), kept-alive upstream connection, upstream wait capped at 2.5 s.
- **M4A/MP4 audio** at bitrate 128 or unspecified uses YouTube's native AAC stream — no re-encode.
- Finished files are streamed in 1 MB reads. `YT_INFO_CACHE_TTL_S` still works (`YT_INFO_CACHE_S` is an alias that wins if both are set).

## 1.7.0

Performance & accuracy pass for the YouTube routes (speed + reliability; no API or response-shape changes):

- **In-memory info cache.** `/yt-info` and `/yt-video-info` now cache the computed response, keyed by the normalized URL, so repeat lookups (and everyone pasting the same trending link) skip the slow `yt-dlp -J` extraction and return instantly. TTL via `YT_INFO_CACHE_TTL_S` (default 1800s; `0` disables). LRU-bounded to 500 entries.
- **aria2c external downloader (auto-detected).** When `aria2c` is on PATH, both download routes use it (`-x16 -s16 -k1M`) for typically 3–10× faster transfers; falls back to yt-dlp's native downloader when absent. Force with `YTDLP_ARIA2=1` / disable with `YTDLP_ARIA2=0`; tune with `YTDLP_ARIA2_ARGS`. Both routes build to a temp file, so aria2c is safe for audio and video.
- **Faster default extractor client.** When `YTDLP_EXTRACTOR_ARGS` is not set, the router now defaults to `youtube:player_client=default,android,web_safari`. The `web` client has to run YouTube's player JS (slow, and its stream URLs are frequently throttled); keeping `default` first preserves every format while android/web_safari add faster, un-throttled paths. A configured `YTDLP_EXTRACTOR_ARGS` (e.g. a PO-token provider) still wins.
- **Higher default parallelism.** `YTDLP_FRAGMENTS` default 4 → 8, and `YT_MAX_CONCURRENT` now defaults to the CPU-core count (2–4) instead of a flat 2. Both remain overridable via env.
- **`/yt-diag`** now also reports `extractorArgs`, `aria2c`, `fragments`, and `infoCache` so the active tuning is visible at a glance.

## 1.6.2

- `/yt-video-info` now returns an estimated download `size` (bytes) for each quality tier — the best video stream at that tier plus the best audio — so the WordPress video tool can show total size and a real percentage during a streamed download.

## 1.6.1

- `/yt-video-download` now STREAMS the MP4 straight to the client as yt-dlp produces it (`-o -`, fragmented MP4 via `-movflags +frag_keyframe+empty_moov+default_base_moof`) instead of building the whole file first and then serving it. This fixes the "code null, no output" failures caused by the connection being killed while the server was still building a large file, and lets the browser show a live progress bar. The format selector now prefers a single progressive MP4 (streams instantly) and falls back to a merged H.264/AAC MP4, then anything that fits the requested height. Intermediate fragments go to a per-request temp dir that is removed when the request ends; the job is killed the moment the client disconnects.

## 1.6.0

- Added video downloads to the YouTube router: `GET /yt-video-info` lists a single video's available qualities (144p–2160p, snapped to real streams), and `GET /yt-video-download` streams a muxed MP4 at the signed quality (`bv*[height<=H]+ba`, merged with ffmpeg). Signed with its own scheme: `url\nquality\ntitle\nexp\npriority`. Powers the new SCloud YouTube Video Downloader plugin. Audio routes are unchanged.

## 1.5.0

- Removed the audio-converter feature: the `/probe` and `/convert*` routes and `convert.js` are gone, and the `/` and `/diag` health payloads no longer report a `converter` block. The backend now serves only the SoundCloud (`/info`, `/download`) and YouTube (`/yt-info`, `/yt-download`, `/yt-diag`) download routes.
- CORS origins now come from `CORS_ALLOWED_ORIGINS` (the old `CONVERT_ALLOWED_ORIGINS` is still read as a fallback). Dropped the converter-only env (`CONVERT_MAX_MB`, `CONVERT_CONCURRENCY`, `CONVERT_TIMEOUT_S`, `CONVERT_SOURCE_TIMEOUT_S`, `CONVERT_SECRET`).
- `npm run monitor` no longer probes `/convert-health`.

## 1.4.3

- Cloud imports (`/convert-source`, Drive/Dropbox/OneDrive/URL): fixed the real cause of "The source could not be downloaded" — the SSRF-safe downloader resolved the source host itself and pinned the address with `dns.lookup(..., { verbatim: true })`, which returned an IPv6 record first. A VPS without working IPv6 egress then threw `ERR_INVALID_IP_ADDRESS`, so the request never reached the provider. The resolver now prefers a valid IPv4 address (filtering malformed records, coercing the family), falling back to IPv6 only when no A record exists. SSRF protection is unchanged.
- Drive downloads: the OAuth bearer is now forwarded across `alt=media` redirects to Google-owned hosts only (`drive.usercontent.google.com`, `*.googleusercontent.com`), which is where the byte stream is actually served. Added per-hop `[convert-source]` logging (host → status / redirect target / content-type; tokens never logged).

## 1.4.2

- Google Drive source imports (`/convert-source`): the Drive `alt=media` download now sends `acknowledgeAbuse=true` (and `supportsAllDrives=true`). Without it Google refuses to serve any file its own scanner has flagged — extremely common for music tracks that were themselves downloaded from the web — which surfaced in the converter as "The source could not be downloaded. Please choose it again." Picked audio now downloads and converts. (Same fix already shipped to the SoundCloud-only backend 1.3.2.)
- `/convert-source` now logs the provider's real HTTP status and error reason (e.g. `cannotDownloadAbusiveFile`, `insufficientFilePermissions`) on a failed source fetch, so cloud-import problems are diagnosable from the VPS log. OAuth tokens are never logged.

## 1.4.1

- Mounted the bundled YouTube router so `/yt-info`, `/yt-download`, and `/yt-diag` are available on Render.
- Added YouTube queue state to the root and `/diag` health responses.
- Render builds now fail clearly if yt-dlp or FFmpeg cannot be installed instead of deploying with missing runtime tools.
- The Render Blueprint now requires an environment-only `SCLOUD_API_SECRET` value.

## 1.4.0

- Converter usage refunds: when a CHARGED direct/source conversion (`/convert-direct`, `/convert-source`) fails on this box — bad/corrupt file, over-size/over-length, unreadable, source-download failure, ffmpeg error, timeout, wrong-output — the error response now carries a signed `refund` proof (`HMAC(refund|ticket|exp)`), which WordPress verifies to give the user's daily-quota unit (and bandwidth) back. `busy` (503, retried) and `ticket_used` (409, double-submit) deliberately do NOT refund. A browser cannot forge a refund for a conversion that actually succeeded.
- Automatic VPS temp-file cleanup: a periodic sweeper removes orphaned `trackgrab-*` / `scloud*` temp files and directories in the system temp dir once they are older than `TEMP_MAX_AGE_MIN` (default 60), guarding against disk fill from crashes, SIGKILLs, per-job timeouts or aborted uploads. Runs every `TEMP_SWEEP_INTERVAL_MIN` (default 15) and never touches a file still being written or the yt-dlp cache. Each job still cleans up after itself as before.
- Multer uploads now use a `scloudup_` temp-file prefix so the sweeper can reclaim orphaned uploads.

## 1.3.0

- Downloads (`/download`): lossy formats (MP3, M4A/MP4) are now always encoded at a real constant bitrate (default 320 kbps; MP3 uses true CBR via matching `-b:a/-minrate/-maxrate`). SoundCloud only serves a ~128 kbps source, but the delivered file now advertises the target bitrate in its metadata, so a bitrate checker / file-properties dialog shows 320 kbps — stopping "low bitrate" refund disputes. WAV/FLAC are unchanged (lossless).
- Converter (`/convert`, `/convert-direct`, `/convert-source`): M4A output now honours the selected quality (up to 320 kbps) instead of a fixed 128; MP3 is encoded true-CBR so the file reports the exact chosen bitrate.
- Converter: added a hard cap on the GENERATED output file (`CONVERT_OUTPUT_MAX_MB`, default 500). An over-large result (e.g. a huge WAV blown up from a small lossy input) is rejected with `output_too_large` and deleted instead of streamed. Input cap (`CONVERT_MAX_MB`) is unchanged and independent.
- `/convert-health`, `/diag` and `/` now report `maxInputMb` and `maxOutputMb`.

## 1.2.0

- Added signed `/convert-source` imports for direct audio URLs, Google Drive, Dropbox and OneDrive.
- Added streaming input-size enforcement, duration probing, redirect limits and SSRF protection for every remote hop.
- OAuth tokens are accepted only for the current conversion and are never persisted or logged.
- Added optional `CONVERT_ALLOWED_ORIGINS` CORS restriction and source-import health status.

## 1.1.3

- Converter (`/convert`, `/convert-direct`, `/probe`): `CONVERT_SECRET` now falls back to the same shared default the WordPress converter uses, so an unset/lost secret can't make every conversion fail with "session expired"; and the ticket/probe/convert signature checks now allow a clock-skew grace window (`CONVERT_SIG_LEEWAY_S`, default 600s). `CONVERT_OPEN=1` restores the old open behavior.

## 1.1.2

- Download-link check now allows a clock-skew grace window (SIG_LEEWAY_S, default 600s) between the WordPress box that stamps `exp` and this box that checks it, so a slightly fast/slow VPS clock no longer makes fresh links look "expired".
- API_SECRET now falls back to the same shared default the WordPress plugin ships with (instead of empty/open), so a redeploy or PM2 restart that loses the env var can no longer cause a secret mismatch that rejects every download. Set your own secret on both sides for real security; `SCLOUD_API_OPEN=1` restores the old open behavior.
- Rejected `/download` links now log the real reason (badsig / expired / missing) and return a `code: "bad_link"` so the browser can silently retry with a fresh link. The user-facing message is unchanged.

## 1.1.1

- Download signatures now cover every plan-controlled field, including priority queue access.
- Legacy signed links remain usable during a rolling deployment, but cannot enable priority mode.
- Direct converter tickets are random, short-lived, signed, and accepted only once.
- Busy direct-conversion requests do not consume the one-time ticket, so normal retry behavior remains reliable.
