#!/bin/sh
# Regenerates the app icon's PNG and ICNS, and the UI's PNG favicon, from their SVGs. macOS only (iconutil).
# Run from anywhere: packages/desktop/scripts/build-icons.sh. Set CHROME if Google Chrome isn't in /Applications.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
assets="$here/../assets"
public="$here/../../ui/public"
tmp=$(mktemp -d)
iconset="$tmp/icon.iconset"
mkdir "$iconset"

set -- "$assets/icon.svg:$assets/icon.png:1024" "$public/favicon.svg:$public/favicon.png:64"
for size in 16 32 128 256 512; do
  set -- "$@" "$assets/icon.svg:$iconset/icon_${size}x${size}.png:$size"
  set -- "$@" "$assets/icon.svg:$iconset/icon_${size}x${size}@2x.png:$((size * 2))"
done
node "$here/render-svg.mjs" "$@"
iconutil -c icns -o "$assets/icon.icns" "$iconset"
rm -rf "$tmp"
echo "Wrote icon.png and icon.icns in $assets, and favicon.png in $public"
