#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$ROOT_DIR/sdk/chrome-recorder"
OUT_DIR="$ROOT_DIR/Testpilot-Frontend/public/downloads"
OUT_ZIP="$OUT_DIR/testpilot-web-recorder.zip"

mkdir -p "$OUT_DIR"
rm -f "$OUT_ZIP"

(cd "$EXT_DIR" && zip -r "$OUT_ZIP" manifest.json background.js popup.html popup.js README.md content/ icons/)
echo "Packaged: $OUT_ZIP"
