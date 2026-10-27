# SCloud VPS deployment and recovery

## What this build fixes

- Downloader jobs are limited to two active jobs plus a bounded queue, preventing simultaneous FFmpeg processes from overwhelming a small VPS.
- Every job has a hard timeout, aborted clients stop their child process, error logs are capped, and PM2 restarts the service after a crash or memory spike.
- The server probes completed output and refuses to send a file when its real container/codec does not match the requested MP3, MP4/M4A, WAV or FLAC format.
- M4A extraction uses 128 kbps AAC instead of inheriting the MP3 selector's 192 kbps default.
- `/diag` and `npm run monitor` expose the signals needed to distinguish a WordPress/Cloudflare outage from a VPS/FFmpeg outage.

## Current live abnormality found on 27 August 2026

`https://downloadscloudmp3.com/` and `/youtube-downloader/` return `308 Permanent Redirect` with a `Location` header pointing to the exact same URL. Browsers stop with `ERR_TOO_MANY_REDIRECTS`. At the same time, `https://api.downloadscloudmp3.com/diag` reports both yt-dlp and FFmpeg working.

This failure is in the Cloudflare/WordPress-origin redirect layer, not in the Node API ZIP. In Cloudflare and the WordPress origin:

1. Open **Rules → Redirect Rules**, **Bulk Redirects**, and legacy **Page Rules**. Disable any rule that matches an already-HTTPS `downloadscloudmp3.com/*` request and redirects it to the same HTTPS URL.
2. Open **SSL/TLS → Overview** and use **Full (strict)** if the WordPress origin has a valid certificate. Do not use Flexible when the origin redirects HTTP to HTTPS.
3. Keep only one HTTP-to-HTTPS redirect layer. A valid rule must match `http://...`, not an already-HTTPS request.
4. Verify the WordPress **Site Address**, **WordPress Address**, web-server redirects, and any SSL/redirect plugin do not redirect an HTTPS request to the identical URL. When a reverse proxy terminates TLS, make sure WordPress recognizes the forwarded HTTPS scheme.
5. Purge Cloudflare cache, then run `npm run monitor`. The site check must show HTTP 200 instead of `self-redirect 308`.

## Deploy backend on the VPS

Keep the existing secret values; do not put secrets in this file or commit them.

```bash
cd /path/to/trackgrab-backend
npm ci --omit=dev
export SCLOUD_API_SECRET='existing-downloader-secret'
export CORS_ALLOWED_ORIGINS='https://downloadscloudmp3.com'
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
curl -fsS https://api.downloadscloudmp3.com/diag
curl -fsS https://api.downloadscloudmp3.com/yt-diag
```

If yt-dlp was installed with its standalone binary, update it before restarting:

```bash
yt-dlp -U
pm2 restart trackgrab --update-env
```

For nginx, keep request buffering enabled, allow the intended upload size, and give conversions time to finish:

```nginx
client_max_body_size 500m;
proxy_connect_timeout 30s;
proxy_send_timeout 900s;
proxy_read_timeout 900s;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

After editing nginx, validate before reload:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## Deploy the WordPress downloader

Upload the latest `scloudyoutubedownloader-*.zip`, replace/upgrade the existing plugin, and confirm these settings match the VPS:

- Backend API base URL: `https://api.downloadscloudmp3.com`
- Shared API secret: the exact `SCLOUD_API_SECRET` value

`CORS_ALLOWED_ORIGINS` accepts a comma-separated list of exact WordPress origins.

## Monitor after deployment

Run:

```bash
npm run monitor
```

It exits non-zero if the website loops/returns an error, the API is down, or yt-dlp or FFmpeg fails. Run this from an external uptime host where possible, because a check running only on the VPS cannot alert when the entire VPS is unreachable.

## Expected file-size behavior

- M4A is now 128 kbps AAC. A roughly 3 minute 20 second track should usually be near 3.1–3.4 MB, plus small container overhead.
- WAV is uncompressed PCM, so roughly 34 MB for that duration is normal.
- Extracting FLAC from a lossy YouTube stream does not restore lost quality and often creates a very large FLAC (around the reported 32 MB) because lossy artifacts compress poorly. This is expected codec behavior, not a wrong-format result.

## Performance & accuracy tuning (1.7.0)

The YouTube routes ship fast, sensible defaults; the items below squeeze out the rest. Check what's active any time with `GET /yt-diag`.

### 1. Install aria2c (biggest download-speed win)

aria2c parallelises each stream (3–10× faster transfers). It's **auto-detected** — once it's on PATH the backend uses it automatically; no config needed.

```bash
sudo apt-get update && sudo apt-get install -y aria2
```

- Force on/off: `YTDLP_ARIA2=1` / `YTDLP_ARIA2=0`
- Tune connections: `YTDLP_ARIA2_ARGS="-x16 -s16 -k1M"` (default)

### 2. Keep yt-dlp fresh (biggest accuracy win)

A stale yt-dlp is the #1 cause of broken/empty/wrong extractions — YouTube changes often. Update it on a schedule and restart:

```bash
# one-off
yt-dlp -U        # or: pip install -U yt-dlp

# nightly cron (3:17 AM), then reload under PM2
17 3 * * *  yt-dlp -U >/dev/null 2>&1; pm2 restart trackgrab-backend
```

A ready-made helper is included: `bash update-ytdlp.sh` (updates yt-dlp and reloads PM2 if present).

### 3. Extractor client

Default when `YTDLP_EXTRACTOR_ARGS` is unset: `youtube:player_client=default,android,web_safari` — avoids the throttled `web`-client stream URLs while keeping every format. Set `YTDLP_EXTRACTOR_ARGS` to override (e.g. to point at a PO-token provider); your value then wins.

### 4. Cookies (reliability / fewer bot-checks)

Drop a Netscape-format `cookies.txt` next to the app (it's gitignored) and restart — no config edit needed. Or set `YTDLP_COOKIES=/path/cookies.txt` / `YTDLP_COOKIES_FROM_BROWSER=chrome`. This clears most "Sign in to confirm you're not a bot" failures.

### 5. Throughput knobs (env)

| Env | Default | Purpose |
|-----|---------|---------|
| `YT_INFO_CACHE_TTL_S` | `1800` | How long `/yt-info` + `/yt-video-info` responses are cached (`0` disables). |
| `YTDLP_FRAGMENTS` | `8` | Parallel DASH fragment downloads (native downloader). |
| `YT_MAX_CONCURRENT` | CPU cores (2–4) | Simultaneous download jobs before queueing. |
| `YTDLP_ARIA2` | auto | `1`/`0` to force the aria2c downloader on/off. |

See `.env.example` for the full list.
