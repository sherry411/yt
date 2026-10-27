#!/usr/bin/env bash
#
# update-ytdlp.sh — keep yt-dlp current (the #1 accuracy fix) and reload the app.
#
# A stale yt-dlp is the most common cause of broken / empty / wrong-format
# extractions, because YouTube changes often. Run this by hand after a breakage,
# or from cron nightly, e.g.:
#
#   17 3 * * *  /path/to/update-ytdlp.sh >> /var/log/ytdlp-update.log 2>&1
#
set -uo pipefail

echo "==> $(date -Is) updating yt-dlp"

# Update whichever install is in use: a ./bin/yt-dlp (build.sh / Render path),
# a pip install, or a system yt-dlp that supports self-update.
if [ -x "$(pwd)/bin/yt-dlp" ]; then
  curl -fL --retry 3 -o "$(pwd)/bin/yt-dlp" \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    && chmod +x "$(pwd)/bin/yt-dlp"
  "$(pwd)/bin/yt-dlp" --version
elif command -v pip >/dev/null 2>&1 && pip show yt-dlp >/dev/null 2>&1; then
  pip install -U yt-dlp && yt-dlp --version
elif command -v yt-dlp >/dev/null 2>&1; then
  yt-dlp -U || { command -v pip >/dev/null 2>&1 && pip install -U yt-dlp; }
  yt-dlp --version
else
  echo "yt-dlp not found — install it first." >&2
  exit 1
fi

# Reload the app so the new binary is picked up (PM2 if present; harmless if not).
if command -v pm2 >/dev/null 2>&1; then
  echo "==> reloading PM2 app(s)"
  pm2 restart trackgrab-backend 2>/dev/null || pm2 restart all 2>/dev/null || true
fi

echo "==> done"
