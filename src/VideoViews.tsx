// Vues des 4 outils vidéo (Vague 1) : Convertir, Compresser, Découper, Fusionner.
//
// Chaque vue est autonome : drag-drop ou picker, encodage via une commande
// Rust dédiée, progression streamée via l'event "video-progress" et routée
// par jobId.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// ===== Types partagés =====

export type VideoView =
  | "convert"
  | "compress"
  | "trim"
  | "merge"
  | "togif"
  | "frame"
  | "transform"
  | "crop"
  | "speed"
  | "download";

type VideoInfo = {
  path: string;
  fileName: string;
  durationSeconds: number | null;
  sizeBytes: number;
};

type ToastFn = (message: string, kind?: "success" | "info" | "error") => void;

// Type des entrées d'historique vidéo. Mirroir de VideoHistoryInput dans
// App.tsx — défini ici aussi pour éviter une dépendance circulaire entre
// les deux fichiers.
type VideoHistoryEntry = {
  kind: "compress" | "convert" | "trim" | "merge";
  sourcePath: string;
  sourceFileName: string;
  outputPath: string;
  outputFileName: string;
  durationSeconds: number;
  videoSummary: string;
  outputSizeBytes: number;
};
type AddHistoryFn = (entry: VideoHistoryEntry) => void;

// ===== Constantes & helpers locaux =====

const VIDEO_EXT = ["mp4", "mov", "mkv", "avi", "webm", "m4v"];

function fileExt(path: string): string {
  return path.toLowerCase().split(".").pop() ?? "";
}
function isVideoFile(path: string): boolean {
  return VIDEO_EXT.includes(fileExt(path));
}
function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}
function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}
// Raccourcit un chemin pour l'affichage (".../dossier/sous-dossier").
function shortenPathLocal(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return ".../" + parts.slice(-2).join("/");
}
function stripExtension(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? name : name.slice(0, i);
}
function newJobId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 Ko";
  const units = ["o", "Ko", "Mo", "Go"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
// Construit le chemin de sortie d'une opération vidéo.
// - `customDir` : si fourni, écrit dans ce dossier au lieu d'à côté de la source
// - `suffix`    : suffixe ajouté au nom (ex: "_compress")
// - `outExt`    : extension du fichier produit
function safeOutputPath(
  inputPath: string,
  suffix: string,
  outExt: string,
  customDir?: string | null,
): string {
  const dir = customDir ?? dirName(inputPath);
  const base = stripExtension(baseName(inputPath));
  const sfx = suffix.length > 0 ? `_${suffix}` : "";
  return `${dir}/${base}${sfx}.${outExt}`;
}

// Hook partagé pour le dossier de sortie des outils vidéo.
// Une seule préférence globale persistée dans localStorage : tous les
// outils vidéo (Convertir/Compresser/Trim/...) la partagent. Si null,
// chaque outil écrit à côté de sa source.
const VIDEO_OUTPUT_DIR_KEY = "videoOutputDir";
function useVideoOutputDir(): [string | null, () => Promise<void>, () => void] {
  const [outputDir, setOutputDir] = useState<string | null>(
    () => localStorage.getItem(VIDEO_OUTPUT_DIR_KEY) || null,
  );
  useEffect(() => {
    if (outputDir) localStorage.setItem(VIDEO_OUTPUT_DIR_KEY, outputDir);
    else localStorage.removeItem(VIDEO_OUTPUT_DIR_KEY);
  }, [outputDir]);
  const pick = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") setOutputDir(dir);
  }, []);
  const reset = useCallback(() => setOutputDir(null), []);
  return [outputDir, pick, reset];
}

// Composant UI réutilisable : ligne affichant le dossier de sortie courant
// avec un bouton "Modifier" et "Réinitialiser".
function OutputDirField({
  value,
  onPick,
  onReset,
  fallback = "À côté de la source",
}: {
  value: string | null;
  onPick: () => void;
  onReset: () => void;
  fallback?: string;
}) {
  return (
    <div className="output-location">
      <span className="output-location__label">Dossier</span>
      <span className="output-location__value" title={value ?? ""}>
        {value ? shortenPathLocal(value) : fallback}
      </span>
      <button className="linkbtn" onClick={onPick}>
        Modifier
      </button>
      {value && (
        <button className="linkbtn linkbtn--muted" onClick={onReset}>
          Réinitialiser
        </button>
      )}
    </div>
  );
}

// ===== Hook commun : drop d'un seul fichier vidéo =====
//
// Reuse de l'event onDragDropEvent global. Pour éviter qu'une vue
// "écoute" pendant qu'elle n'est pas affichée, le hook ne fait rien si
// `enabled` est false. Toutes les vues activent leur hook simultanément
// quand elles sont à l'écran (une seule vue est rendue à la fois).
function useVideoDrop(
  enabled: boolean,
  onSingle: (path: string) => void,
  onMulti?: (paths: string[]) => void,
) {
  const [hovering, setHovering] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const win = getCurrentWebviewWindow();
    const unlistenPromise = win.onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") setHovering(true);
      else if (p.type === "leave") setHovering(false);
      else if (p.type === "drop") {
        setHovering(false);
        const videos = (p.paths ?? []).filter(isVideoFile);
        if (videos.length === 0) return;
        if (videos.length === 1 || !onMulti) onSingle(videos[0]);
        else onMulti(videos);
      }
    });
    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, [enabled, onSingle, onMulti]);
  return hovering;
}

