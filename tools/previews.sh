#!/usr/bin/env bash
# re-record the five link-preview loops and upload them.
# needs: node + playwright + @fontsource/jetbrains-mono (npm install), ffmpeg,
# and UPLOAD_TOKEN (short-lived, written to kv "uploadtoken") or STATUS_TOKEN in env.
set -euo pipefail
cd "$(dirname "$0")"
TOKEN="${UPLOAD_TOKEN:-${STATUS_TOKEN:-}}"
: "${TOKEN:?set UPLOAD_TOKEN or STATUS_TOKEN}"
echo '{"game":{"game":null},"status":{"kind":null},"push":null,"wx":{"current":{"weather_code":0}}}' > api.json
for p in rise noon set dusk night; do
  curl -fsS "https://heyalex.dev/og-card?p=$p" -o "card-$p.html"
  rm -rf "frames-$p"; node record-preview.js "$p" "frames-$p" 6 15
  ffmpeg -y -loglevel error -framerate 15 -i "frames-$p/f%04d.png" -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -movflags +faststart "og-$p.mp4"
  ffmpeg -y -loglevel error -i "frames-$p/f0045.png" -q:v 3 "og-$p.jpg"
  for f in "og-$p.mp4" "og-$p.jpg"; do
    curl -fsS -X PUT "https://heyalex.dev/api/asset/$f" -H "authorization: Bearer $TOKEN" --data-binary "@$f"; echo
  done
done
rm -rf frames-* card-*.html api.json
