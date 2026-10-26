#!/usr/bin/env bash
#
# build.sh — deploy build step for trackgrab-backend (referenced by render.yaml).
#
# render.yaml runs `bash build.sh` but the file was missing from the repo, so the
# deploy had no defined way to install yt-dlp/ffmpeg. This installs both into
# ./bin and installs npm deps.
#
# Why it matters for "correct format": a stale yt-dlp is the #1 cause of
# SoundCloud downloads breaking or returning the wrong/empty stream, because
# SoundCloud changes its internal API often. We always pull the latest yt-dlp.
#
# NOTE: this is the Render/container path. A VPS running the app under PM2 with
# system-wide yt-dlp/ffmpeg (as the plugin readme describes) does not use this
# script — there, just keep yt-dlp updated:  yt-dlp -U   (or: pip install -U yt-dlp)
#
set -euo pipefail

BIN_DIR="$(pwd)/bin"
mkdir -p "$BIN_DIR"

echo "==> Installing latest yt-dlp"
curl -fL --retry 3 -o "$BIN_DIR/yt-dlp" \
  https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
chmod +x "$BIN_DIR/yt-dlp"
"$BIN_DIR/yt-dlp" --version

echo "==> Installing static ffmpeg + ffprobe"
TMP_FF="$(mktemp -d)"
curl -fL --retry 3 -o "$TMP_FF/ffmpeg.tar.xz" \
  https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar -xf "$TMP_FF/ffmpeg.tar.xz" -C "$TMP_FF"
FF_DIR="$(find "$TMP_FF" -maxdepth 1 -type d -name 'ffmpeg-*-static' | head -n1)"
if [ -z "$FF_DIR" ]; then
  echo "Could not locate the extracted ffmpeg build." >&2
  exit 1
fi
cp "$FF_DIR/ffmpeg" "$FF_DIR/ffprobe" "$BIN_DIR/"
chmod +x "$BIN_DIR/ffmpeg" "$BIN_DIR/ffprobe"
"$BIN_DIR/ffmpeg" -version | head -n1
rm -rf "$TMP_FF"

echo "==> Installing locked npm dependencies"
npm ci --omit=dev

echo "==> Build complete. Tools installed in: $BIN_DIR"
ls -la "$BIN_DIR" || true