// ===== Hook commun : écoute progression =====
//
// Filtre les events `video-progress` par jobId. Renvoie le pourcentage
// courant du job actif (null si pas de progression encore reçue).
function useVideoProgress(jobId: string | null): number | null {
  const [percent, setPercent] = useState<number | null>(null);
  useEffect(() => {
    setPercent(null);
    if (!jobId) return;
    const unlistenPromise = listen<{ jobId: string; percent: number }>(
      "video-progress",
      (e) => {
        if (e.payload.jobId === jobId) {
          setPercent(e.payload.percent);
        }
      },
    );
    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, [jobId]);
  return percent;
}

// ===== Mini composants UI =====

function ProgressBar({ percent }: { percent: number }) {
  const pct = Math.max(0, Math.min(100, percent));
  return (
    <div
      className="progressbar"
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="progressbar__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`segmented-group ${disabled ? "segmented-group--disabled" : ""}`}>
      <span className="segmented-group__label">{label}</span>
      <div className="segmented">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`segmented__option ${
              value === opt.value ? "segmented__option--active" : ""
            }`}
            onClick={() => onChange(opt.value)}
            disabled={disabled}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function VideoDropZone({
  hovering,
  onPick,
  title,
  hint,
  multiple,
}: {
  hovering: boolean;
  onPick: () => void;
  title: string;
  hint: string;
  multiple?: boolean;
}) {
  return (
    <button
      className={`dropzone ${hovering ? "dropzone--hover" : ""}`}
      onClick={onPick}
      type="button"
    >
      <div className="dropzone__icon" aria-hidden>
        <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 16V4" />
          <path d="m6 10 6-6 6 6" />
          <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
      </div>
      <div className="dropzone__title">{title}</div>
      <div className="dropzone__hint">{hint}</div>
      <div className="dropzone__formats">
        MP4 · MOV · MKV · AVI · WEBM · M4V{multiple ? " · plusieurs autorisés" : ""}
      </div>
    </button>
  );
}

// Petite fiche d'info vidéo (nom, durée, taille). Affichée juste après
// chargement du fichier.
function VideoInfoCard({ info }: { info: VideoInfo }) {
  return (
    <div className="filecard">
      <div className="filecard__icon" aria-hidden>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <path d="m23 7-7 5 7 5V7z" />
        </svg>
      </div>
      <div className="filecard__body">
        <div className="filecard__name">{info.fileName}</div>
        <div className="filecard__meta">
          {info.durationSeconds != null && <>{formatTime(info.durationSeconds)} · </>}
          {formatBytes(info.sizeBytes)}
        </div>
      </div>
    </div>
  );
}

// ===== Picker partagé =====
async function pickVideo(multiple = false): Promise<string[] | null> {
  const selected = await open({
    multiple,
    filters: [{ name: "Vidéo", extensions: VIDEO_EXT }],
  });
  if (Array.isArray(selected)) return selected;
  if (typeof selected === "string") return [selected];
  return null;
}

// ===== Hook : charge un fichier en VideoInfo via Rust =====
function useLoadVideo() {
  return useCallback(async (path: string): Promise<VideoInfo | null> => {
    try {
      const info = await invoke<VideoInfo>("get_video_info", { path });
      return info;
    } catch (e) {
      console.warn("get_video_info:", e);
      return null;
    }
  }, []);
}

// =============================================================
// CONVERTISSEUR VIDÉO
// =============================================================

type ContainerFormat = "mp4" | "mov" | "mkv" | "webm";
type VideoCodec = "h264" | "h265" | "av1" | "copy";
type AudioMode = "aac" | "opus" | "copy";

const CONTAINER_OPTIONS: { value: ContainerFormat; label: string }[] = [
  { value: "mp4", label: "MP4" },
  { value: "mov", label: "MOV" },
  { value: "mkv", label: "MKV" },
  { value: "webm", label: "WEBM" },
];

// Table de compatibilité conteneur ↔ codec.
//
// WEBM n'accepte QUE VP8/VP9/AV1 + Opus/Vorbis — il refuse H.264/H.265/AAC
// (ffmpeg lève `Invalid argument -22` si on lui demande l'impossible).
// MP4/MOV exigent H.264/H.265/AV1 + AAC. MKV accepte tout.
const VIDEO_CODECS_BY_CONTAINER: Record<ContainerFormat, VideoCodec[]> = {
  mp4: ["h264", "h265", "av1", "copy"],
  mov: ["h264", "h265", "av1", "copy"],
  mkv: ["h264", "h265", "av1", "copy"],
  webm: ["av1", "copy"],
};

const AUDIO_MODES_BY_CONTAINER: Record<ContainerFormat, AudioMode[]> = {
  mp4: ["aac", "copy"],
  mov: ["aac", "copy"],
  mkv: ["aac", "copy"],
  webm: ["opus", "copy"],
};

const CODEC_LABELS: Record<VideoCodec, string> = {
  h264: "H.264",
  h265: "H.265",
  av1: "AV1",
  copy: "Copie",
};

const AUDIO_LABELS: Record<AudioMode, string> = {
  aac: "AAC 192 kbps",
  opus: "Opus 128 kbps",
  copy: "Conserver",
};

type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; info: VideoInfo }
  | { kind: "processing"; info: VideoInfo; jobId: string }
  | { kind: "done"; info: VideoInfo; output: string }
  | { kind: "error"; message: string };

export function ConvertView({
  active,
  reveal,
  showToast,
  addHistory,
}: {
  active: boolean;
  reveal: (path: string) => void;
  showToast: ToastFn;
  addHistory: AddHistoryFn;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [container, setContainer] = useState<ContainerFormat>("mp4");
  const [codec, setCodec] = useState<VideoCodec>("h264");
  const [audioMode, setAudioMode] = useState<AudioMode>("aac");
  const loadVideo = useLoadVideo();
  const [outputDir, pickOutputDir, resetOutputDir] = useVideoOutputDir();

  // Options valides pour le conteneur courant.
  const validCodecs = VIDEO_CODECS_BY_CONTAINER[container];
  const validAudio = AUDIO_MODES_BY_CONTAINER[container];

  // Auto-correction : si l'utilisateur change de conteneur et que son codec
  // ou audio actuel n'est plus compatible, on retombe sur la première option
  // valide. Ça évite à ffmpeg de planter sur `Invalid argument`.
  useEffect(() => {
    if (!validCodecs.includes(codec)) setCodec(validCodecs[0]);
    if (!validAudio.includes(audioMode)) setAudioMode(validAudio[0]);
  }, [container, codec, audioMode, validCodecs, validAudio]);

  const currentJobId = phase.kind === "processing" ? phase.jobId : null;
  const percent = useVideoProgress(currentJobId);

  const handleSingle = useCallback(
    async (path: string) => {
      setPhase({ kind: "loading" });
      const info = await loadVideo(path);
      if (!info) {
        setPhase({ kind: "error", message: "Impossible de lire les infos de la vidéo." });
        return;
      }
      setPhase({ kind: "ready", info });
    },
    [loadVideo],
  );

  const hovering = useVideoDrop(active, handleSingle);

  const onPick = async () => {
    const paths = await pickVideo(false);
    if (paths && paths.length > 0) void handleSingle(paths[0]);
  };

  const reset = () => setPhase({ kind: "idle" });

  const convert = async () => {
    if (phase.kind !== "ready") return;
    const info = phase.info;
    const outputPath = safeOutputPath(info.path, codec === "copy" ? "remux" : codec, container, outputDir);
    const jobId = newJobId();
    setPhase({ kind: "processing", info, jobId });
    try {
      const produced = await invoke<string>("convert_video", {
        jobId,
        inputPath: info.path,
        outputPath,
        videoCodec: codec,
        audioMode,
        crf: codec === "copy" ? null : 23,
        preset: codec === "copy" ? null : codec === "av1" ? "8" : "medium",
      });
      // Récupère la taille effective produite pour l'historique.
      const finalInfo = await loadVideo(produced);
      addHistory({
        kind: "convert",
        sourcePath: info.path,
        sourceFileName: info.fileName,
        outputPath: produced,
        outputFileName: baseName(produced),
        durationSeconds: info.durationSeconds ?? 0,
        videoSummary: `${container.toUpperCase()} · ${CODEC_LABELS[codec]} · ${AUDIO_LABELS[audioMode]}`,
        outputSizeBytes: finalInfo?.sizeBytes ?? 0,
      });
      setPhase({ kind: "done", info, output: produced });
      showToast(`Vidéo convertie en ${container.toUpperCase()}`);
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    }
  };

  return (
    <div className="tool-page">
      <header className="page__header">
        <h1>Convertir une vidéo</h1>
      </header>
      <p className="page__intro">
        Change le format ou le codec d'une vidéo. La copie ne ré-encode pas
        (instantané, mais ne change pas le codec).
      </p>

      <section className="stage">
        {phase.kind === "idle" && (
          <VideoDropZone
            hovering={hovering}
            onPick={onPick}
            title="Glisser une vidéo à convertir"
            hint="ou clique pour la choisir"
          />
        )}

        {phase.kind === "loading" && (
          <div className="filecard filecard--loading">
            <div className="filecard__body">
              <div className="filecard__name">Lecture des infos…</div>
            </div>
          </div>
        )}

        {phase.kind === "ready" && (
          <>
            <VideoInfoCard info={phase.info} />
            <div className="options">
              <Segmented
                label="Conteneur"
                options={CONTAINER_OPTIONS}
                value={container}
                onChange={setContainer}
              />
              <Segmented
                label="Codec vidéo"
                options={validCodecs.map((c) => ({ value: c, label: CODEC_LABELS[c] }))}
                value={codec}
                onChange={setCodec}
              />
              <Segmented
                label="Audio"
                options={validAudio.map((a) => ({ value: a, label: AUDIO_LABELS[a] }))}
                value={audioMode}
                onChange={setAudioMode}
              />
              {container === "webm" && (
                <p className="page__empty-hint" style={{ marginTop: "-4px" }}>
                  WEBM impose AV1 + Opus (ou copie si la source est déjà compatible).
                </p>
              )}
              <OutputDirField
                value={outputDir}
                onPick={pickOutputDir}
                onReset={resetOutputDir}
              />
            </div>
          </>
        )}

        {phase.kind === "processing" && (
          <>
            <VideoInfoCard info={phase.info} />
            <div className="extracting-block">
              <div className="filecard__meta">Encodage en cours…</div>
              <ProgressBar percent={percent ?? 0} />
            </div>
          </>
        )}

        {phase.kind === "done" && (
          <>
            <div className="filecard">
              <div className="filecard__icon" aria-hidden>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="filecard__body">
                <div className="filecard__name">{baseName(phase.output)}</div>
                <div className="filecard__meta">Vidéo convertie</div>
              </div>
            </div>
            <video
              src={convertFileSrc(phase.output)}
              controls
              className="editor__video"
              preload="metadata"
            />
          </>
        )}

        {phase.kind === "error" && <div className="errorcard">{phase.message}</div>}
      </section>

      <footer className="footer">
        <div className="actions">
          {phase.kind === "ready" && (
            <>
              <button className="btn btn--ghost" onClick={reset}>Annuler</button>
              <button className="btn" onClick={convert}>
                Convertir en {container.toUpperCase()}
              </button>
            </>
          )}
          {phase.kind === "processing" && (
            <button className="btn" disabled>
              {percent != null ? `${Math.round(percent)} %` : "Encodage…"}
            </button>
          )}
          {phase.kind === "done" && (
            <>
              <button className="btn btn--ghost" onClick={() => reveal(phase.output)}>
                Afficher dans le Finder
              </button>
              <button className="btn" onClick={reset}>Nouvelle vidéo</button>
            </>
          )}
          {phase.kind === "error" && (
            <button className="btn btn--ghost" onClick={reset}>Réessayer</button>
          )}
        </div>
      </footer>
    </div>
  );
}

// =============================================================
// COMPRESSEUR VIDÉO
// =============================================================

const PRESET_OPTIONS: { value: string; label: string }[] = [
  { value: "veryfast", label: "Rapide" },
  { value: "medium", label: "Équilibré" },
  { value: "slow", label: "Qualité" },
];

// Steps de bitrate vidéo en kbps, échelle pseudo-logarithmique.
// 250k = compression extrême pour partage messagerie.
// 8000k = qualité élevée pour archivage.
const BITRATE_STEPS = [250, 400, 600, 800, 1200, 1500, 2000, 3000, 4000, 6000, 8000];

function formatBitrate(kbps: number): string {
  if (kbps >= 1000) {
    const v = kbps / 1000;
    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)} Mbps`;
  }
  return `${kbps} kbps`;
}

// Estimation de la taille après compression H.264.
//
// Maintenant que la compression cible un bitrate vidéo explicite, le
// calcul devient exact à ±10% : on additionne bitrate vidéo et audio
// (audio source approximé à 10% si on copie), multiplié par la durée.
function estimateCompressedSize(
  sourceBytes: number,
  durationSeconds: number,
  videoBitrateK: number,
  audioBitrateK: number | null,
): number {
  const videoBytes = (videoBitrateK * 1000 * durationSeconds) / 8;
  const audioBytes =
    audioBitrateK == null
      ? sourceBytes * 0.1
      : (audioBitrateK * 1000 * durationSeconds) / 8;
  return Math.round(videoBytes + audioBytes);
}

// Résolutions cibles. `null` = on garde la résolution source.
type ScaleOption = "original" | "1080" | "720" | "540" | "480";
const SCALE_HEIGHTS: Record<ScaleOption, number | null> = {
  original: null,
  "1080": 1080,
  "720": 720,
  "540": 540,
  "480": 480,
};
const SCALE_LABELS: { value: ScaleOption; label: string }[] = [
  { value: "original", label: "Source" },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
  { value: "540", label: "540p" },
  { value: "480", label: "480p" },
];

// Bitrates audio AAC. `null` = on copie l'audio source tel quel.
type AudioOption = "copy" | "192" | "128" | "96" | "64";
const AUDIO_BITRATES: Record<AudioOption, number | null> = {
  copy: null,
  "192": 192,
  "128": 128,
  "96": 96,
  "64": 64,
};
const AUDIO_OPTIONS: { value: AudioOption; label: string }[] = [
  { value: "copy", label: "Source" },
  { value: "192", label: "192k" },
  { value: "128", label: "128k" },
  { value: "96", label: "96k" },
  { value: "64", label: "64k" },
];

// Préréglages cibles : paramètres pré-calibrés pour différentes plateformes
// de partage. Discord gratuit plafonne historiquement à 10 Mo par fichier,
// WhatsApp à 16 Mo, etc. Les valeurs ici sont des heuristiques qui marchent
// bien pour des vidéos de quelques minutes ; pour des vidéos très longues,
// l'utilisateur ajustera le bitrate à la main.
type CompressPreset = {
  id: string;
  name: string;
  description: string;
  videoBitrateK: number;
  scale: ScaleOption;
  audio: AudioOption;
};
const COMPRESS_PRESETS: CompressPreset[] = [
  {
    id: "discord",
    name: "Discord",
    description: "≤ 10 Mo (≈4 min)",
    videoBitrateK: 250,
    scale: "480",
    audio: "64",
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    description: "≤ 16 Mo",
    videoBitrateK: 500,
    scale: "480",
    audio: "96",
  },
  {
    id: "discord-nitro",
    name: "Discord Nitro",
    description: "≤ 500 Mo, qualité",
    videoBitrateK: 4000,
    scale: "1080",
    audio: "192",
  },
  {
    id: "iphone",
    name: "iPhone / iMessage",
    description: "1080p H.264",
    videoBitrateK: 3000,
    scale: "1080",
    audio: "128",
  },
  {
    id: "web",
    name: "Web HD",
    description: "Qualité YouTube",
    videoBitrateK: 6000,
    scale: "1080",
    audio: "192",
  },
];

export function CompressView({
  active,
  reveal,
  showToast,
  addHistory,
}: {
  active: boolean;
  reveal: (path: string) => void;
  showToast: ToastFn;
  addHistory: AddHistoryFn;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // Bitrate vidéo cible en kbps. Steps adaptés au use case desktop :
  // 250k ≈ très léger pour partage, 8000k ≈ qualité élevée.
  const [videoBitrateK, setVideoBitrateK] = useState<number>(1500);
  const [preset, setPreset] = useState<string>("medium");
  const [scale, setScale] = useState<ScaleOption>("original");
  const [audio, setAudio] = useState<AudioOption>("128");
  const loadVideo = useLoadVideo();
  const [outputDir, pickOutputDir, resetOutputDir] = useVideoOutputDir();

  // Applique un préréglage cible (Discord / WhatsApp / iPhone / etc.).
  const applyPreset = (p: CompressPreset) => {
    setVideoBitrateK(p.videoBitrateK);
    setScale(p.scale);
    setAudio(p.audio);
    setActivePresetId(p.id);
  };

  // Détection auto du preset actif : un preset est "actif" si tous ses
  // paramètres correspondent à l'état courant. Si l'utilisateur modifie
  // une option à la main, on le désactive.
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  useEffect(() => {
    setActivePresetId((current) => {
      if (!current) return null;
      const p = COMPRESS_PRESETS.find((cp) => cp.id === current);
      if (!p) return null;
      const matches =
        p.videoBitrateK === videoBitrateK &&
        p.scale === scale &&
        p.audio === audio;
      return matches ? current : null;
    });
  }, [videoBitrateK, scale, audio]);

  const currentJobId = phase.kind === "processing" ? phase.jobId : null;
  const percent = useVideoProgress(currentJobId);

  const handleSingle = useCallback(
    async (path: string) => {
      setPhase({ kind: "loading" });
      const info = await loadVideo(path);
      if (!info) {
        setPhase({ kind: "error", message: "Impossible de lire les infos de la vidéo." });
        return;
      }
      setPhase({ kind: "ready", info });
    },
    [loadVideo],
  );

  const hovering = useVideoDrop(active, handleSingle);

  const onPick = async () => {
    const paths = await pickVideo(false);
    if (paths && paths.length > 0) void handleSingle(paths[0]);
  };

  const reset = () => setPhase({ kind: "idle" });

  const compress = async () => {
    if (phase.kind !== "ready") return;
    const info = phase.info;
    const ext = fileExt(info.path) || "mp4";
    const outputPath = safeOutputPath(info.path, "compressed", ext, outputDir);
    const jobId = newJobId();
    setPhase({ kind: "processing", info, jobId });
    try {
      const produced = await invoke<string>("compress_video", {
        jobId,
        inputPath: info.path,
        outputPath,
        videoBitrateK,
        preset,
        scaleHeight: SCALE_HEIGHTS[scale],
        audioBitrateK: AUDIO_BITRATES[audio],
      });
      const finalInfo = await loadVideo(produced);
      const scaleLabel = SCALE_LABELS.find((s) => s.value === scale)?.label ?? "Source";
      const audioLabel = AUDIO_OPTIONS.find((a) => a.value === audio)?.label ?? "Source";
      addHistory({
        kind: "compress",
        sourcePath: info.path,
        sourceFileName: info.fileName,
        outputPath: produced,
        outputFileName: baseName(produced),
        durationSeconds: info.durationSeconds ?? 0,
        videoSummary: `${scaleLabel} · ${formatBitrate(videoBitrateK)} · audio ${audioLabel}`,
        outputSizeBytes: finalInfo?.sizeBytes ?? 0,
      });
      setPhase({ kind: "done", info, output: produced });
      showToast("Vidéo compressée");
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    }
  };

  const estimatedSize = useMemo(
    () =>
      phase.kind === "ready" && phase.info.sizeBytes > 0 && phase.info.durationSeconds
        ? estimateCompressedSize(
            phase.info.sizeBytes,
            phase.info.durationSeconds,
            videoBitrateK,
            AUDIO_BITRATES[audio],
          )
        : null,
    [phase, videoBitrateK, audio],
  );

  const willGrow =
    estimatedSize != null &&
    phase.kind === "ready" &&
    estimatedSize > phase.info.sizeBytes;

  return (
    <div className="tool-page">
      <header className="page__header">
        <h1>Compresser une vidéo</h1>
      </header>
      <p className="page__intro">
        Réduit la taille du fichier en ré-encodant en H.264 avec un CRF
        ajustable. Plus le CRF est élevé, plus la taille baisse — au prix
        de la qualité.
      </p>

      <section className="stage">
        {phase.kind === "idle" && (
          <VideoDropZone
            hovering={hovering}
            onPick={onPick}
            title="Glisser une vidéo à compresser"
            hint="ou clique pour la choisir"
          />
        )}

        {phase.kind === "loading" && (
          <div className="filecard filecard--loading">
            <div className="filecard__body">
              <div className="filecard__name">Lecture des infos…</div>
            </div>
          </div>
        )}

        {phase.kind === "ready" && (
          <>
            <VideoInfoCard info={phase.info} />
            <div className="compress-presets">
              <span className="effects__label">Cible</span>
              <div className="compress-presets__chips">
                {COMPRESS_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`preset-chip ${
                      activePresetId === p.id ? "preset-chip--active" : ""
                    }`}
                    onClick={() => applyPreset(p)}
                    title={p.description}
                  >
                    {p.name}
                  </button>
                ))}
                {activePresetId === null && (
                  <span className="preset-chip preset-chip--custom">Personnalisé</span>
                )}
              </div>
            </div>
            <div className="options">
              <div className="crf-slider">
                <div className="crf-slider__head">
                  <span className="effects__label">
                    Bitrate vidéo ({formatBitrate(videoBitrateK)})
                  </span>
                  <span className="crf-slider__tag">
                    {videoBitrateK <= 400
                      ? "Très léger"
                      : videoBitrateK <= 800
                      ? "Léger"
                      : videoBitrateK <= 1800
                      ? "Moyen"
                      : videoBitrateK <= 4000
                      ? "Bonne qualité"
                      : "Haute qualité"}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={BITRATE_STEPS.length - 1}
                  step={1}
                  value={BITRATE_STEPS.indexOf(videoBitrateK)}
                  onChange={(e) =>
                    setVideoBitrateK(BITRATE_STEPS[parseInt(e.target.value, 10)])
                  }
                  className="crf-slider__input"
                />
                <div className="crf-slider__legend">
                  <span>{formatBitrate(BITRATE_STEPS[0])} — minuscule</span>
                  <span>{formatBitrate(BITRATE_STEPS[BITRATE_STEPS.length - 1])} — top qualité</span>
                </div>
              </div>
              <Segmented
                label="Vitesse"
                options={PRESET_OPTIONS}
                value={preset}
                onChange={setPreset}
              />
              <Segmented
                label="Résolution"
                options={SCALE_LABELS}
                value={scale}
                onChange={setScale}
              />
              <Segmented
                label="Audio"
                options={AUDIO_OPTIONS}
                value={audio}
                onChange={setAudio}
              />
              {estimatedSize != null && (
                <>
                  <div className="size-estimate">
                    <span className="size-estimate__label">Estimation</span>
                    <span className="size-estimate__values">
                      {formatBytes(phase.info.sizeBytes)} → <strong>{formatBytes(estimatedSize)}</strong>
                    </span>
                  </div>
                  {willGrow && (
                    <p className="page__empty-hint" style={{ marginTop: "-8px" }}>
                      Ta vidéo est déjà bien compressée. Pour vraiment réduire la taille,
                      baisse la résolution (540p ou 480p) et choisis un bitrate audio plus bas (96-128k).
                    </p>
                  )}
                </>
              )}
              <OutputDirField
                value={outputDir}
                onPick={pickOutputDir}
                onReset={resetOutputDir}
              />
            </div>
          </>
        )}

        {phase.kind === "processing" && (
          <>
            <VideoInfoCard info={phase.info} />
            <div className="extracting-block">
              <div className="filecard__meta">Compression en cours…</div>
              <ProgressBar percent={percent ?? 0} />
            </div>
          </>
        )}

        {phase.kind === "done" && (
          <>
            <CompareSizes original={phase.info.sizeBytes} outputPath={phase.output} />
            <video
              src={convertFileSrc(phase.output)}
              controls
              className="editor__video"
              preload="metadata"
            />
          </>
        )}

        {phase.kind === "error" && <div className="errorcard">{phase.message}</div>}
      </section>

      <footer className="footer">
        <div className="actions">
          {phase.kind === "ready" && (
            <>
              <button className="btn btn--ghost" onClick={reset}>Annuler</button>
              <button className="btn" onClick={compress}>Compresser</button>
            </>
          )}
          {phase.kind === "processing" && (
            <button className="btn" disabled>
              {percent != null ? `${Math.round(percent)} %` : "Compression…"}
            </button>
          )}
          {phase.kind === "done" && (
            <>
              <button className="btn btn--ghost" onClick={() => reveal(phase.output)}>
                Afficher dans le Finder
              </button>
              <button className="btn" onClick={reset}>Nouvelle vidéo</button>
            </>
          )}
          {phase.kind === "error" && (
            <button className="btn btn--ghost" onClick={reset}>Réessayer</button>
          )}
        </div>
      </footer>
    </div>
  );
}

// Compare la taille originale et la taille du fichier compressé.
// Si la sortie est PLUS GROSSE que la source (vidéo déjà très compressée
// + paramètres trop "doux"), on l'indique avec un message clair et une
// piste d'action.
function CompareSizes({ original, outputPath }: { original: number; outputPath: string }) {
  const [compressed, setCompressed] = useState<number | null>(null);
  useEffect(() => {
    invoke<VideoInfo>("get_video_info", { path: outputPath })
      .then((i) => setCompressed(i.sizeBytes))
      .catch(() => {});
  }, [outputPath]);
  const saved = compressed != null ? original - compressed : null;
  const ratio = compressed != null && original > 0 ? (1 - compressed / original) * 100 : null;
  const grew = compressed != null && compressed >= original;

  return (
    <>
      <div className="filecard">
        <div className="filecard__icon" aria-hidden>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <div className="filecard__body">
          <div className="filecard__name">{baseName(outputPath)}</div>
          <div className="filecard__meta">
            {compressed != null ? (
              <>
                {formatBytes(original)} → {formatBytes(compressed)}
                {saved != null && saved > 0 && (
                  <> · <strong>–{ratio?.toFixed(0)} %</strong> ({formatBytes(saved)} économisés)</>
                )}
                {grew && (
                  <> · <strong>fichier plus gros qu'avant</strong></>
                )}
              </>
            ) : (
              "Calcul de la taille…"
            )}
          </div>
        </div>
      </div>
      {grew && (
        <div className="warningcard">
          <strong>Pas de gain.</strong> Ta vidéo source était déjà très compressée :
          réduire la qualité n'a pas suffi à passer sous son bitrate. Recharge-la
          et essaie le bouton <em>Compression maximale</em> (480p + audio 96k)
          pour forcer une vraie réduction.
        </div>
      )}
    </>
  );
}

// =============================================================
// DÉCOUPE RAPIDE (sans ré-encodage)
// =============================================================

export function TrimView({
  active,
  reveal,
  showToast,
  addHistory,
}: {
  active: boolean;
  reveal: (path: string) => void;
  showToast: ToastFn;
  addHistory: AddHistoryFn;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  // Vignettes générées par ffmpeg pour afficher une frise sous la piste.
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  // Position courante du lecteur, synchronisée via timeupdate. Sert à :
  // - afficher un curseur de lecture sur la timeline
  // - prendre la valeur comme borne de trim ("Début ici" / "Fin ici")
  const [currentTime, setCurrentTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const loadVideo = useLoadVideo();
  const [outputDir, pickOutputDir, resetOutputDir] = useVideoOutputDir();

  const currentJobId = phase.kind === "processing" ? phase.jobId : null;
  const percent = useVideoProgress(currentJobId);

  const handleSingle = useCallback(
    async (path: string) => {
      setPhase({ kind: "loading" });
      setThumbnails([]);
      setCurrentTime(0);
      const info = await loadVideo(path);
      if (!info) {
        setPhase({ kind: "error", message: "Impossible de lire les infos de la vidéo." });
        return;
      }
      const d = info.durationSeconds ?? 0;
      setTrimStart(0);
      setTrimEnd(d);
      setPhase({ kind: "ready", info });
      // Génération des vignettes en arrière-plan. La timeline s'affiche
      // d'abord en mode plat, puis la frise apparaît dès que ffmpeg a
      // fini (généralement 1-3 secondes).
      try {
        const thumbs = await invoke<string[]>("generate_video_thumbnails", {
          inputPath: path,
          count: 10,
        });
        setThumbnails(thumbs);
      } catch (e) {
        console.warn("Thumbnails generation failed:", e);
      }
    },
    [loadVideo],
  );

  // Synchronise currentTime avec le lecteur HTML5. On écoute timeupdate
  // (lecture) ET seeked (déplacement manuel via la barre native).
  useEffect(() => {
    const el = videoRef.current;
    if (!el || phase.kind !== "ready") return;
    const onUpdate = () => setCurrentTime(el.currentTime);
    el.addEventListener("timeupdate", onUpdate);
    el.addEventListener("seeked", onUpdate);
    return () => {
      el.removeEventListener("timeupdate", onUpdate);
      el.removeEventListener("seeked", onUpdate);
    };
  }, [phase.kind]);

  // Cale le lecteur à un timestamp donné (clamp aux bornes vidéo).
  const seekTo = (t: number) => {
    const el = videoRef.current;
    if (!el) return;
    const dur = el.duration || 0;
    el.currentTime = Math.max(0, Math.min(t, dur));
  };

  // Définit le début / la fin à la position courante du lecteur. On
  // refuse les valeurs qui réduiraient la sélection à <0.5s.
  const setStartHere = () => {
    if (currentTime < trimEnd - 0.5) setTrimStart(currentTime);
  };
  const setEndHere = () => {
    if (currentTime > trimStart + 0.5) setTrimEnd(currentTime);
  };

  const hovering = useVideoDrop(active, handleSingle);

  const onPick = async () => {
    const paths = await pickVideo(false);
    if (paths && paths.length > 0) void handleSingle(paths[0]);
  };

  const reset = () => setPhase({ kind: "idle" });

  const run = async () => {
    if (phase.kind !== "ready") return;
    const info = phase.info;
    const ext = fileExt(info.path) || "mp4";
    const outputPath = safeOutputPath(info.path, "trim", ext, outputDir);
    const jobId = newJobId();
    setPhase({ kind: "processing", info, jobId });
    try {
      const produced = await invoke<string>("fast_trim_video", {
        jobId,
        inputPath: info.path,
        outputPath,
        startSeconds: trimStart,
        endSeconds: trimEnd,
      });
      const finalInfo = await loadVideo(produced);
      addHistory({
        kind: "trim",
        sourcePath: info.path,
        sourceFileName: info.fileName,
        outputPath: produced,
        outputFileName: baseName(produced),
        durationSeconds: trimEnd - trimStart,
        videoSummary: `${formatTime(trimStart)} → ${formatTime(trimEnd)} (sans ré-encodage)`,
        outputSizeBytes: finalInfo?.sizeBytes ?? 0,
      });
      setPhase({ kind: "done", info, output: produced });
      showToast("Vidéo découpée");
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    }
  };

  const duration = phase.kind === "ready" ? phase.info.durationSeconds ?? 0 : 0;

  return (
    <div className="tool-page">
      <header className="page__header">
        <h1>Découpe rapide</h1>
      </header>
      <p className="page__intro">
        Coupe une vidéo sans ré-encodage. L'opération est quasi instantanée
        mais le début/fin effectif s'aligne sur la keyframe la plus proche
        (décalage possible de quelques centièmes de seconde).
      </p>

      <section className="stage">
        {phase.kind === "idle" && (
          <VideoDropZone
            hovering={hovering}
            onPick={onPick}
            title="Glisser une vidéo à découper"
            hint="ou clique pour la choisir"
          />
        )}

        {phase.kind === "loading" && (
          <div className="filecard filecard--loading">
            <div className="filecard__body">
              <div className="filecard__name">Lecture des infos…</div>
            </div>
          </div>
        )}

        {phase.kind === "ready" && (
          <>
            <VideoInfoCard info={phase.info} />
            <video
              ref={videoRef}
              src={convertFileSrc(phase.info.path)}
              controls
              className="editor__video"
              preload="metadata"
            />
            <div className="trim-actions">
              <button className="btn btn--ghost" onClick={setStartHere}>
                Début ici ({formatTime(currentTime)})
              </button>
              <button className="btn btn--ghost" onClick={setEndHere}>
                Fin ici ({formatTime(currentTime)})
              </button>
              <div className="trim-actions__hint">
                Lit la vidéo, mets-toi sur l'image et clique
              </div>
            </div>
            <TrimRange
              duration={duration}
              start={trimStart}
              end={trimEnd}
              currentTime={currentTime}
              thumbnails={thumbnails}
              onChange={(s, e) => {
                setTrimStart(s);
                setTrimEnd(e);
              }}
              onSeek={seekTo}
            />
            <OutputDirField
              value={outputDir}
              onPick={pickOutputDir}
              onReset={resetOutputDir}
            />
          </>
        )}

        {phase.kind === "processing" && (
          <>
            <VideoInfoCard info={phase.info} />
            <div className="extracting-block">
              <div className="filecard__meta">Découpe…</div>
              <ProgressBar percent={percent ?? 0} />
            </div>
          </>
        )}

        {phase.kind === "done" && (
          <>
            <div className="filecard">
              <div className="filecard__body">
                <div className="filecard__name">{baseName(phase.output)}</div>
                <div className="filecard__meta">Découpe terminée</div>
              </div>
            </div>
            <video
              src={convertFileSrc(phase.output)}
              controls
              className="editor__video"
              preload="metadata"
            />
          </>
        )}

        {phase.kind === "error" && <div className="errorcard">{phase.message}</div>}
      </section>

      <footer className="footer">
        <div className="actions">
          {phase.kind === "ready" && (
            <>
              <button className="btn btn--ghost" onClick={reset}>Annuler</button>
              <button
                className="btn"
                onClick={run}
                disabled={trimEnd - trimStart < 0.5}
              >
                Découper ({formatTime(trimEnd - trimStart)})
              </button>
            </>
          )}
          {phase.kind === "processing" && (
            <button className="btn" disabled>
              {percent != null ? `${Math.round(percent)} %` : "Découpe…"}
            </button>
          )}
          {phase.kind === "done" && (
            <>
              <button className="btn btn--ghost" onClick={() => reveal(phase.output)}>
                Afficher dans le Finder
              </button>
              <button className="btn" onClick={reset}>Nouvelle vidéo</button>
            </>
          )}
          {phase.kind === "error" && (
            <button className="btn btn--ghost" onClick={reset}>Réessayer</button>
          )}
        </div>
      </footer>
    </div>
  );
}

// Timeline de découpe enrichie : frise de vignettes + curseur de lecture
// synchronisé + clic pour seek + deux poignées draggables.
//
// La piste fait toute la largeur du conteneur parent. Les vignettes sont
// affichées en arrière-plan (flex row, object-fit cover). Au-dessus, des
// éléments absolus gèrent les masques de sélection, les poignées et le
// playhead.
function TrimRange({
  duration,
  start,
  end,
  currentTime,
  thumbnails,
  onChange,
  onSeek,
}: {
  duration: number;
  start: number;
  end: number;
  currentTime: number;
  thumbnails: string[];
  onChange: (start: number, end: number) => void;
  onSeek: (t: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const startPct = duration > 0 ? (start / duration) * 100 : 0;
  const endPct = duration > 0 ? (end / duration) * 100 : 100;
  const playPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  const xToTime = (clientX: number): number => {
    const el = trackRef.current;
    if (!el || duration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return pct * duration;
  };

  const handleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleMove =
    (which: "start" | "end") =>
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.buttons !== 1) return;
      e.stopPropagation();
      const t = xToTime(e.clientX);
      // Pendant le drag d'une poignée, on cale aussi le lecteur sur la
      // nouvelle borne pour avoir un aperçu visuel en temps réel.
      if (which === "start") {
        const ns = Math.max(0, Math.min(t, end - 0.5));
        onChange(ns, end);
        onSeek(ns);
      } else {
        const ne = Math.min(duration, Math.max(t, start + 0.5));
        onChange(start, ne);
        onSeek(ne);
      }
    };

  // Clic sur la piste (en dehors des handles) = seek le lecteur à cet
  // instant. Pratique pour scrubber rapidement sans utiliser la barre
  // native du <video>.
  const handleTrackClick = (e: React.PointerEvent<HTMLDivElement>) => {
    // setPointerCapture pose un capture sur les handles, donc un click
    // dessus n'arrive jamais ici (stopPropagation au-dessus). Sinon on
    // seek.
    const t = xToTime(e.clientX);
    onSeek(t);
  };

  return (
    <div className="trim trim--rich">
      <div
        className="trim__track trim__track--thumbs"
        ref={trackRef}
        onPointerDown={handleTrackClick}
      >
        {thumbnails.length > 0 ? (
          <div className="trim__thumbs" aria-hidden>
            {thumbnails.map((src, i) => (
              <img
                key={i}
                src={convertFileSrc(src)}
                alt=""
                draggable={false}
                className="trim__thumb"
              />
            ))}
          </div>
        ) : (
          <div className="trim__thumbs trim__thumbs--loading" aria-hidden>
            Génération des vignettes…
          </div>
        )}
        <div className="trim__mask trim__mask--left" style={{ width: `${startPct}%` }} />
        <div
          className="trim__mask trim__mask--right"
          style={{ left: `${endPct}%`, width: `${100 - endPct}%` }}
        />
        <div
          className="trim__selection trim__selection--outline"
          style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }}
          aria-hidden
        />
        <div
          className="trim__playhead"
          style={{ left: `${playPct}%` }}
          aria-hidden
        />
        <div
          className="trim__handle trim__handle--large"
          style={{ left: `${startPct}%` }}
          onPointerDown={handleDown}
          onPointerMove={handleMove("start")}
          role="slider"
          aria-label="Début"
        />
        <div
          className="trim__handle trim__handle--large"
          style={{ left: `${endPct}%` }}
          onPointerDown={handleDown}
          onPointerMove={handleMove("end")}
          role="slider"
          aria-label="Fin"
        />
      </div>
      <div className="trim__labels">
        <span>{formatTime(start)}</span>
        <span className="trim__labels__duration">
          Sélection&nbsp;: {formatTime(end - start)}
        </span>
        <span>{formatTime(end)}</span>
      </div>
    </div>
  );
}

// =============================================================
// FUSION DE VIDÉOS
// =============================================================

type MergeItem = {
  id: string;
  path: string;
  fileName: string;
  durationSeconds: number | null;
  sizeBytes: number;
};

type MergePhase =
  | { kind: "idle" }
  | { kind: "ready"; items: MergeItem[] }
  | { kind: "processing"; items: MergeItem[]; jobId: string }
  | { kind: "done"; output: string }
  | { kind: "error"; message: string; items?: MergeItem[] };

export function MergeView({
  active,
  reveal,
  showToast,
  addHistory,
}: {
  active: boolean;
  reveal: (path: string) => void;
  showToast: ToastFn;
  addHistory: AddHistoryFn;
}) {
  const [phase, setPhase] = useState<MergePhase>({ kind: "idle" });
  const loadVideo = useLoadVideo();
  const [outputDir, pickOutputDir, resetOutputDir] = useVideoOutputDir();

  const currentJobId = phase.kind === "processing" ? phase.jobId : null;
  const percent = useVideoProgress(currentJobId);

  const addPaths = useCallback(
    async (paths: string[]) => {
      const existing = phase.kind === "ready" ? phase.items : [];
      // Charge les infos en parallèle (peu de vidéos en pratique).
      const loaded = await Promise.all(
        paths.map(async (p): Promise<MergeItem | null> => {
          const info = await loadVideo(p);
          if (!info) return null;
          return {
            id: newJobId(),
            path: info.path,
            fileName: info.fileName,
            durationSeconds: info.durationSeconds,
            sizeBytes: info.sizeBytes,
          };
        }),
      );
      const items = [...existing, ...loaded.filter((i): i is MergeItem => i !== null)];
      setPhase({ kind: "ready", items });
    },
    [phase, loadVideo],
  );

  const hovering = useVideoDrop(active, (p) => void addPaths([p]), (ps) => void addPaths(ps));

  const onPick = async () => {
    const paths = await pickVideo(true);
    if (paths && paths.length > 0) void addPaths(paths);
  };

  const reset = () => setPhase({ kind: "idle" });

  const removeItem = (id: string) => {
    if (phase.kind !== "ready") return;
    const items = phase.items.filter((i) => i.id !== id);
    if (items.length === 0) reset();
    else setPhase({ kind: "ready", items });
  };

  const moveItem = (id: string, dir: -1 | 1) => {
    if (phase.kind !== "ready") return;
    const idx = phase.items.findIndex((i) => i.id === id);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= phase.items.length) return;
    const items = [...phase.items];
    [items[idx], items[target]] = [items[target], items[idx]];
    setPhase({ kind: "ready", items });
  };

  const merge = async () => {
    if (phase.kind !== "ready" || phase.items.length < 2) return;
    const items = phase.items;
    const firstPath = items[0].path;
    const ext = fileExt(firstPath) || "mp4";
    const outputPath = safeOutputPath(firstPath, "fusion", ext, outputDir);
    const jobId = newJobId();
    setPhase({ kind: "processing", items, jobId });
    try {
      const produced = await invoke<string>("merge_videos", {
        jobId,
        inputPaths: items.map((i) => i.path),
        outputPath,
      });
      const finalInfo = await loadVideo(produced);
      const totalDur = items.reduce((s, it) => s + (it.durationSeconds ?? 0), 0);
      addHistory({
        kind: "merge",
        sourcePath: items[0].path,
        sourceFileName: `${items.length} fichiers`,
        outputPath: produced,
        outputFileName: baseName(produced),
        durationSeconds: totalDur,
        videoSummary: `${items.length} clips fusionnés (sans ré-encodage)`,
        outputSizeBytes: finalInfo?.sizeBytes ?? 0,
      });
      setPhase({ kind: "done", output: produced });
      showToast(`${items.length} vidéos fusionnées`);
    } catch (e) {
      setPhase({ kind: "error", message: String(e), items });
    }
  };

  const totalDuration = phase.kind === "ready"
    ? phase.items.reduce((s, i) => s + (i.durationSeconds ?? 0), 0)
    : 0;

  return (
    <div className="tool-page">
      <header className="page__header">
        <h1>Fusionner des vidéos</h1>
      </header>
      <p className="page__intro">
        Concatène plusieurs vidéos en une seule, dans l'ordre choisi.
        <br />
        <strong>Important&nbsp;:</strong> toutes les vidéos doivent partager
        codec, résolution et fps. Sinon convertis-les d'abord vers le même
        format.
      </p>

      <section className="stage">
        {phase.kind === "idle" && (
          <VideoDropZone
            hovering={hovering}
            onPick={onPick}
            title="Glisser plusieurs vidéos"
            hint="dans l'ordre voulu (modifiable ensuite)"
            multiple
          />
        )}

        {phase.kind === "ready" && (
          <>
            <div className="merge-list-head">
              <span>
                {phase.items.length} vidéo{phase.items.length > 1 ? "s" : ""} ·{" "}
                Total {formatTime(totalDuration)}
              </span>
              <button className="linkbtn" onClick={onPick}>+ Ajouter</button>
            </div>
            <ul className="merge-list">
              {phase.items.map((item, i) => (
                <li key={item.id} className="merge-item">
                  <span className="merge-item__index">{i + 1}</span>
                  <div className="merge-item__body">
                    <div className="merge-item__name">{item.fileName}</div>
                    <div className="merge-item__meta">
                      {item.durationSeconds != null && formatTime(item.durationSeconds)} ·{" "}
                      {formatBytes(item.sizeBytes)}
                    </div>
                  </div>
                  <div className="merge-item__actions">
                    <button
                      className="iconbtn iconbtn--inline"
                      onClick={() => moveItem(item.id, -1)}
                      disabled={i === 0}
                      title="Monter"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m5 14 7-7 7 7" />
                      </svg>
                    </button>
                    <button
                      className="iconbtn iconbtn--inline"
                      onClick={() => moveItem(item.id, 1)}
                      disabled={i === phase.items.length - 1}
                      title="Descendre"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m5 10 7 7 7-7" />
                      </svg>
                    </button>
                    <button
                      className="iconbtn iconbtn--inline iconbtn--danger"
                      onClick={() => removeItem(item.id)}
                      title="Retirer"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <OutputDirField
              value={outputDir}
              onPick={pickOutputDir}
              onReset={resetOutputDir}
            />
          </>
        )}

        {phase.kind === "processing" && (
          <>
            <div className="filecard">
              <div className="filecard__body">
                <div className="filecard__name">
                  Fusion de {phase.items.length} vidéos…
                </div>
              </div>
            </div>
            <ProgressBar percent={percent ?? 0} />
          </>
        )}

        {phase.kind === "done" && (
          <>
            <div className="filecard">
              <div className="filecard__body">
                <div className="filecard__name">{baseName(phase.output)}</div>
                <div className="filecard__meta">Fusion terminée</div>
              </div>
            </div>
            <video
              src={convertFileSrc(phase.output)}
              controls
              className="editor__video"
              preload="metadata"
            />
          </>
        )}

        {phase.kind === "error" && (
          <>
            <div className="errorcard">{phase.message}</div>
            {phase.items && (
              <p className="page__empty-hint">
                Astuce&nbsp;: si les vidéos ont des codecs/résolutions
                différents, convertis-les d'abord au même format.
              </p>
            )}
          </>
        )}
      </section>

      <footer className="footer">
        <div className="actions">
          {phase.kind === "ready" && (
            <>
              <button className="btn btn--ghost" onClick={reset}>Annuler</button>
              <button
                className="btn"
                onClick={merge}
                disabled={phase.items.length < 2}
              >
                {phase.items.length < 2
                  ? "Ajouter au moins 2 vidéos"
                  : `Fusionner ${phase.items.length} vidéos`}
              </button>
            </>
          )}
          {phase.kind === "processing" && (
            <button className="btn" disabled>
              {percent != null ? `${Math.round(percent)} %` : "Fusion…"}
            </button>
          )}
          {phase.kind === "done" && (
            <>
              <button className="btn btn--ghost" onClick={() => reveal(phase.output)}>
                Afficher dans le Finder
              </button>
              <button className="btn" onClick={reset}>Nouvelle fusion</button>
            </>
          )}
          {phase.kind === "error" && (
            <>
              <button className="btn btn--ghost" onClick={reset}>Recommencer</button>
              {phase.items && phase.items.length >= 2 && (
                <button
                  className="btn"
                  onClick={() => setPhase({ kind: "ready", items: phase.items! })}
                >
                  Revenir à la liste
                </button>
              )}
            </>
          )}
        </div>
      </footer>
    </div>
  );
}

// =============================================================
// VERS GIF
// =============================================================

// FPS courants pour les GIF. Au-delà de 25 ça devient surtout des données
// supplémentaires sans gain perceptif (l'œil sature, et la taille explose).
const GIF_FPS_OPTIONS: { value: number; label: string }[] = [
  { value: 10, label: "10 fps" },
  { value: 15, label: "15 fps" },
  { value: 20, label: "20 fps" },
  { value: 25, label: "25 fps" },
];

// Résolutions GIF. Source = on garde la hauteur d'origine.
const GIF_SCALE_OPTIONS: { value: number; label: string }[] = [
  { value: 240, label: "240p" },
  { value: 320, label: "320p" },
  { value: 480, label: "480p" },
  { value: 720, label: "720p" },
];

type GifPhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; info: VideoInfo }
  | { kind: "processing"; info: VideoInfo; jobId: string }
  | { kind: "done"; info: VideoInfo; output: string; outputSizeBytes: number }
  | { kind: "error"; message: string };

export function ToGifView({
  active,
  reveal,
  showToast,
  addHistory,
}: {
  active: boolean;
  reveal: (path: string) => void;
  showToast: ToastFn;
  addHistory: AddHistoryFn;
}) {
  const [phase, setPhase] = useState<GifPhase>({ kind: "idle" });
  const [fps, setFps] = useState<number>(15);
  const [scaleHeight, setScaleHeight] = useState<number>(480);
  const [useTrim, setUseTrim] = useState(false);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const loadVideo = useLoadVideo();
  const [outputDir, pickOutputDir, resetOutputDir] = useVideoOutputDir();

  const currentJobId = phase.kind === "processing" ? phase.jobId : null;
  const percent = useVideoProgress(currentJobId);

  const handleSingle = useCallback(
    async (path: string) => {
      setPhase({ kind: "loading" });
      setThumbnails([]);
      setCurrentTime(0);
      const info = await loadVideo(path);
      if (!info) {
        setPhase({ kind: "error", message: "Impossible de lire les infos de la vidéo." });
        return;
      }
      const d = info.durationSeconds ?? 0;
      setTrimStart(0);
      setTrimEnd(d);
      // Pour les GIF, on suggère par défaut un trim sur les 5 premières
      // secondes si la vidéo est plus longue : les GIF longs sont rarement
      // utiles et deviennent énormes très vite.
      if (d > 5) {
        setUseTrim(true);
        setTrimEnd(Math.min(5, d));
      } else {
        setUseTrim(false);
      }
      setPhase({ kind: "ready", info });
      try {
        const thumbs = await invoke<string[]>("generate_video_thumbnails", {
          inputPath: path,
          count: 10,
        });
        setThumbnails(thumbs);
      } catch (e) {
        console.warn("Thumbnails generation failed:", e);
      }
    },
    [loadVideo],
  );

  // Sync currentTime depuis le lecteur HTML5
  useEffect(() => {
    const el = videoRef.current;
    if (!el || phase.kind !== "ready") return;
    const onUpdate = () => setCurrentTime(el.currentTime);
    el.addEventListener("timeupdate", onUpdate);
    el.addEventListener("seeked", onUpdate);
    return () => {
      el.removeEventListener("timeupdate", onUpdate);
      el.removeEventListener("seeked", onUpdate);
    };
  }, [phase.kind]);

  const seekTo = (t: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(t, el.duration || 0));
  };
  const setStartHere = () => {
    if (currentTime < trimEnd - 0.5) setTrimStart(currentTime);
  };
  const setEndHere = () => {
    if (currentTime > trimStart + 0.5) setTrimEnd(currentTime);
  };

  const hovering = useVideoDrop(active, handleSingle);
  const onPick = async () => {
    const paths = await pickVideo(false);
    if (paths && paths.length > 0) void handleSingle(paths[0]);
  };
  const reset = () => setPhase({ kind: "idle" });

  const run = async () => {
    if (phase.kind !== "ready") return;
    const info = phase.info;
    const outputPath = safeOutputPath(info.path, "", "gif", outputDir);
    const jobId = newJobId();
    setPhase({ kind: "processing", info, jobId });
    try {
      const produced = await invoke<string>("convert_to_gif", {
        jobId,
        inputPath: info.path,
        outputPath,
        fps,
        scaleHeight,
        startSeconds: useTrim ? trimStart : null,
        endSeconds: useTrim ? trimEnd : null,
      });
      const finalInfo = await loadVideo(produced);
      const size = finalInfo?.sizeBytes ?? 0;
      const dur = useTrim ? trimEnd - trimStart : info.durationSeconds ?? 0;
      addHistory({
        kind: "convert",
        sourcePath: info.path,
        sourceFileName: info.fileName,
        outputPath: produced,
        outputFileName: baseName(produced),
        durationSeconds: dur,
        videoSummary: `GIF · ${fps} fps · ${scaleHeight}p${useTrim ? " · extrait" : ""}`,
        outputSizeBytes: size,
      });
      setPhase({ kind: "done", info, output: produced, outputSizeBytes: size });
      showToast("GIF créé");
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    }
  };

  const duration = phase.kind === "ready" ? phase.info.durationSeconds ?? 0 : 0;
  const gifDuration = useTrim ? trimEnd - trimStart : duration;

  // Estimation très grossière de la taille du GIF.
  // Heuristique : (largeur * hauteur * fps * durée) / facteur de compression
  // où le facteur dépend du contenu (entre 12 et 30 pour la plupart des cas).
  // On suppose 16:9, donc largeur ≈ scaleHeight * 16/9.
  const estimatedBytes = useMemo(() => {
    if (phase.kind !== "ready") return null;
    const width = Math.round((scaleHeight * 16) / 9);
    const raw = width * scaleHeight * fps * gifDuration;
    return Math.round(raw / 20); // facteur empirique
  }, [phase.kind, scaleHeight, fps, gifDuration]);

  return (
    <div className="tool-page">
      <header className="page__header">
        <h1>Vers GIF</h1>
      </header>
      <p className="page__intro">
        Convertit une vidéo (ou un extrait) en GIF animé haute qualité.
        La palette est calculée à partir de la vidéo pour éviter les couleurs
        ternes des GIF par défaut.
      </p>

      <section className="stage">
        {phase.kind === "idle" && (
          <VideoDropZone
            hovering={hovering}
            onPick={onPick}
            title="Glisser une vidéo à convertir en GIF"
            hint="ou clique pour la choisir"
          />
        )}

        {phase.kind === "loading" && (
          <div className="filecard filecard--loading">
            <div className="filecard__body">
              <div className="filecard__name">Lecture des infos…</div>
            </div>
          </div>
        )}

        {phase.kind === "ready" && (
          <>
            <VideoInfoCard info={phase.info} />
            <video
              ref={videoRef}
              src={convertFileSrc(phase.info.path)}
              controls
              className="editor__video"
              preload="metadata"
            />
            <div className="options">
              <Segmented
                label="FPS"
                options={GIF_FPS_OPTIONS.map((o) => ({
                  value: String(o.value),
                  label: o.label,
                }))}
                value={String(fps)}
                onChange={(v) => setFps(parseInt(v, 10))}
              />
              <Segmented
                label="Hauteur"
                options={GIF_SCALE_OPTIONS.map((o) => ({
                  value: String(o.value),
                  label: o.label,
                }))}
                value={String(scaleHeight)}
                onChange={(v) => setScaleHeight(parseInt(v, 10))}
              />
              <label className="gif-trim-toggle">
                <input
                  type="checkbox"
                  checked={useTrim}
                  onChange={(e) => setUseTrim(e.target.checked)}
                />
                <span>Découper un extrait</span>
              </label>
              {useTrim && (
                <>
                  <div className="trim-actions">
                    <button className="btn btn--ghost" onClick={setStartHere}>
                      Début ici ({formatTime(currentTime)})
                    </button>
                    <button className="btn btn--ghost" onClick={setEndHere}>
                      Fin ici ({formatTime(currentTime)})
                    </button>
                  </div>
                  <TrimRange
                    duration={duration}
                    start={trimStart}
                    end={trimEnd}
                    currentTime={currentTime}
                    thumbnails={thumbnails}
                    onChange={(s, e) => {
                      setTrimStart(s);
                      setTrimEnd(e);
                    }}
                    onSeek={seekTo}
                  />
                </>
              )}
              {estimatedBytes != null && (
                <div className="size-estimate">
                  <span className="size-estimate__label">Estimation</span>
                  <span className="size-estimate__values">
                    {formatTime(gifDuration)} · <strong>~{formatBytes(estimatedBytes)}</strong>
                  </span>
                </div>
              )}
              {gifDuration > 15 && (
                <p className="page__empty-hint" style={{ marginTop: "-4px" }}>
                  Astuce : les GIF deviennent vite très lourds passé 10-15 s.
                  Active "Découper un extrait" pour réduire.
                </p>
              )}
              <OutputDirField
                value={outputDir}
                onPick={pickOutputDir}
                onReset={resetOutputDir}
              />
            </div>
          </>
        )}

        {phase.kind === "processing" && (
          <>
            <VideoInfoCard info={phase.info} />
            <div className="extracting-block">
              <div className="filecard__meta">
                {(percent ?? 0) < 50
                  ? "Analyse des couleurs (création de la palette)…"
                  : "Écriture du GIF…"}
              </div>
              <ProgressBar percent={percent ?? 0} />
            </div>
          </>
        )}

        {phase.kind === "done" && (
          <>
            <div className="filecard">
              <div className="filecard__icon" aria-hidden>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="filecard__body">
                <div className="filecard__name">{baseName(phase.output)}</div>
                <div className="filecard__meta">
                  GIF créé · {formatBytes(phase.outputSizeBytes)}
                </div>
              </div>
            </div>
            <img
              src={convertFileSrc(phase.output)}
              alt="GIF généré"
              className="gif-preview"
            />
          </>
        )}

        {phase.kind === "error" && <div className="errorcard">{phase.message}</div>}
      </section>

      <footer className="footer">
        <div className="actions">
          {phase.kind === "ready" && (
            <>
              <button className="btn btn--ghost" onClick={reset}>Annuler</button>
              <button className="btn" onClick={run}>
                Créer le GIF
              </button>
            </>
          )}
          {phase.kind === "processing" && (
            <button className="btn" disabled>
              {percent != null ? `${Math.round(percent)} %` : "Encodage…"}
            </button>
          )}
          {phase.kind === "done" && (
            <>
              <button className="btn btn--ghost" onClick={() => reveal(phase.output)}>
                Afficher dans le Finder
              </button>
              <button className="btn" onClick={reset}>Nouveau GIF</button>
            </>
          )}
          {phase.kind === "error" && (
            <button className="btn btn--ghost" onClick={reset}>Réessayer</button>
          )}
        </div>
      </footer>
    </div>
  );
}

// =============================================================
// EXTRAIRE UNE IMAGE
// =============================================================

// Une image capturée durant la session. On en garde la liste pour permettre
// à l'utilisateur d'enchaîner plusieurs captures sans recharger la vidéo.
type FrameCapture = {
  id: string;
  path: string;
  timeSeconds: number;
  format: "png" | "jpg";
};

// Formate un timestamp en chaîne safe pour un nom de fichier
// (HH-MM-SS-mmm), évite les ":" qui posent problème sur macOS/Windows.
function formatTimeForFilename(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds * 1000) % 1000);
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return `${pad(h)}h${pad(m)}m${pad(s)}s${pad(ms, 3)}`;
}

type FramePhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; info: VideoInfo };

export function FrameExtractView({
  active,
  reveal,
  showToast,
  addHistory,
}: {
  active: boolean;
  reveal: (path: string) => void;
  showToast: ToastFn;
  addHistory: AddHistoryFn;
}) {
  const [phase, setPhase] = useState<FramePhase>({ kind: "idle" });
  const [format, setFormat] = useState<"png" | "jpg">("png");
  const [currentTime, setCurrentTime] = useState(0);
  const [captures, setCaptures] = useState<FrameCapture[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const loadVideo = useLoadVideo();
  const [outputDir, pickOutputDir, resetOutputDir] = useVideoOutputDir();

  const handleSingle = useCallback(
    async (path: string) => {
      setPhase({ kind: "loading" });
      setCurrentTime(0);
      setCaptures([]);
      setError(null);
      const info = await loadVideo(path);
      if (!info) {
        setError("Impossible de lire la vidéo.");
        setPhase({ kind: "idle" });
        return;
      }
      setPhase({ kind: "ready", info });
    },
    [loadVideo],
  );

  // Sync currentTime depuis le lecteur HTML5 (timeupdate + seeked).
  useEffect(() => {
    const el = videoRef.current;
    if (!el || phase.kind !== "ready") return;
    const onUpdate = () => setCurrentTime(el.currentTime);
    el.addEventListener("timeupdate", onUpdate);
    el.addEventListener("seeked", onUpdate);
    return () => {
      el.removeEventListener("timeupdate", onUpdate);
      el.removeEventListener("seeked", onUpdate);
    };
  }, [phase.kind]);

  const hovering = useVideoDrop(active, handleSingle);
  const onPick = async () => {
    const paths = await pickVideo(false);
    if (paths && paths.length > 0) void handleSingle(paths[0]);
  };
  const reset = () => {
    setPhase({ kind: "idle" });
    setCaptures([]);
    setError(null);
  };

  // Capture l'image à la position courante du lecteur. Pour ne pas
  // bloquer l'UI on désactive le bouton pendant l'appel ffmpeg (1 frame,
  // très rapide en pratique mais asynchrone).
  const capture = async () => {
    if (phase.kind !== "ready" || capturing) return;
    setCapturing(true);
    setError(null);
    const info = phase.info;
    const dir = outputDir ?? dirName(info.path);
    const base = stripExtension(baseName(info.path));
    const stamp = formatTimeForFilename(currentTime);
    const outputPath = `${dir}/${base}_frame_${stamp}.${format}`;
    try {
      const produced = await invoke<string>("extract_frame", {
        inputPath: info.path,
        outputPath,
        timeSeconds: currentTime,
      });
      const finalInfo = await loadVideo(produced);
      const cap: FrameCapture = {
        id: newJobId(),
        path: produced,
        timeSeconds: currentTime,
        format,
      };
      setCaptures((prev) => [cap, ...prev]);
      addHistory({
        kind: "convert",
        sourcePath: info.path,
        sourceFileName: info.fileName,
        outputPath: produced,
        outputFileName: baseName(produced),
        durationSeconds: 0,
        videoSummary: `Image ${format.toUpperCase()} à ${formatTime(currentTime)}`,
        outputSizeBytes: finalInfo?.sizeBytes ?? 0,
      });
      showToast(`Image capturée à ${formatTime(currentTime)}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setCapturing(false);
    }
  };

  const removeCapture = (id: string) => {
    setCaptures((prev) => prev.filter((c) => c.id !== id));
  };

  return (
    <div className="tool-page">
      <header className="page__header">
        <h1>Extraire une image</h1>
      </header>
      <p className="page__intro">
        Sélectionne l'instant voulu dans le lecteur, choisis le format et
        clique <em>Capturer</em>. Tu peux enchaîner plusieurs captures avec
        la même vidéo.
      </p>

      <section className="stage">
        {phase.kind === "idle" && (
          <VideoDropZone
            hovering={hovering}
            onPick={onPick}
            title="Glisser une vidéo"
            hint="ou clique pour la choisir"
          />
        )}

        {phase.kind === "loading" && (
          <div className="filecard filecard--loading">
            <div className="filecard__body">
              <div className="filecard__name">Lecture des infos…</div>
            </div>
          </div>
        )}

        {phase.kind === "ready" && (
          <>
            <VideoInfoCard info={phase.info} />
            <video
              ref={videoRef}
              src={convertFileSrc(phase.info.path)}
              controls
              className="editor__video"
              preload="metadata"
            />
            <div className="capture-bar">
              <div className="capture-bar__time">
                Position&nbsp;: <strong>{formatTime(currentTime)}</strong>
              </div>
              <Segmented
                label="Format"
                options={[
                  { value: "png", label: "PNG" },
                  { value: "jpg", label: "JPG" },
                ]}
                value={format}
                onChange={(v) => setFormat(v as "png" | "jpg")}
              />
              <button
                className="btn"
                onClick={capture}
                disabled={capturing}
              >
                {capturing ? "Capture…" : `Capturer (${format.toUpperCase()})`}
              </button>
            </div>
            <OutputDirField
              value={outputDir}
              onPick={pickOutputDir}
              onReset={resetOutputDir}
            />

            {captures.length > 0 && (
              <>
                <div className="capture-list-head">
                  <span>
                    {captures.length} image{captures.length > 1 ? "s" : ""} capturée
                    {captures.length > 1 ? "s" : ""}
                  </span>
                </div>
                <ul className="capture-list">
                  {captures.map((c) => (
                    <li key={c.id} className="capture-item">
                      <img
                        src={convertFileSrc(c.path)}
                        alt=""
                        className="capture-item__thumb"
                      />
                      <div className="capture-item__body">
                        <div className="capture-item__name">{baseName(c.path)}</div>
                        <div className="capture-item__meta">
                          {c.format.toUpperCase()} · à {formatTime(c.timeSeconds)}
                        </div>
                      </div>
                      <div className="capture-item__actions">
                        <button
                          className="iconbtn iconbtn--inline"
                          onClick={() => reveal(c.path)}
                          title="Afficher dans le Finder"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                          </svg>
                        </button>
                        <button
                          className="iconbtn iconbtn--inline iconbtn--danger"
                          onClick={() => removeCapture(c.id)}
                          title="Retirer de la liste"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                            <path d="M18 6 6 18" />
                            <path d="m6 6 12 12" />
                          </svg>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        {error && <div className="errorcard">{error}</div>}
      </section>

      <footer className="footer">
        <div className="actions">
          {phase.kind === "ready" && (
            <button className="btn btn--ghost" onClick={reset}>
              Nouvelle vidéo
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

// =============================================================
// REDIMENSIONNER / PIVOTER
// =============================================================

// Rotation possible (multiples de 90° uniquement — pour rester en pixel-perfect
// sans interpolation supplémentaire et conserver la qualité).
type Rotation = 0 | 90 | 180 | 270;

type TransformPhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; info: VideoInfo }
  | { kind: "processing"; info: VideoInfo; jobId: string }
  | { kind: "done"; info: VideoInfo; output: string }
  | { kind: "error"; message: string };

export function TransformView({
  active,
  reveal,
  showToast,
  addHistory,
}: {
  active: boolean;
  reveal: (path: string) => void;
  showToast: ToastFn;
  addHistory: AddHistoryFn;
}) {
  const [phase, setPhase] = useState<TransformPhase>({ kind: "idle" });
  const [rotation, setRotation] = useState<Rotation>(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [scale, setScale] = useState<ScaleOption>("original");
  const loadVideo = useLoadVideo();
  const [outputDir, pickOutputDir, resetOutputDir] = useVideoOutputDir();

  const currentJobId = phase.kind === "processing" ? phase.jobId : null;
  const percent = useVideoProgress(currentJobId);

  const handleSingle = useCallback(
    async (path: string) => {
      setPhase({ kind: "loading" });
      const info = await loadVideo(path);
      if (!info) {
        setPhase({ kind: "error", message: "Impossible de lire la vidéo." });
        return;
      }
      setRotation(0);
      setFlipH(false);
      setFlipV(false);
      setScale("original");
      setPhase({ kind: "ready", info });
    },
    [loadVideo],
  );

  const hovering = useVideoDrop(active, handleSingle);
  const onPick = async () => {
    const paths = await pickVideo(false);
    if (paths && paths.length > 0) void handleSingle(paths[0]);
  };
  const reset = () => setPhase({ kind: "idle" });

  const rotateLeft = () =>
    setRotation((r) => ((r - 90 + 360) % 360) as Rotation);
  const rotateRight = () => setRotation((r) => ((r + 90) % 360) as Rotation);
  const rotate180 = () => setRotation((r) => ((r + 180) % 360) as Rotation);
  const resetTransform = () => {
    setRotation(0);
    setFlipH(false);
    setFlipV(false);
    setScale("original");
  };

  // Au moins une transformation doit être active pour activer le bouton.
  const hasTransform =
    rotation !== 0 || flipH || flipV || scale !== "original";

  const run = async () => {
    if (phase.kind !== "ready" || !hasTransform) return;
    const info = phase.info;
    const ext = fileExt(info.path) || "mp4";
    const outputPath = safeOutputPath(info.path, "transform", ext, outputDir);
    const jobId = newJobId();
    setPhase({ kind: "processing", info, jobId });
    try {
      const produced = await invoke<string>("transform_video", {
        jobId,
        inputPath: info.path,
        outputPath,
        scaleHeight: SCALE_HEIGHTS[scale],
        rotation,
        flipH,
        flipV,
      });
      const finalInfo = await loadVideo(produced);
      const parts: string[] = [];
      if (rotation !== 0) parts.push(`${rotation}°`);
      if (flipH) parts.push("miroir H");
      if (flipV) parts.push("miroir V");
      if (scale !== "original") {
        const lbl = SCALE_LABELS.find((s) => s.value === scale)?.label ?? scale;
        parts.push(lbl);
      }
      addHistory({
        kind: "convert",
        sourcePath: info.path,
        sourceFileName: info.fileName,
        outputPath: produced,
        outputFileName: baseName(produced),
        durationSeconds: info.durationSeconds ?? 0,
        videoSummary: parts.join(" · "),
        outputSizeBytes: finalInfo?.sizeBytes ?? 0,
      });
      setPhase({ kind: "done", info, output: produced });
      showToast("Transformation appliquée");
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    }
  };

  // Transform CSS appliqué à la balise <video> pour donner un aperçu live
  // de la rotation/flip. Sur 90/270° l'aperçu peut paraître recadré ou
  // squashé dans le container (le rapport de forme du <video> reste fixe) —
  // c'est un compromis acceptable pour un aperçu live.
  const previewTransform = `rotate(${rotation}deg) scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1})`;

  return (
    <div className="tool-page">
      <header className="page__header">
        <h1>Redimensionner / Pivoter</h1>
      </header>
      <p className="page__intro">
        Tourne une vidéo (multiples de 90°), retourne-la en miroir ou
        change sa hauteur. L'aperçu est appliqué en direct mais la vidéo
        elle-même n'est ré-encodée qu'au clic sur <em>Appliquer</em>.
      </p>

      <section className="stage">
        {phase.kind === "idle" && (
          <VideoDropZone
            hovering={hovering}
            onPick={onPick}
            title="Glisser une vidéo à transformer"
            hint="ou clique pour la choisir"
          />
        )}

        {phase.kind === "loading" && (
          <div className="filecard filecard--loading">
            <div className="filecard__body">
              <div className="filecard__name">Lecture des infos…</div>
            </div>
          </div>
        )}

        {phase.kind === "ready" && (
          <>
            <VideoInfoCard info={phase.info} />
            <div className="transform-preview">
              <video
                src={convertFileSrc(phase.info.path)}
                controls
                preload="metadata"
                style={{ transform: previewTransform }}
              />
            </div>
            <div className="transform-controls">
              <button
                className="iconbtn"
                onClick={rotateLeft}
                title="Pivoter 90° à gauche"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9" />
                  <path d="m3 3 0 5 5 0" />
                </svg>
              </button>
              <button
                className="iconbtn"
                onClick={rotateRight}
                title="Pivoter 90° à droite"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-9-9" />
                  <path d="m21 3 0 5-5 0" />
                </svg>
              </button>
              <button
                className="iconbtn"
                onClick={rotate180}
                title="Pivoter 180°"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9" />
                  <path d="M12 3v9l8 4" />
                </svg>
              </button>
              <button
                className={`iconbtn ${flipH ? "iconbtn--on" : ""}`}
                onClick={() => setFlipH((v) => !v)}
                title="Miroir horizontal"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12h18" />
                  <path d="m7 8-4 4 4 4" />
                  <path d="m17 8 4 4-4 4" />
                </svg>
              </button>
              <button
                className={`iconbtn ${flipV ? "iconbtn--on" : ""}`}
                onClick={() => setFlipV((v) => !v)}
                title="Miroir vertical"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v18" />
                  <path d="m8 7 4-4 4 4" />
                  <path d="m8 17 4 4 4-4" />
                </svg>
              </button>
              {hasTransform && (
                <button
                  className="linkbtn linkbtn--muted transform-controls__reset"
                  onClick={resetTransform}
                >
                  Réinitialiser
                </button>
              )}
            </div>
            <Segmented
              label="Hauteur"
              options={[
                { value: "original", label: "Source" },
                { value: "1080", label: "1080p" },
                { value: "720", label: "720p" },
                { value: "540", label: "540p" },
                { value: "480", label: "480p" },
              ]}
              value={scale}
              onChange={setScale}
            />
            {hasTransform && (
              <div className="transform-summary">
                <span className="effects__label">Aperçu actif</span>
                <span>
                  {rotation !== 0 && `${rotation}° · `}
                  {flipH && "miroir H · "}
                  {flipV && "miroir V · "}
                  {scale !== "original"
                    ? SCALE_LABELS.find((s) => s.value === scale)?.label
                    : "Hauteur source"}
                </span>
              </div>
            )}
            <OutputDirField
              value={outputDir}
              onPick={pickOutputDir}
              onReset={resetOutputDir}
            />
          </>
        )}

        {phase.kind === "processing" && (
          <>
            <VideoInfoCard info={phase.info} />
            <div className="extracting-block">
              <div className="filecard__meta">Ré-encodage…</div>
              <ProgressBar percent={percent ?? 0} />
            </div>
          </>
        )}

        {phase.kind === "done" && (
          <>
            <div className="filecard">
              <div className="filecard__icon" aria-hidden>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="filecard__body">
                <div className="filecard__name">{baseName(phase.output)}</div>
                <div className="filecard__meta">Transformation appliquée</div>
              </div>
            </div>
            <video
              src={convertFileSrc(phase.output)}
              controls
              className="editor__video"
              preload="metadata"
            />
          </>
        )}

        {phase.kind === "error" && <div className="errorcard">{phase.message}</div>}
      </section>

      <footer className="footer">
        <div className="actions">
          {phase.kind === "ready" && (
            <>
              <button className="btn btn--ghost" onClick={reset}>Annuler</button>
              <button className="btn" onClick={run} disabled={!hasTransform}>
                {hasTransform ? "Appliquer" : "Aucune transformation"}
              </button>
            </>
          )}
          {phase.kind === "processing" && (
            <button className="btn" disabled>
              {percent != null ? `${Math.round(percent)} %` : "Encodage…"}
            </button>
          )}
          {phase.kind === "done" && (
            <>
              <button className="btn btn--ghost" onClick={() => reveal(phase.output)}>
                Afficher dans le Finder
              </button>
              <button className="btn" onClick={reset}>Nouvelle vidéo</button>
            </>
          )}
          {phase.kind === "error" && (
            <button className="btn btn--ghost" onClick={reset}>Réessayer</button>
          )}
        </div>
      </footer>
    </div>
  );
}

// =============================================================
// RECADRER (CROP MANUEL)
// =============================================================

// Rectangle de recadrage en coordonnées normalisées 0-1 (relatif à la
// vidéo). Stocker en fraction au lieu de pixels permet de rester
// indépendant de la taille de rendu CSS (utile quand la fenêtre est
// redimensionnée et que la vidéo en preview change de taille).
type CropRect = { x: number; y: number; w: number; h: number };

// Ratios cibles. `null` = libre (les poignées modifient indépendamment
// largeur et hauteur). Les autres verrouillent W/H lors du resize.
type CropRatio = { id: string; label: string; ratio: number | null };
const CROP_RATIOS: CropRatio[] = [
  { id: "free", label: "Libre", ratio: null },
  { id: "16-9", label: "16:9", ratio: 16 / 9 },
  { id: "9-16", label: "9:16", ratio: 9 / 16 },
  { id: "1-1", label: "1:1", ratio: 1 },
  { id: "4-5", label: "4:5", ratio: 4 / 5 },
  { id: "4-3", label: "4:3", ratio: 4 / 3 },
];

// Calcule un crop centré qui respecte un ratio cible dans une vidéo de
// dimensions données. Utilisé quand l'utilisateur choisit un ratio
// préset.
function centeredCropForRatio(
  videoWidth: number,
  videoHeight: number,
  targetRatio: number,
): CropRect {
  const videoRatio = videoWidth / videoHeight;
  if (targetRatio >= videoRatio) {
    // Le ratio cible est plus large que la vidéo : on prend toute la
    // largeur, et on rogne en hauteur.
    const w = 1;
    const h = (videoWidth / targetRatio) / videoHeight;
    return { x: 0, y: (1 - h) / 2, w, h };
  } else {
    // Ratio cible plus étroit : on prend toute la hauteur, on rogne en
    // largeur.
    const h = 1;
    const w = (videoHeight * targetRatio) / videoWidth;
    return { x: (1 - w) / 2, y: 0, w, h };
  }
}

type CropPhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; info: VideoInfo }
  | { kind: "processing"; info: VideoInfo; jobId: string }
  | { kind: "done"; info: VideoInfo; output: string }
  | { kind: "error"; message: string };

export function CropView({
  active,
  reveal,
  showToast,
  addHistory,
}: {
  active: boolean;
  reveal: (path: string) => void;
  showToast: ToastFn;
  addHistory: AddHistoryFn;
}) {
  const [phase, setPhase] = useState<CropPhase>({ kind: "idle" });
  const [crop, setCrop] = useState<CropRect>({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  const [ratioId, setRatioId] = useState<string>("free");
  // Dimensions naturelles de la vidéo (lues sur loadedmetadata du <video>).
  // Nécessaires pour convertir le crop (fractions) en pixels avant ffmpeg.
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const loadVideo = useLoadVideo();
  const [outputDir, pickOutputDir, resetOutputDir] = useVideoOutputDir();

  const currentJobId = phase.kind === "processing" ? phase.jobId : null;
  const percent = useVideoProgress(currentJobId);

  const handleSingle = useCallback(
    async (path: string) => {
      setPhase({ kind: "loading" });
      setNaturalSize(null);
      setCrop({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
      setRatioId("free");
      const info = await loadVideo(path);
      if (!info) {
        setPhase({ kind: "error", message: "Impossible de lire la vidéo." });
        return;
      }
      setPhase({ kind: "ready", info });
    },
    [loadVideo],
  );

  // Capture les dimensions naturelles de la vidéo quand le lecteur charge
  // les metadata. videoWidth/Height sont 0 avant cet event.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || phase.kind !== "ready") return;
    const onMeta = () => {
      if (el.videoWidth > 0 && el.videoHeight > 0) {
        setNaturalSize({ w: el.videoWidth, h: el.videoHeight });
      }
    };
    el.addEventListener("loadedmetadata", onMeta);
    if (el.readyState >= 1) onMeta();
    return () => el.removeEventListener("loadedmetadata", onMeta);
  }, [phase.kind]);

  const hovering = useVideoDrop(active, handleSingle);
  const onPick = async () => {
    const paths = await pickVideo(false);
    if (paths && paths.length > 0) void handleSingle(paths[0]);
  };
  const reset = () => setPhase({ kind: "idle" });

  // Applique un ratio préset : recalcule un crop centré au bon ratio.
  const applyRatio = (id: string) => {
    setRatioId(id);
    if (!naturalSize) return;
    const r = CROP_RATIOS.find((c) => c.id === id);
    if (!r || r.ratio == null) return;
    setCrop(centeredCropForRatio(naturalSize.w, naturalSize.h, r.ratio));
  };

  const resetCrop = () => {
    setCrop({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    setRatioId("free");
  };

  const activeRatio = CROP_RATIOS.find((c) => c.id === ratioId)?.ratio ?? null;

  // Pixels effectifs du crop selon les dimensions naturelles de la vidéo.
  const cropPixels = useMemo(() => {
    if (!naturalSize) return null;
    return {
      x: Math.round(crop.x * naturalSize.w),
      y: Math.round(crop.y * naturalSize.h),
      w: Math.round(crop.w * naturalSize.w),
      h: Math.round(crop.h * naturalSize.h),
    };
  }, [crop, naturalSize]);

  const run = async () => {
    if (phase.kind !== "ready" || !cropPixels) return;
    const info = phase.info;
    const ext = fileExt(info.path) || "mp4";
    const outputPath = safeOutputPath(info.path, "crop", ext, outputDir);
    const jobId = newJobId();
    setPhase({ kind: "processing", info, jobId });
    try {
      const produced = await invoke<string>("crop_video", {
        jobId,
        inputPath: info.path,
        outputPath,
        cropX: cropPixels.x,
        cropY: cropPixels.y,
        cropWidth: cropPixels.w,
        cropHeight: cropPixels.h,
      });
      const finalInfo = await loadVideo(produced);
      addHistory({
        kind: "convert",
        sourcePath: info.path,
        sourceFileName: info.fileName,
        outputPath: produced,
        outputFileName: baseName(produced),
        durationSeconds: info.durationSeconds ?? 0,
        videoSummary: `Recadré ${cropPixels.w}×${cropPixels.h}`,
        outputSizeBytes: finalInfo?.sizeBytes ?? 0,
      });
      setPhase({ kind: "done", info, output: produced });
      showToast("Vidéo recadrée");
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    }
  };

  return (
    <div className="tool-page">
      <header className="page__header">
        <h1>Recadrer</h1>
      </header>
      <p className="page__intro">
        Sélectionne la zone à conserver. Drag dans la zone pour la
        déplacer, drag les coins pour la redimensionner. Choisis un ratio
        préset ou laisse libre.
      </p>

      <section className="stage">
        {phase.kind === "idle" && (
          <VideoDropZone
            hovering={hovering}
            onPick={onPick}
            title="Glisser une vidéo à recadrer"
            hint="ou clique pour la choisir"
          />
        )}

        {phase.kind === "loading" && (
          <div className="filecard filecard--loading">
            <div className="filecard__body">
              <div className="filecard__name">Lecture des infos…</div>
            </div>
          </div>
        )}

        {phase.kind === "ready" && (
          <>
            <VideoInfoCard info={phase.info} />
            <CropOverlay
              videoSrc={convertFileSrc(phase.info.path)}
              videoRef={videoRef}
              crop={crop}
              onChange={(c) => {
                setCrop(c);
                // Si on drag manuellement après un ratio préset, on bascule
                // en "libre" pour éviter d'écraser la sélection au prochain
                // re-render.
                if (ratioId !== "free") setRatioId("free");
              }}
              lockRatio={activeRatio}
            />
            <div className="crop-controls">
              <span className="effects__label">Ratio</span>
              <div className="crop-controls__chips">
                {CROP_RATIOS.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={`preset-chip ${
                      ratioId === r.id ? "preset-chip--active" : ""
                    }`}
                    onClick={() => applyRatio(r.id)}
                  >
                    {r.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="linkbtn linkbtn--muted"
                  onClick={resetCrop}
                >
                  Réinitialiser
                </button>
              </div>
            </div>
            {cropPixels && naturalSize && (
              <div className="crop-summary">
                <span>
                  Zone&nbsp;: <strong>{cropPixels.w} × {cropPixels.h} px</strong>
                </span>
                <span>
                  Position&nbsp;: ({cropPixels.x}, {cropPixels.y})
                </span>
                <span>
                  Source&nbsp;: {naturalSize.w} × {naturalSize.h}
                </span>
              </div>
            )}
            <OutputDirField
              value={outputDir}
              onPick={pickOutputDir}
              onReset={resetOutputDir}
            />
          </>
        )}

        {phase.kind === "processing" && (
          <>
            <VideoInfoCard info={phase.info} />
            <div className="extracting-block">
              <div className="filecard__meta">Recadrage…</div>
              <ProgressBar percent={percent ?? 0} />
            </div>
          </>
        )}

        {phase.kind === "done" && (
          <>
            <div className="filecard">
              <div className="filecard__icon" aria-hidden>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="filecard__body">
                <div className="filecard__name">{baseName(phase.output)}</div>
                <div className="filecard__meta">Vidéo recadrée</div>
              </div>
            </div>
            <video
              src={convertFileSrc(phase.output)}
              controls
              className="editor__video"
              preload="metadata"
            />
          </>
        )}

        {phase.kind === "error" && <div className="errorcard">{phase.message}</div>}
      </section>

      <footer className="footer">
        <div className="actions">
          {phase.kind === "ready" && (
            <>
              <button className="btn btn--ghost" onClick={reset}>Annuler</button>
              <button
                className="btn"
                onClick={run}
                disabled={!cropPixels || cropPixels.w < 16 || cropPixels.h < 16}
              >
                Recadrer
              </button>
            </>
          )}
          {phase.kind === "processing" && (
            <button className="btn" disabled>
              {percent != null ? `${Math.round(percent)} %` : "Encodage…"}
            </button>
          )}
          {phase.kind === "done" && (
            <>
              <button className="btn btn--ghost" onClick={() => reveal(phase.output)}>
                Afficher dans le Finder
              </button>
              <button className="btn" onClick={reset}>Nouvelle vidéo</button>
            </>
          )}
          {phase.kind === "error" && (
            <button className="btn btn--ghost" onClick={reset}>Réessayer</button>
          )}
        </div>
      </footer>
    </div>
  );
}

// Composant overlay de recadrage : vidéo + rectangle de sélection avec
// 4 poignées de coin et corps draggable. Les masques sombres recouvrent
// les zones rognées pour visualiser le résultat.
//
// `lockRatio` = null → resize libre. Sinon, on contraint W/H au ratio.
function CropOverlay({
  videoSrc,
  videoRef,
  crop,
  onChange,
  lockRatio,
}: {
  videoSrc: string;
  videoRef: React.RefObject<HTMLVideoElement>;
  crop: CropRect;
  onChange: (rect: CropRect) => void;
  lockRatio: number | null;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Convertit la position du pointeur en fraction (0-1) du wrapper.
  const pointToFrac = (clientX: number, clientY: number) => {
    const el = wrapperRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    };
  };

  // Drag du body : déplace x/y en conservant w/h. On stocke la position
  // initiale et l'offset entre le clic et le coin top-left au pointerdown.
  type DragMode = "body" | "tl" | "tr" | "bl" | "br" | "t" | "r" | "b" | "l";
  const dragState = useRef<{
    mode: DragMode;
    startX: number;
    startY: number;
    initial: CropRect;
  } | null>(null);

  const onPointerDown = (mode: DragMode) =>
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const p = pointToFrac(e.clientX, e.clientY);
      dragState.current = {
        mode,
        startX: p.x,
        startY: p.y,
        initial: { ...crop },
      };
    };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current || e.buttons !== 1) return;
    const p = pointToFrac(e.clientX, e.clientY);
    const dx = p.x - dragState.current.startX;
    const dy = p.y - dragState.current.startY;
    const init = dragState.current.initial;
    const mode = dragState.current.mode;

    if (mode === "body") {
      const nx = Math.max(0, Math.min(1 - init.w, init.x + dx));
      const ny = Math.max(0, Math.min(1 - init.h, init.y + dy));
      onChange({ x: nx, y: ny, w: init.w, h: init.h });
      return;
    }

    // Resize : on calcule les nouvelles bornes selon la poignée manipulée.
    // - Poignées de coin : ajustent les deux dimensions
    // - Poignées de bord : n'ajustent qu'une seule dimension (l'autre
    //   reste figée), sauf si lockRatio est actif (alors l'autre suit
    //   proportionnellement)
    let nx = init.x;
    let ny = init.y;
    let nw = init.w;
    let nh = init.h;
    const MIN = 0.05;

    // Poignées qui touchent au bord haut
    if (mode === "tl" || mode === "t" || mode === "tr") {
      ny = Math.min(init.y + init.h - MIN, Math.max(0, init.y + dy));
      nh = init.y + init.h - ny;
    }
    // Poignées qui touchent au bord bas
    if (mode === "bl" || mode === "b" || mode === "br") {
      nh = Math.max(MIN, Math.min(1 - init.y, init.h + dy));
    }
    // Poignées qui touchent au bord gauche
    if (mode === "tl" || mode === "l" || mode === "bl") {
      nx = Math.min(init.x + init.w - MIN, Math.max(0, init.x + dx));
      nw = init.x + init.w - nx;
    }
    // Poignées qui touchent au bord droit
    if (mode === "tr" || mode === "r" || mode === "br") {
      nw = Math.max(MIN, Math.min(1 - init.x, init.w + dx));
    }

    // Si un ratio est verrouillé, on ajuste la dimension non-pilotée.
    // Le wrapper a le même ratio d'aspect que la vidéo (object-fit
    // contain mais on est sur du width:100% donc height auto = ratio
    // vidéo). On convertit donc le ratio cible en ratio de fractions.
    if (lockRatio != null) {
      const wrapperRect = wrapperRef.current?.getBoundingClientRect();
      if (wrapperRect && wrapperRect.height > 0) {
        const wrapperRatio = wrapperRect.width / wrapperRect.height;
        const fracRatio = lockRatio / wrapperRatio;

        // Pour les poignées qui modifient principalement la hauteur
        // (top/bottom seuls), on ajuste la largeur autour du centre X.
        if (mode === "t" || mode === "b") {
          const cx = init.x + init.w / 2;
          nw = nh * fracRatio;
          nx = cx - nw / 2;
        } else if (mode === "l" || mode === "r") {
          // Largeur modifiée : hauteur ajustée autour du centre Y.
          const cy = init.y + init.h / 2;
          nh = nw / fracRatio;
          ny = cy - nh / 2;
        } else if (mode === "tl" || mode === "bl") {
          // Coins gauche : on ajuste la largeur d'après la hauteur,
          // bord droit fixe.
          nw = nh * fracRatio;
          nx = init.x + init.w - nw;
        } else if (mode === "tr" || mode === "br") {
          // Coins droit : on ajuste la hauteur d'après la largeur,
          // bord gauche fixe ; le top/bottom suit selon le coin.
          nh = nw / fracRatio;
          if (mode === "tr") ny = init.y + init.h - nh;
        }
        // Re-clamp final aux bornes pour éviter le débordement.
        nx = Math.max(0, Math.min(1 - MIN, nx));
        ny = Math.max(0, Math.min(1 - MIN, ny));
        nw = Math.max(MIN, Math.min(1 - nx, nw));
        nh = Math.max(MIN, Math.min(1 - ny, nh));
      }
    }

    onChange({ x: nx, y: ny, w: nw, h: nh });
  };

  const left = `${crop.x * 100}%`;
  const top = `${crop.y * 100}%`;
  const width = `${crop.w * 100}%`;
  const height = `${crop.h * 100}%`;

  return (
    <>
      <div className="crop-overlay" ref={wrapperRef}>
        <video
          ref={videoRef}
          src={videoSrc}
          preload="metadata"
          className="crop-overlay__video"
        />
        {/* Masques sombres autour de la zone retenue */}
        <div className="crop-mask crop-mask--top" style={{ height: top }} />
        <div
          className="crop-mask crop-mask--bottom"
          style={{ top: `calc(${top} + ${height})`, height: `calc(100% - ${top} - ${height})` }}
        />
        <div
          className="crop-mask crop-mask--left"
          style={{ top, left: 0, width: left, height }}
        />
        <div
          className="crop-mask crop-mask--right"
          style={{
            top,
            left: `calc(${left} + ${width})`,
            width: `calc(100% - ${left} - ${width})`,
            height,
          }}
        />
        {/* Zone draggable (sélection) + grille de tiers + 8 poignées */}
        <div
          className="crop-box"
          style={{ left, top, width, height }}
          onPointerDown={onPointerDown("body")}
          onPointerMove={onPointerMove}
        >
          <div className="crop-box__grid" aria-hidden>
            <div /><div /><div /><div />
          </div>
          {/* Poignées de bord (rectangles étirés sur chaque côté). */}
          <div
            className="crop-edge crop-edge--t"
            onPointerDown={onPointerDown("t")}
            onPointerMove={onPointerMove}
          />
          <div
            className="crop-edge crop-edge--r"
            onPointerDown={onPointerDown("r")}
            onPointerMove={onPointerMove}
          />
          <div
            className="crop-edge crop-edge--b"
            onPointerDown={onPointerDown("b")}
            onPointerMove={onPointerMove}
          />
          <div
            className="crop-edge crop-edge--l"
            onPointerDown={onPointerDown("l")}
            onPointerMove={onPointerMove}
          />
          {/* Poignées de coin (carrés visibles, par-dessus les edges). */}
          <div
            className="crop-handle crop-handle--tl"
            onPointerDown={onPointerDown("tl")}
            onPointerMove={onPointerMove}
          />
          <div
            className="crop-handle crop-handle--tr"
            onPointerDown={onPointerDown("tr")}
            onPointerMove={onPointerMove}
          />
          <div
            className="crop-handle crop-handle--bl"
            onPointerDown={onPointerDown("bl")}
            onPointerMove={onPointerMove}
          />
          <div
            className="crop-handle crop-handle--br"
            onPointerDown={onPointerDown("br")}
            onPointerMove={onPointerMove}
          />
        </div>
      </div>
      <CropPlayerBar videoRef={videoRef} />
    </>
  );
}

// Barre de contrôles vidéo custom pour la vue Recadrer.
//
// Le <video controls> natif placerait ses contrôles AU-DESSUS de l'overlay
// de crop, donc les clics atterriraient sur la box au lieu du bouton play.
// On utilise donc un <video> sans controls, et on pilote la lecture depuis
// cette barre placée SOUS l'overlay (hors de la zone de drag).
function CropPlayerBar({
  videoRef,
}: {
  videoRef: React.RefObject<HTMLVideoElement>;
}) {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => setCurrentTime(el.currentTime);
    const onMeta = () => setDuration(el.duration || 0);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    if (el.readyState >= 1) onMeta();
    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
    };
  }, [videoRef]);

  const toggle = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  };

  const seek = (t: number) => {
    if (videoRef.current && isFinite(t)) videoRef.current.currentTime = t;
  };

  return (
    <div className="crop-player">
      <button
        type="button"
        className="crop-player__play"
        onClick={toggle}
        aria-label={playing ? "Pause" : "Lire"}
      >
        {playing ? (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <input
        type="range"
        className="crop-player__scrubber"
        min={0}
        max={duration || 0}
        step={0.05}
        value={currentTime}
        onChange={(e) => seek(parseFloat(e.target.value))}
      />
      <span className="crop-player__time">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>
    </div>
  );
}

// =============================================================
// VITESSE (slow-mo / fast-forward)
// =============================================================

// Presets de vitesse. La plage retenue est 0.25× à 4× : au-delà, l'audio
// devient inintelligible et la vidéo perd beaucoup en intérêt pratique.
const SPEED_PRESETS: { value: number; label: string }[] = [
  { value: 0.25, label: "0.25×" },
  { value: 0.5, label: "0.5×" },
  { value: 0.75, label: "0.75×" },
  { value: 1, label: "1×" },
  { value: 1.5, label: "1.5×" },
  { value: 2, label: "2×" },
  { value: 3, label: "3×" },
  { value: 4, label: "4×" },
];

type SpeedPhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; info: VideoInfo }
  | { kind: "processing"; info: VideoInfo; jobId: string }
  | { kind: "done"; info: VideoInfo; output: string }
  | { kind: "error"; message: string };

export function SpeedView({
  active,
  reveal,
  showToast,
  addHistory,
}: {
  active: boolean;
  reveal: (path: string) => void;
  showToast: ToastFn;
  addHistory: AddHistoryFn;
}) {
  const [phase, setPhase] = useState<SpeedPhase>({ kind: "idle" });
  const [speed, setSpeed] = useState<number>(2);
  const [keepAudio, setKeepAudio] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const loadVideo = useLoadVideo();
  const [outputDir, pickOutputDir, resetOutputDir] = useVideoOutputDir();

  const currentJobId = phase.kind === "processing" ? phase.jobId : null;
  const percent = useVideoProgress(currentJobId);

  const handleSingle = useCallback(
    async (path: string) => {
      setPhase({ kind: "loading" });
      const info = await loadVideo(path);
      if (!info) {
        setPhase({ kind: "error", message: "Impossible de lire la vidéo." });
        return;
      }
      setSpeed(2);
      setKeepAudio(true);
      setPhase({ kind: "ready", info });
    },
    [loadVideo],
  );

  // Preview live : on applique speed à playbackRate du lecteur HTML5.
  // Le browser ne supporte généralement que 0.25 à 4×, ce qui matche
  // notre plage côté ffmpeg.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || phase.kind !== "ready") return;
    el.playbackRate = speed;
    // Si keepAudio=false en preview, on coupe le son pour reproduire
    // visuellement le résultat attendu.
    el.muted = !keepAudio;
  }, [speed, keepAudio, phase.kind]);

  const hovering = useVideoDrop(active, handleSingle);
  const onPick = async () => {
    const paths = await pickVideo(false);
    if (paths && paths.length > 0) void handleSingle(paths[0]);
  };
  const reset = () => setPhase({ kind: "idle" });

  const run = async () => {
    if (phase.kind !== "ready") return;
    if (speed === 1) {
      showToast("Choisis une vitesse différente de 1×", "info");
      return;
    }
    const info = phase.info;
    const ext = fileExt(info.path) || "mp4";
    const speedTag = speed.toString().replace(".", "-");
    const outputPath = safeOutputPath(info.path, `${speedTag}x`, ext, outputDir);
    const jobId = newJobId();
    setPhase({ kind: "processing", info, jobId });
    try {
      const produced = await invoke<string>("change_speed", {
        jobId,
        inputPath: info.path,
        outputPath,
        speed,
        keepAudio,
      });
      const finalInfo = await loadVideo(produced);
      const newDuration = (info.durationSeconds ?? 0) / speed;
      addHistory({
        kind: "convert",
        sourcePath: info.path,
        sourceFileName: info.fileName,
        outputPath: produced,
        outputFileName: baseName(produced),
        durationSeconds: newDuration,
        videoSummary: `${speed}×${keepAudio ? "" : " · muet"} · durée ${formatTime(newDuration)}`,
        outputSizeBytes: finalInfo?.sizeBytes ?? 0,
      });
      setPhase({ kind: "done", info, output: produced });
      showToast(`Vidéo en ${speed}× créée`);
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    }
  };

  const duration = phase.kind === "ready" ? phase.info.durationSeconds ?? 0 : 0;
  const newDuration = duration / speed;

  return (
    <div className="tool-page">
      <header className="page__header">
        <h1>Vitesse</h1>
      </header>
      <p className="page__intro">
        Ralentit ou accélère une vidéo. L'aperçu est appliqué en direct
        via le lecteur. Le pitch audio est préservé (la voix ne devient
        pas chipmunk).
      </p>

      <section className="stage">
        {phase.kind === "idle" && (
          <VideoDropZone
            hovering={hovering}
            onPick={onPick}
            title="Glisser une vidéo"
            hint="ou clique pour la choisir"
          />
        )}

        {phase.kind === "loading" && (
          <div className="filecard filecard--loading">
            <div className="filecard__body">
              <div className="filecard__name">Lecture des infos…</div>
            </div>
          </div>
        )}

        {phase.kind === "ready" && (
          <>
            <VideoInfoCard info={phase.info} />
            <video
              ref={videoRef}
              src={convertFileSrc(phase.info.path)}
              controls
              className="editor__video"
              preload="metadata"
            />
            <div className="speed-presets">
              <span className="effects__label">Vitesse</span>
              <div className="speed-presets__chips">
                {SPEED_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    className={`preset-chip ${
                      Math.abs(speed - p.value) < 0.001 ? "preset-chip--active" : ""
                    }`}
                    onClick={() => setSpeed(p.value)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="gif-trim-toggle">
              <input
                type="checkbox"
                checked={keepAudio}
                onChange={(e) => setKeepAudio(e.target.checked)}
              />
              <span>Conserver l'audio</span>
            </label>
            <div className="size-estimate">
              <span className="size-estimate__label">Durée</span>
              <span className="size-estimate__values">
                {formatTime(duration)} → <strong>{formatTime(newDuration)}</strong>
              </span>
            </div>
            {speed >= 3 && keepAudio && (
              <p className="page__empty-hint" style={{ marginTop: "-4px" }}>
                Astuce : à {speed}× l'audio devient peu intelligible.
                Décoche <em>Conserver l'audio</em> pour une sortie muette.
              </p>
            )}
            <OutputDirField
              value={outputDir}
              onPick={pickOutputDir}
              onReset={resetOutputDir}
            />
          </>
        )}

        {phase.kind === "processing" && (
          <>
            <VideoInfoCard info={phase.info} />
            <div className="extracting-block">
              <div className="filecard__meta">
                Encodage à {speed}×…
              </div>
              <ProgressBar percent={percent ?? 0} />
            </div>
          </>
        )}

        {phase.kind === "done" && (
          <>
            <div className="filecard">
              <div className="filecard__icon" aria-hidden>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="filecard__body">
                <div className="filecard__name">{baseName(phase.output)}</div>
                <div className="filecard__meta">
                  Vidéo en {speed}× · durée {formatTime(newDuration)}
                </div>
              </div>
            </div>
            <video
              src={convertFileSrc(phase.output)}
              controls
              className="editor__video"
              preload="metadata"
            />
          </>
        )}

        {phase.kind === "error" && <div className="errorcard">{phase.message}</div>}
      </section>

      <footer className="footer">
        <div className="actions">
          {phase.kind === "ready" && (
            <>
              <button className="btn btn--ghost" onClick={reset}>Annuler</button>
              <button className="btn" onClick={run} disabled={speed === 1}>
                {speed === 1 ? "Choisis une autre vitesse" : `Appliquer ${speed}×`}
              </button>
            </>
          )}
          {phase.kind === "processing" && (
            <button className="btn" disabled>
              {percent != null ? `${Math.round(percent)} %` : "Encodage…"}
            </button>
          )}
          {phase.kind === "done" && (
            <>
              <button className="btn btn--ghost" onClick={() => reveal(phase.output)}>
                Afficher dans le Finder
              </button>
              <button className="btn" onClick={reset}>Nouvelle vidéo</button>
            </>
          )}
          {phase.kind === "error" && (
            <button className="btn btn--ghost" onClick={reset}>Réessayer</button>
          )}
        </div>
      </footer>
    </div>
  );
}

// =============================================================
// TÉLÉCHARGEUR (yt-dlp)
// =============================================================

type DownloadInfo = {
  title: string;
  uploader: string | null;
  durationSeconds: number | null;
  thumbnail: string | null;
  webpageUrl: string | null;
  extractor: string | null;
};

type DownloadProgress = {
  percent: number;
  speed: string | null;
  eta: string | null;
};

// Hook dédié au téléchargeur. Filtre `download-progress` (différent de
// `video-progress` car porte aussi speed + eta) par jobId.
function useDownloadProgress(jobId: string | null): DownloadProgress {
  const [progress, setProgress] = useState<DownloadProgress>({
    percent: 0,
    speed: null,
    eta: null,
  });
  useEffect(() => {
    setProgress({ percent: 0, speed: null, eta: null });
    if (!jobId) return;
    const unlistenPromise = listen<{
      jobId: string;
      percent: number;
      speed: string | null;
      eta: string | null;
    }>("download-progress", (e) => {
      if (e.payload.jobId === jobId) {
        setProgress({
          percent: e.payload.percent,
          speed: e.payload.speed,
          eta: e.payload.eta,
        });
      }
    });
    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, [jobId]);
  return progress;
}

type DownloadResult = {
  outputPath: string;
  sizeBytes: number;
};

type DownloadMode = "video" | "audio";

type DownloadPhase =
  | { kind: "idle" }
  | { kind: "analyzing" }
  | { kind: "ready"; info: DownloadInfo; url: string }
  | { kind: "downloading"; info: DownloadInfo; url: string; jobId: string }
  | { kind: "done"; info: DownloadInfo; output: string }
  | { kind: "error"; message: string };

const DOWNLOAD_RES_OPTIONS: { value: string; label: string }[] = [
  { value: "best", label: "Meilleure" },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
  { value: "480", label: "480p" },
  { value: "360", label: "360p" },
];

const DOWNLOAD_AUDIO_FORMATS: { value: string; label: string }[] = [
  { value: "mp3", label: "MP3" },
  { value: "m4a", label: "M4A (AAC)" },
];

// Navigateurs depuis lesquels yt-dlp peut lire les cookies pour
// s'authentifier auprès de YouTube/TikTok/etc. "none" = pas de cookies.
const BROWSER_COOKIES_OPTIONS: { value: string; label: string }[] = [
  { value: "none", label: "Aucun" },
  { value: "safari", label: "Safari" },
  { value: "chrome", label: "Chrome" },
  { value: "firefox", label: "Firefox" },
  { value: "brave", label: "Brave" },
  { value: "edge", label: "Edge" },
];

export function DownloadView({
  reveal,
  showToast,
  addHistory,
}: {
  reveal: (path: string) => void;
  showToast: ToastFn;
  addHistory: AddHistoryFn;
}) {
  const [phase, setPhase] = useState<DownloadPhase>({ kind: "idle" });
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<DownloadMode>("video");
  const [resolution, setResolution] = useState<string>("best");
  const [audioFormat, setAudioFormat] = useState<string>("mp3");
  const [outputDir, setOutputDir] = useState<string | null>(
    () => localStorage.getItem("downloadDir") || null,
  );
  // Navigateur source des cookies pour l'auth yt-dlp. Persisté pour ne
  // pas avoir à re-sélectionner à chaque session.
  const [browserCookies, setBrowserCookies] = useState<string>(
    () => localStorage.getItem("downloadBrowserCookies") || "none",
  );
  // État du binaire yt-dlp : null = pas encore vérifié, string = version
  // détectée, false = absent (on bloque la vue avec un guide d'install).
  const [ytdlpStatus, setYtdlpStatus] = useState<string | null | false>(null);

  const currentJobId = phase.kind === "downloading" ? phase.jobId : null;
  const dlProgress = useDownloadProgress(currentJobId);
  const percent = dlProgress.percent;

  useEffect(() => {
    invoke<string>("ytdlp_version")
      .then((v) => setYtdlpStatus(v))
      .catch(() => setYtdlpStatus(false));
  }, []);

  useEffect(() => {
    if (outputDir) localStorage.setItem("downloadDir", outputDir);
    else localStorage.removeItem("downloadDir");
  }, [outputDir]);
  useEffect(() => {
    localStorage.setItem("downloadBrowserCookies", browserCookies);
  }, [browserCookies]);

  const pickOutputDir = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") setOutputDir(dir);
  };

  const analyze = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setPhase({ kind: "analyzing" });
    try {
      const info = await invoke<DownloadInfo>("ytdlp_info", {
        url: trimmed,
        browserCookies: browserCookies === "none" ? null : browserCookies,
      });
      setPhase({ kind: "ready", info, url: trimmed });
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    }
  };

  const download = async () => {
    if (phase.kind !== "ready") return;
    if (!outputDir) {
      showToast("Choisis d'abord un dossier de destination", "error");
      return;
    }
    const jobId = newJobId();
    setPhase({ kind: "downloading", info: phase.info, url: phase.url, jobId });
    try {
      const result = await invoke<DownloadResult>("ytdlp_download", {
        jobId,
        url: phase.url,
        outputDir,
        mode,
        maxHeight:
          mode === "video" && resolution !== "best"
            ? parseInt(resolution, 10)
            : null,
        audioFormat: mode === "audio" ? audioFormat : null,
        browserCookies: browserCookies === "none" ? null : browserCookies,
      });
      addHistory({
        kind: "convert",
        sourcePath: phase.url,
        sourceFileName: phase.info.title,
        outputPath: result.outputPath,
        outputFileName: baseName(result.outputPath),
        durationSeconds: phase.info.durationSeconds ?? 0,
        videoSummary:
          mode === "video"
            ? `Téléchargé ${resolution === "best" ? "qualité max" : resolution + "p"}`
            : `Audio extrait en ${audioFormat.toUpperCase()}`,
        outputSizeBytes: result.sizeBytes,
      });
      setPhase({ kind: "done", info: phase.info, output: result.outputPath });
      showToast("Téléchargement terminé");
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    }
  };

  const reset = () => {
    setPhase({ kind: "idle" });
    setUrl("");
  };

  // yt-dlp absent → guide d'installation.
  if (ytdlpStatus === false) {
    return (
      <div className="tool-page">
        <header className="page__header">
          <h1>Télécharger</h1>
        </header>
        <div className="ytdlp-missing">
          <h2>yt-dlp est requis</h2>
          <p>
            Cette fonctionnalité utilise le binaire <strong>yt-dlp</strong>{" "}
            (~25 Mo, open source) qui n'est pas livré avec Media Studio.
            Installe-le avec ces commandes dans le Terminal :
          </p>
          <pre className="ytdlp-missing__code">{`cd ~/Desktop/Dev/projetAppAudio/src-tauri/binaries
curl -L -o yt-dlp-aarch64-apple-darwin \\
  https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos
chmod +x yt-dlp-aarch64-apple-darwin`}</pre>
          <p className="page__empty-hint">
            Puis redémarre Media Studio.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="tool-page">
      <header className="page__header">
        <h1>Télécharger une vidéo</h1>
      </header>
      <p className="page__intro">
        Colle un lien YouTube, TikTok, Twitter, Instagram, Vimeo…
        Media Studio télécharge en vidéo ou en audio extrait.
        {ytdlpStatus && typeof ytdlpStatus === "string" && (
          <> · <span style={{ opacity: 0.6 }}>yt-dlp {ytdlpStatus}</span></>
        )}
      </p>

      <section className="stage">
        {(phase.kind === "idle" || phase.kind === "analyzing") && (
          <>
            <div className="dl-input">
              <input
                type="text"
                className="dl-input__field"
                placeholder="https://www.youtube.com/watch?v=…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void analyze();
                }}
                autoFocus
                disabled={phase.kind === "analyzing"}
              />
              <button
                className="btn"
                onClick={analyze}
                disabled={phase.kind === "analyzing" || !url.trim()}
              >
                {phase.kind === "analyzing" ? (
                  <span className="btn-spinner-row">
                    <span className="spinner spinner--inline" aria-hidden />
                    Analyse…
                  </span>
                ) : (
                  "Analyser"
                )}
              </button>
            </div>
            <Segmented
              label="Cookies navigateur"
              options={BROWSER_COOKIES_OPTIONS}
              value={browserCookies}
              onChange={setBrowserCookies}
              disabled={phase.kind === "analyzing"}
            />
            <p className="page__empty-hint" style={{ marginTop: "-8px" }}>
              Si YouTube/TikTok refuse de te laisser télécharger ("connexion requise"),
              choisis le navigateur où tu es connecté à ces sites. yt-dlp utilisera
              tes cookies pour s'authentifier.
            </p>
            {phase.kind === "analyzing" && (
              <div className="dl-analyzing">
                <div className="dl-analyzing__thumb shimmer" aria-hidden />
                <div className="dl-analyzing__body">
                  <div className="dl-analyzing__title shimmer" />
                  <div className="dl-analyzing__line shimmer" />
                  <div className="dl-analyzing__hint">
                    Récupération des métadonnées via yt-dlp…
                    <br />
                    <span style={{ opacity: 0.6, fontSize: "11px" }}>
                      Selon la source ça peut prendre 5 à 15 secondes.
                    </span>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {phase.kind === "ready" && (
          <>
            <div className="dl-preview">
              {phase.info.thumbnail && (
                <img
                  src={phase.info.thumbnail}
                  alt=""
                  className="dl-preview__thumb"
                  referrerPolicy="no-referrer"
                />
              )}
              <div className="dl-preview__body">
                <div className="dl-preview__title">{phase.info.title}</div>
                <div className="dl-preview__meta">
                  {phase.info.uploader && <>{phase.info.uploader} · </>}
                  {phase.info.durationSeconds != null &&
                    formatTime(phase.info.durationSeconds)}
                  {phase.info.extractor && <> · {phase.info.extractor}</>}
                </div>
              </div>
              <button className="linkbtn linkbtn--muted" onClick={reset}>
                Changer
              </button>
            </div>
            <div className="options">
              <Segmented
                label="Type"
                options={[
                  { value: "video", label: "Vidéo" },
                  { value: "audio", label: "Audio seul" },
                ]}
                value={mode}
                onChange={(v) => setMode(v as DownloadMode)}
              />
              {mode === "video" ? (
                <Segmented
                  label="Résolution max"
                  options={DOWNLOAD_RES_OPTIONS}
                  value={resolution}
                  onChange={setResolution}
                />
              ) : (
                <Segmented
                  label="Format audio"
                  options={DOWNLOAD_AUDIO_FORMATS}
                  value={audioFormat}
                  onChange={setAudioFormat}
                />
              )}
              <div className="output-location">
                <span className="output-location__label">Dossier</span>
                <span className="output-location__value" title={outputDir ?? ""}>
                  {outputDir ? shortenPathLocal(outputDir) : "Choisir…"}
                </span>
                <button className="linkbtn" onClick={pickOutputDir}>
                  {outputDir ? "Modifier" : "Choisir"}
                </button>
              </div>
            </div>
          </>
        )}

        {phase.kind === "downloading" && (
          <>
            <div className="dl-preview">
              {phase.info.thumbnail && (
                <img
                  src={phase.info.thumbnail}
                  alt=""
                  className="dl-preview__thumb"
                  referrerPolicy="no-referrer"
                />
              )}
              <div className="dl-preview__body">
                <div className="dl-preview__title">{phase.info.title}</div>
                <div className="dl-preview__meta">
                  Téléchargement
                  {dlProgress.speed && <> · {dlProgress.speed}</>}
                  {dlProgress.eta && <> · ETA {dlProgress.eta}</>}
                </div>
              </div>
            </div>
            <ProgressBar percent={percent ?? 0} />
          </>
        )}

        {phase.kind === "done" && (
          <>
            <div className="filecard">
              <div className="filecard__icon" aria-hidden>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="filecard__body">
                <div className="filecard__name">{baseName(phase.output)}</div>
                <div className="filecard__meta">Téléchargement terminé</div>
              </div>
            </div>
            {/\.(mp4|mov|mkv|webm)$/i.test(phase.output) ? (
              <video
                src={convertFileSrc(phase.output)}
                controls
                className="editor__video"
                preload="metadata"
              />
            ) : (
              <audio
                src={convertFileSrc(phase.output)}
                controls
                preload="metadata"
                className="output-player"
              />
            )}
          </>
        )}

        {phase.kind === "error" && <div className="errorcard">{phase.message}</div>}
      </section>

      <footer className="footer">
        <div className="actions">
          {phase.kind === "ready" && (
            <>
              <button className="btn btn--ghost" onClick={reset}>Annuler</button>
              <button className="btn" onClick={download} disabled={!outputDir}>
                {outputDir ? "Télécharger" : "Choisir un dossier"}
              </button>
            </>
          )}
          {phase.kind === "downloading" && (
            <button className="btn" disabled>
              {`${Math.round(percent)} %`}
              {dlProgress.speed && ` · ${dlProgress.speed}`}
            </button>
          )}
          {phase.kind === "done" && (
            <>
              <button className="btn btn--ghost" onClick={() => reveal(phase.output)}>
                Afficher dans le Finder
              </button>
              <button className="btn" onClick={reset}>
                Nouveau téléchargement
              </button>
            </>
          )}
          {phase.kind === "error" && (
            <button className="btn btn--ghost" onClick={reset}>Réessayer</button>
          )}
        </div>
      </footer>
    </div>
  );
}


