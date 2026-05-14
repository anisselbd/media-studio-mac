# Media Studio

Suite multi-outils audio & vidéo pour macOS, construite avec Tauri v2.

10 outils, tout en local, sans réseau (sauf le téléchargeur).

## Outils

**Audio**
- **Extraire l'audio** — MP3 / AAC / WAV avec trim, normalisation EBU R128, fondus, pochette, tags ID3, batch et préréglages

**Vidéo — Format**
- **Convertir** — MP4 ↔ MOV ↔ MKV ↔ WEBM, codec H.264 / H.265 / AV1 / copie
- **Compresser** — H.264 avec bitrate cible explicite, résolution + audio ajustables, préréglages Discord / WhatsApp / Discord Nitro / iPhone / Web HD

**Vidéo — Édition**
- **Découper** — sans ré-encodage (instantané), timeline avec frise de vignettes
- **Fusionner** — concat sans ré-encodage
- **Redimensionner / Pivoter** — rotation pixel-perfect + flip H/V + scale, aperçu CSS live
- **Recadrer** — overlay visuel avec 8 poignées + lecteur custom, ratios préset
- **Vitesse** — slow-mo / fast-forward 0.25× → 4×, pitch audio préservé

**Vidéo — Image**
- **Vers GIF** — palette haute qualité 2-pass, fps + résolution + extrait
- **Extraire image** — capture multiple PNG / JPG à des instants précis

**Web**
- **Télécharger** — yt-dlp en sidecar, YouTube / TikTok / Twitter / Insta…, vidéo (jusqu'à 4K) ou audio extrait

## Setup

```bash
# 1. Cloner le repo
git clone <url> media-studio && cd media-studio

# 2. Télécharger les binaires sidecar (ffmpeg + yt-dlp, ~120 Mo)
./setup.sh

# 3. Installer les deps front
npm install

# 4. Lancer en dev
npm run tauri dev
```

## Build release

```bash
npm run tauri build
# → src-tauri/target/release/bundle/macos/Media Studio.app
```

## Stack

- **Frontend** : Vite + React 18 + TypeScript strict
- **Backend** : Rust (Tauri v2)
- **Media** : ffmpeg 8.1 statique (sidecar), yt-dlp (sidecar)
- **Plugins Tauri** : shell, dialog
- **Cible** : macOS arm64 / x86_64

## Architecture

```
src/
├── App.tsx           # Shell + Extraire audio + History + Presets + Settings
├── VideoViews.tsx    # 9 vues vidéo + DownloadView (yt-dlp)
└── styles.css        # Apple-like design

src-tauri/
├── src/lib.rs        # Toutes les commandes Tauri (ffmpeg, yt-dlp)
└── binaries/         # Sidecars (gitignored)
```

## Licence

Usage personnel. ffmpeg et yt-dlp ont leurs propres licences (LGPL/Unlicense respectivement).
