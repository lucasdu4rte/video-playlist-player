#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/build-dmg.sh <version>
# Expects: build/export/VideoPlaylistPlayer.app to exist

VERSION="${1:?version required, e.g. 0.1.2}"
APP_NAME="VideoPlaylistPlayer"
APP_PATH="build/export/${APP_NAME}.app"
DMG_PATH="${APP_NAME}-${VERSION}.dmg"
VOL_NAME="${APP_NAME} ${VERSION}"

if [[ ! -d "$APP_PATH" ]]; then
  echo "error: ${APP_PATH} not found. Run the archive+export step first." >&2
  exit 1
fi

if ! command -v create-dmg >/dev/null 2>&1; then
  echo "installing create-dmg via brew..."
  brew install create-dmg
fi

BG_DIR="assets/dmg"
BG_ARG=()
if [[ -f "${BG_DIR}/background.png" && -f "${BG_DIR}/background@2x.png" ]]; then
  BG_TIFF="build/dmg-background.tiff"
  mkdir -p build
  tiffutil -cathidpicheck "${BG_DIR}/background.png" "${BG_DIR}/background@2x.png" -out "$BG_TIFF"
  BG_ARG=(--background "$BG_TIFF")
elif [[ -f "${BG_DIR}/background.png" ]]; then
  BG_ARG=(--background "${BG_DIR}/background.png")
fi

rm -f "$DMG_PATH"

create-dmg \
  --volname "$VOL_NAME" \
  --window-pos 200 120 \
  --window-size 600 400 \
  --icon-size 128 \
  --icon "${APP_NAME}.app" 150 200 \
  --hide-extension "${APP_NAME}.app" \
  --app-drop-link 450 200 \
  --no-internet-enable \
  "${BG_ARG[@]}" \
  "$DMG_PATH" \
  "$APP_PATH"

echo "built: $DMG_PATH"
