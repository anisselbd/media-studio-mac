#!/usr/bin/env bash
# Setup script — Media Studio
#
# Télécharge les binaires sidecar (ffmpeg, yt-dlp) nécessaires à
# Tauri. Ces binaires sont volontairement hors du dépôt git car trop
# lourds (~120 Mo combinés).
#
# Usage : ./setup.sh

set -euo pipefail

BINARIES_DIR="src-tauri/binaries"
mkdir -p "$BINARIES_DIR"

# Détection de la cible Rust active. Sur Apple Silicon = aarch64,
# sur Intel = x86_64.
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) TARGET="aarch64-apple-darwin" ;;
  x86_64)        TARGET="x86_64-apple-darwin" ;;
  *) echo "Architecture non supportée : $ARCH" >&2; exit 1 ;;
esac

FFMPEG_PATH="$BINARIES_DIR/ffmpeg-$TARGET"
YTDLP_PATH="$BINARIES_DIR/yt-dlp-$TARGET"

# === ffmpeg ===
if [ ! -x "$FFMPEG_PATH" ]; then
  echo "→ Téléchargement de ffmpeg…"
  # Build arm64 statique fourni par osxexperts (signé ad-hoc).
  curl -L --fail --silent --show-error \
    -o /tmp/ffmpeg-static.zip \
    "https://www.osxexperts.net/ffmpeg81arm.zip"
  unzip -q -o /tmp/ffmpeg-static.zip -d /tmp/ffmpeg-static
  mv /tmp/ffmpeg-static/ffmpeg "$FFMPEG_PATH"
  chmod +x "$FFMPEG_PATH"
  rm -rf /tmp/ffmpeg-static /tmp/ffmpeg-static.zip
  echo "  ✓ $($FFMPEG_PATH -version | head -1)"
else
  echo "→ ffmpeg déjà présent : $($FFMPEG_PATH -version | head -1)"
fi

# === yt-dlp ===
if [ ! -x "$YTDLP_PATH" ]; then
  echo "→ Téléchargement de yt-dlp…"
  curl -L --fail --silent --show-error \
    -o "$YTDLP_PATH" \
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
  chmod +x "$YTDLP_PATH"
  echo "  ✓ yt-dlp $($YTDLP_PATH --version)"
else
  echo "→ yt-dlp déjà présent : $($YTDLP_PATH --version)"
fi

echo
echo "✓ Binaires prêts dans $BINARIES_DIR/"
echo "  Lance maintenant : npm install && npm run tauri dev"
