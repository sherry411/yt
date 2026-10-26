# Changelog

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
