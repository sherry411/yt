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
