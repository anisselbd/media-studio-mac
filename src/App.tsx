import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  ConvertView,
  CompressView,
  TrimView,
  MergeView,
  ToGifView,
  FrameExtractView,
  TransformView,
  CropView,
  SpeedView,
  DownloadView,
} from "./VideoViews";

type MediaInfo = {
  path: string;
  fileName: string;
  durationSeconds: number | null;
};

type Format = "mp3" | "aac" | "wav";
type Bitrate = "128k" | "192k" | "256k" | "320k";

type BatchJob = {
  id: string;
  path: string;
  fileName: string;
  durationSeconds: number | null;
  status: "queued" | "processing" | "done" | "error";
  percent: number | null;
  outputPath: string | null;
  error: string | null;
};

type Status =
  | { kind: "idle" }
  | { kind: "loading"; path: string }
  | { kind: "ready"; info: MediaInfo; waveformPath: string | null }
  | { kind: "extracting"; info: MediaInfo; percent: number | null }
  | { kind: "done"; info: MediaInfo; output: string }
  | { kind: "error"; message: string }
  | { kind: "batch" };

// Un préréglage = combinaison nommée des paramètres d'extraction.
// Les built-in ne sont pas modifiables, les user-defined sont en localStorage.
type Preset = {
  id: string;
  name: string;
  builtin?: boolean;
  format: Format;
  bitrate: Bitrate;
  normalize: boolean;
  fadeIn: boolean;
  fadeOut: boolean;
  embedThumbnail: boolean;
};

type View =
  | "extract"
  | "convert"
  | "compress"
  | "trim"
  | "merge"
  | "transform"
  | "crop"
  | "speed"
  | "togif"
  | "frame"
  | "download"
  | "history"
  | "presets"
  | "settings";
type ThemePref = "light" | "dark" | "system";
type Toast = { id: string; message: string; kind: "success" | "info" | "error" };

// Type d'opération qui a produit l'entrée. "audio" = extraction (legacy
// par défaut pour les entrées existantes sans `kind`). Les opérations
// vidéo (Vague 1) ont leur propre kind pour qu'on puisse les afficher
// différemment dans HistoryView.
type HistoryKind = "audio" | "compress" | "convert" | "trim" | "merge";

type HistoryEntry = {
  id: string;
  timestamp: number;
  kind: HistoryKind;
  sourcePath: string;
  sourceFileName: string;
  outputPath: string;
  outputFileName: string;
  durationSeconds: number;
  // Spécifique audio (kind="audio")
  format?: Format;
  bitrate?: Bitrate | null;
  trimStart?: number | null;
  trimEnd?: number | null;
  // Spécifique vidéo : résumé textuel des paramètres ("480p · 600 kbps ·
  // audio 96k") + taille du fichier produit (pour afficher le gain).
  videoSummary?: string;
  outputSizeBytes?: number;
};

// Entrée minimale à fournir pour une opération vidéo. App.tsx fabrique le
// reste (id, timestamp, kind). Type exporté pour VideoViews.tsx.
export type VideoHistoryInput = {
  kind: "compress" | "convert" | "trim" | "merge";
  sourcePath: string;
  sourceFileName: string;
  outputPath: string;
  outputFileName: string;
  durationSeconds: number;
  videoSummary: string;
  outputSizeBytes: number;
};

const VIDEO_EXT = ["mp4", "mov", "mkv", "avi", "webm", "m4v"];
const AUDIO_EXT = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"];
const MEDIA_EXT = [...VIDEO_EXT, ...AUDIO_EXT];
const FORMATS: { value: Format; label: string }[] = [
  { value: "mp3", label: "MP3" },
  { value: "aac", label: "AAC" },
  { value: "wav", label: "WAV" },
];
const BITRATES: Bitrate[] = ["128k", "192k", "256k", "320k"];

const OUTPUT_EXT: Record<Format, string> = {
  mp3: "mp3",
  aac: "m4a",
  wav: "wav",
};

const MIN_TRIM_DURATION = 0.5;
const HISTORY_KEY = "extraction-history";
const HISTORY_LIMIT = 100;
const PRESETS_KEY = "presets-v2";

const BUILTIN_PRESETS: Preset[] = [
  {
    id: "podcast", name: "Podcast", builtin: true,
    format: "mp3", bitrate: "192k",
    normalize: true, fadeIn: true, fadeOut: true, embedThumbnail: false,
  },
  {
    id: "music", name: "Musique HD", builtin: true,
    format: "mp3", bitrate: "320k",
    normalize: false, fadeIn: false, fadeOut: false, embedThumbnail: true,
  },
  {
    id: "voice", name: "Voix mémo", builtin: true,
    format: "aac", bitrate: "128k",
    normalize: true, fadeIn: false, fadeOut: true, embedThumbnail: false,
  },
];

function fileExt(path: string): string {
  return path.toLowerCase().split(".").pop() ?? "";
}
function isMediaFile(path: string): boolean {
  return MEDIA_EXT.includes(fileExt(path));
}
function isAudioOnly(path: string): boolean {
  return AUDIO_EXT.includes(fileExt(path));
}

function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

function stripExtension(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? name : name.slice(0, i);
}

// Calcule un chemin de sortie qui ne soit JAMAIS identique au chemin d'entrée
// (ffmpeg refuse d'écrire sur le fichier en cours de lecture). Ajoute `_extract`
// si nécessaire — typique quand on transcode un MP3 → MP3 dans le même dossier.
function safeOutputPath(inputPath: string, outputDir: string | null, fileName: string, outExt: string): string {
  const base = stripExtension(fileName);
  const dir = outputDir ?? dirName(inputPath);
  const naive = `${dir}/${base}.${outExt}`;
  if (naive !== inputPath) return naive;
  return `${dir}/${base}_extract.${outExt}`;
}

function shortenPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return ".../" + parts.slice(-2).join("/");
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

// Label affiché dans le badge d'un item d'historique. Pour audio, on
// reprend le format (MP3/AAC/WAV). Pour les opérations vidéo, un libellé
// court qui identifie l'action.
function historyKindLabel(e: HistoryEntry): string {
  if (e.kind === "audio") return (e.format ?? "AUDIO").toUpperCase();
  if (e.kind === "compress") return "COMPRESS";
  if (e.kind === "convert") return "CONVERT";
  if (e.kind === "trim") return "TRIM";
  if (e.kind === "merge") return "MERGE";
  return "—";
}

function formatHistoryBytes(bytes: number): string {
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

function formatHistoryDate(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  const time = new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  if (sameDay) return `aujourd'hui à ${time}`;
  if (isYesterday) return `hier à ${time}`;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Migration : les entrées historiques (avant Vague 1) n'ont pas de
    // champ `kind`. On les considère comme des extractions audio.
    return parsed.map((e: HistoryEntry) => ({ ...e, kind: e.kind ?? "audio" }));
  } catch {
    return [];
  }
}

// Charge la liste complète des préréglages. Au premier lancement, on
// l'amorce avec les built-ins ; les modifications utilisateur écrasent
// ensuite ce tableau dans localStorage. La flag `builtin` reste sur les
// entrées d'origine pour permettre le "Réinitialiser à défaut".
function loadAllPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    // ignore — on retombera sur le seed
  }
  // Clone profond des built-ins pour pouvoir muter sans toucher la const.
  return BUILTIN_PRESETS.map((p) => ({ ...p }));
}


// Émet une notification native macOS via une commande Rust qui invoque
// osascript. Plus fiable que le plugin notification en mode dev.
async function notify(title: string, body: string) {
  try {
    await invoke("system_notify", { title, body });
  } catch (e) {
    console.warn("[notify] erreur:", e);
  }
}

function BrandIcon({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <rect width="24" height="24" rx="5.4" fill="currentColor" />
      <rect x="4.6" y="9.25" width="2" height="5.5" rx="1" fill="white" />
      <rect x="7.8" y="7.6" width="2" height="8.8" rx="1" fill="white" />
      <rect x="11" y="8.75" width="2" height="6.5" rx="1" fill="white" />
      <rect x="14.2" y="7.25" width="2" height="9.5" rx="1" fill="white" />
      <rect x="17.4" y="9.5" width="2" height="5" rx="1" fill="white" />
    </svg>
  );
}

function Waveform() {
  return (
    <div className="waveform" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className="waveform__bar" />
      ))}
    </div>
  );
}

function newJobId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default function App() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [hovering, setHovering] = useState(false);

  const [format, setFormat] = useState<Format>(
    () => (localStorage.getItem("format") as Format) || "mp3",
  );
  const [bitrate, setBitrate] = useState<Bitrate>(
    () => (localStorage.getItem("bitrate") as Bitrate) || "192k",
  );
  const [outputDir, setOutputDir] = useState<string | null>(
    () => localStorage.getItem("outputDir") || null,
  );

  // Effets audio post-traitement (persistés).
  const [normalize, setNormalize] = useState<boolean>(
    () => localStorage.getItem("normalize") === "1",
  );
  const [fadeIn, setFadeIn] = useState<boolean>(
    () => localStorage.getItem("fadeIn") === "1",
  );
  const [fadeOut, setFadeOut] = useState<boolean>(
    () => localStorage.getItem("fadeOut") === "1",
  );
  const [embedThumbnail, setEmbedThumbnail] = useState<boolean>(
    () => localStorage.getItem("embedThumbnail") === "1",
  );
  // Son à la fin de l'extraction — activé par défaut.
  const [soundOnComplete, setSoundOnComplete] = useState<boolean>(
    () => localStorage.getItem("soundOnComplete") !== "0",
  );

  // Liste complète des préréglages — modifiables, renommables, supprimables.
  // Les built-ins gardent leur flag pour activer le "Réinitialiser à défaut".
  const [presets, setPresets] = useState<Preset[]>(() => loadAllPresets());

  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);

  // Tags ID3 — pré-remplis depuis le nom de fichier, modifiables avant extraction.
  const [tagTitle, setTagTitle] = useState("");
  const [tagArtist, setTagArtist] = useState("");
  const [tagAlbum, setTagAlbum] = useState("");
  const [tagYear, setTagYear] = useState("");
  const [showMetadata, setShowMetadata] = useState(false);

  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [view, setView] = useState<View>("extract");
  // Une fois passé par "download", on garde DownloadView monté en
  // permanence pour préserver son state (URL analysée, job en cours…)
  // quand l'utilisateur navigue ailleurs et revient.
  const [downloadMounted, setDownloadMounted] = useState(false);
  useEffect(() => {
    if (view === "download") setDownloadMounted(true);
  }, [view]);

  // Toast éphémère — un seul à la fois, auto-dismiss après 3s.
  const [toast, setToast] = useState<Toast | null>(null);
  const showToast = useCallback((message: string, kind: Toast["kind"] = "success") => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    setToast({ id, message, kind });
    setTimeout(() => {
      // Ne pas écraser un toast plus récent qui aurait remplacé celui-ci.
      setToast((t) => (t?.id === id ? null : t));
    }, 2800);
  }, []);

  // Thème : preference utilisateur (Light / Dark / System).
  // En "system" on suit prefers-color-scheme via une MediaQueryList JS.
  const [themePref, setThemePref] = useState<ThemePref>(
    () => (localStorage.getItem("themePref") as ThemePref) || "system",
  );

  // Applique le thème : résout "system" en regardant la pref macOS, puis pose
  // `data-theme="light"|"dark"` sur <html>. Listen aux changements système
  // quand on est en mode "system".
  useEffect(() => {
    localStorage.setItem("themePref", themePref);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const resolve = (): "light" | "dark" => {
      if (themePref === "system") return mq.matches ? "dark" : "light";
      return themePref;
    };
    const apply = () => {
      document.documentElement.setAttribute("data-theme", resolve());
    };
    apply();
    if (themePref === "system") {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [themePref]);

  // Mode batch : liste des jobs + flag "en cours".
  const [batchJobs, setBatchJobs] = useState<BatchJob[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  // ID du job actuellement traité (pour router les events de progression).
  const currentJobIdRef = useRef<string | null>(null);

  useEffect(() => { localStorage.setItem("format", format); }, [format]);
  useEffect(() => { localStorage.setItem("bitrate", bitrate); }, [bitrate]);
  useEffect(() => {
    if (outputDir) localStorage.setItem("outputDir", outputDir);
    else localStorage.removeItem("outputDir");
  }, [outputDir]);
  useEffect(() => { localStorage.setItem("normalize", normalize ? "1" : "0"); }, [normalize]);
  useEffect(() => { localStorage.setItem("fadeIn", fadeIn ? "1" : "0"); }, [fadeIn]);
  useEffect(() => { localStorage.setItem("fadeOut", fadeOut ? "1" : "0"); }, [fadeOut]);
  useEffect(() => { localStorage.setItem("embedThumbnail", embedThumbnail ? "1" : "0"); }, [embedThumbnail]);
  useEffect(() => { localStorage.setItem("soundOnComplete", soundOnComplete ? "1" : "0"); }, [soundOnComplete]);
  useEffect(() => { localStorage.setItem(PRESETS_KEY, JSON.stringify(presets)); }, [presets]);
  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, HISTORY_LIMIT)));
  }, [history]);

  // ===== Presets =====
  // ID du préréglage actuellement "appliqué". Suivi explicite : on le pose
  // au clic sur Appliquer, on le retire dès qu'un paramètre est modifié à la
  // main. Évite l'ambiguïté quand deux préréglages ont les mêmes paramètres.
  const [activePresetId, setActivePresetId] = useState<string | null>(null);

  // Setters "utilisateur" qui invalident le préréglage actif si l'utilisateur
  // touche un paramètre. À utiliser dans l'UI à la place des setters bruts.
  const userSetFormat = useCallback((v: Format) => { setFormat(v); setActivePresetId(null); }, []);
  const userSetBitrate = useCallback((v: Bitrate) => { setBitrate(v); setActivePresetId(null); }, []);
  const userSetNormalize = useCallback((v: boolean) => { setNormalize(v); setActivePresetId(null); }, []);
  const userSetFadeIn = useCallback((v: boolean) => { setFadeIn(v); setActivePresetId(null); }, []);
  const userSetFadeOut = useCallback((v: boolean) => { setFadeOut(v); setActivePresetId(null); }, []);
  const userSetEmbedThumbnail = useCallback((v: boolean) => { setEmbedThumbnail(v); setActivePresetId(null); }, []);

  const applyPreset = (p: Preset) => {
    setFormat(p.format);
    setBitrate(p.bitrate);
    setNormalize(p.normalize);
    setFadeIn(p.fadeIn);
    setFadeOut(p.fadeOut);
    setEmbedThumbnail(p.embedThumbnail);
    setActivePresetId(p.id);
    showToast(`Préréglage « ${p.name} » appliqué`);
  };

  const savePreset = () => {
    const name = prompt("Nom du préréglage :");
    if (!name || !name.trim()) return;
    setPresets((prev) => [
      ...prev,
      {
        id: newJobId(),
        name: name.trim(),
        format, bitrate, normalize, fadeIn, fadeOut, embedThumbnail,
      },
    ]);
    showToast(`Préréglage « ${name.trim()} » créé`);
  };

  const updatePreset = (id: string, changes: Partial<Preset>) => {
    setPresets((prev) => prev.map((p) => (p.id === id ? { ...p, ...changes } : p)));
    showToast("Préréglage enregistré");
  };

  const removePreset = (id: string) => {
    const target = presets.find((p) => p.id === id);
    setPresets((prev) => prev.filter((p) => p.id !== id || p.builtin));
    if (target && !target.builtin) showToast(`« ${target.name} » supprimé`, "info");
  };

  const resetPresetToDefault = (id: string) => {
    const original = BUILTIN_PRESETS.find((p) => p.id === id);
    if (!original) return;
    setPresets((prev) => prev.map((p) => (p.id === id ? { ...original } : p)));
    showToast(`« ${original.name} » réinitialisé`);
  };

  const createBlankPreset = (): string => {
    const id = newJobId();
    const blank: Preset = {
      id,
      name: "Nouveau préréglage",
      format: "mp3",
      bitrate: "192k",
      normalize: false,
      fadeIn: false,
      fadeOut: false,
      embedThumbnail: false,
    };
    setPresets((prev) => [...prev, blank]);
    return id;
  };

  // ===== Auto-trim silence =====
  const autoTrimSilence = async () => {
    if (status.kind !== "ready") return;
    const total = status.info.durationSeconds ?? 0;
    if (total <= 0) return;
    try {
      const range = await invoke<{ trimStart: number; trimEnd: number }>(
        "detect_silence",
        { inputPath: status.info.path, totalDuration: total },
      );
      setTrimStart(range.trimStart);
      setTrimEnd(range.trimEnd);
    } catch (e) {
      console.warn("auto-trim:", e);
      alert(typeof e === "string" ? e : "Détection des silences impossible.");
    }
  };

  const addHistoryEntry = (entry: Omit<HistoryEntry, "id" | "timestamp">) => {
    const full: HistoryEntry = {
      ...entry,
      id: newJobId(),
      timestamp: Date.now(),
    };
    setHistory((h) => [full, ...h].slice(0, HISTORY_LIMIT));
  };

  // Variante pour les vues vidéo : elles fournissent uniquement les champs
  // pertinents pour une opération vidéo, on complète avec id/timestamp.
  const addVideoHistory = useCallback((entry: VideoHistoryInput) => {
    const full: HistoryEntry = {
      ...entry,
      id: newJobId(),
      timestamp: Date.now(),
    };
    setHistory((h) => [full, ...h].slice(0, HISTORY_LIMIT));
  }, []);

  const loadFile = useCallback(async (path: string) => {
    if (!isMediaFile(path)) {
      setStatus({
        kind: "error",
        message: "Format non supporté. Vidéo (.mp4, .mov, .mkv, .avi, .webm, .m4v) ou audio (.mp3, .wav, .m4a, .aac, .flac, .ogg).",
      });
      return;
    }
    setStatus({ kind: "loading", path });
    try {
      const info = await invoke<MediaInfo>("get_media_info", { path });
      const duration = info.durationSeconds ?? 0;
      setTrimStart(0);
      setTrimEnd(duration);
      // Pré-remplit le titre avec le nom de fichier sans extension.
      setTagTitle(stripExtension(info.fileName));
      setTagArtist("");
      setTagAlbum("");
      setTagYear("");
      setStatus({ kind: "ready", info, waveformPath: null });
      try {
        const wf = await invoke<string>("generate_waveform", { inputPath: path });
        setStatus((s) =>
          s.kind === "ready" && s.info.path === path
            ? { ...s, waveformPath: wf }
            : s,
        );
      } catch (e) {
        console.warn("Waveform generation failed:", e);
      }
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  }, []);

  // Charge plusieurs fichiers comme un batch. Filtre les non-vidéos.
  const loadBatch = useCallback(async (paths: string[]) => {
    const valid = paths.filter(isMediaFile);
    if (valid.length === 0) {
      setStatus({
        kind: "error",
        message: "Aucun fichier média dans la sélection.",
      });
      return;
    }
    const jobs: BatchJob[] = valid.map((path) => ({
      id: newJobId(),
      path,
      fileName: baseName(path),
      durationSeconds: null,
      status: "queued",
      percent: null,
      outputPath: null,
      error: null,
    }));
    setBatchJobs(jobs);
    setStatus({ kind: "batch" });

    // Récupère la durée de chaque fichier en arrière-plan (séquentiel pour
    // ne pas saturer ffmpeg si on a 50 fichiers).
    for (const job of jobs) {
      try {
        const info = await invoke<MediaInfo>("get_media_info", { path: job.path });
        setBatchJobs((prev) =>
          prev.map((j) =>
            j.id === job.id ? { ...j, durationSeconds: info.durationSeconds } : j,
          ),
        );
      } catch {
        // get_media_info échoue (ex: pas d'audio) → on marque le job en erreur
        // pour que l'utilisateur sache qu'on ne pourra pas le traiter.
        setBatchJobs((prev) =>
          prev.map((j) =>
            j.id === job.id ? { ...j, status: "error", error: "Pas de piste audio" } : j,
          ),
        );
      }
    }
  }, []);

  // Drop global d'App = SEULEMENT pour la vue "extract". Les vues vidéo ont
  // leur propre listener dans VideoViews.tsx, conditionné à `active`. Sans
  // cette restriction, App intercepterait les drops sur les vues vidéo et
  // basculerait l'utilisateur vers Extraire à chaque drop.
  useEffect(() => {
    if (view !== "extract") return;
    const win = getCurrentWebviewWindow();
    const unlistenPromise = win.onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") {
        setHovering(true);
      } else if (p.type === "leave") {
        setHovering(false);
      } else if (p.type === "drop") {
        setHovering(false);
        if (!p.paths || p.paths.length === 0) return;
        if (p.paths.length === 1) void loadFile(p.paths[0]);
        else void loadBatch(p.paths);
      }
    });
    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, [view, loadFile, loadBatch]);

  // Raccourcis clavier globaux. On ignore quand le focus est dans un champ texte.
  // Le menu macOS gère déjà Cmd+1..8 pour basculer entre les vues — ici on
  // ne gère que Cmd+O (ouvrir), Cmd+E (extraire) et Esc (annuler/revenir).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        if (!(e.metaKey && e.key.toLowerCase() === "o") && e.key !== "Escape") return;
      }
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setView("extract");
        void pickFile();
      } else if (cmd && e.key.toLowerCase() === "e") {
        e.preventDefault();
        if (status.kind === "ready") void extract();
        else if (status.kind === "batch" && !batchRunning) void runBatch();
      } else if (e.key === "Escape") {
        if (view !== "extract") setView("extract");
        else if (status.kind === "ready" || status.kind === "done" || status.kind === "error") reset();
        else if (status.kind === "batch" && !batchRunning) reset();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  // Écoute les events de menu macOS natifs (Affichage > Extraire/Historique/...
  // et Fichier > Ouvrir).
  useEffect(() => {
    const unlistenView = listen<View>("menu:view", (e) => setView(e.payload));
    const unlistenOpen = listen("menu:open_file", () => {
      setView("extract");
      void pickFile();
    });
    return () => {
      unlistenView.then((f) => f());
      unlistenOpen.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<{ percent: number }>("extract-progress", (event) => {
      setStatus((s) =>
        s.kind === "extracting" ? { ...s, percent: event.payload.percent } : s,
      );
      // Route aussi vers le job batch en cours, si applicable.
      const jobId = currentJobIdRef.current;
      if (jobId) {
        setBatchJobs((prev) =>
          prev.map((j) =>
            j.id === jobId ? { ...j, percent: event.payload.percent } : j,
          ),
        );
      }
    });
    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  const pickFile = async () => {
    const selected = await open({
      multiple: true,
      filters: [
        { name: "Vidéo", extensions: VIDEO_EXT },
        { name: "Audio", extensions: AUDIO_EXT },
        { name: "Tous médias", extensions: MEDIA_EXT },
      ],
    });
    if (Array.isArray(selected) && selected.length > 0) {
      if (selected.length === 1) void loadFile(selected[0]);
      else void loadBatch(selected);
    } else if (typeof selected === "string") {
      void loadFile(selected);
    }
  };

  const pickOutputDir = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") setOutputDir(dir);
  };

  // ===== Mode single =====
  const extract = async () => {
    if (status.kind !== "ready") return;
    const info = status.info;
    const duration = info.durationSeconds ?? 0;
    const outputPath = safeOutputPath(info.path, outputDir, info.fileName, OUTPUT_EXT[format]);

    const hasTrim =
      trimStart > 0.05 || (duration > 0 && trimEnd < duration - 0.05);
    const outputDuration = hasTrim ? trimEnd - trimStart : duration;

    setStatus({ kind: "extracting", info, percent: null });
    try {
      const metadata = format === "wav" ? null : {
        title: tagTitle.trim() || null,
        artist: tagArtist.trim() || null,
        album: tagAlbum.trim() || null,
        year: tagYear.trim() || null,
      };
      const produced = await invoke<string>("extract_audio", {
        inputPath: info.path,
        outputPath,
        format,
        bitrate: format === "wav" ? null : bitrate,
        startSeconds: hasTrim ? trimStart : null,
        endSeconds: hasTrim ? trimEnd : null,
        normalize,
        fadeIn,
        fadeOut,
        outputDuration,
        embedThumbnail,
        metadata,
      });
      setStatus({ kind: "done", info, output: produced });
      if (soundOnComplete) void invoke("play_completion_sound");
      addHistoryEntry({
        kind: "audio",
        sourcePath: info.path,
        sourceFileName: info.fileName,
        outputPath: produced,
        outputFileName: baseName(produced),
        format,
        bitrate: format === "wav" ? null : bitrate,
        trimStart: hasTrim ? trimStart : null,
        trimEnd: hasTrim ? trimEnd : null,
        durationSeconds: outputDuration,
      });
      void notify("Extraction terminée", baseName(produced));
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  };

  // ===== Mode batch =====
  const runBatch = async () => {
    if (batchJobs.length === 0 || batchRunning) return;
    setBatchRunning(true);
    let successCount = 0;
    let failureCount = 0;

    // On capture la liste actuelle ; on traite séquentiellement.
    const initialJobs = batchJobs;
    for (const job of initialJobs) {
      if (job.status === "done" || job.status === "error") {
        // Déjà traité (ou erreur de durée) — on saute.
        if (job.status === "error") failureCount++;
        continue;
      }

      currentJobIdRef.current = job.id;
      setBatchJobs((prev) =>
        prev.map((j) => (j.id === job.id ? { ...j, status: "processing", percent: 0 } : j)),
      );

      const duration = job.durationSeconds ?? 0;
      const outputPath = safeOutputPath(job.path, outputDir, job.fileName, OUTPUT_EXT[format]);

      try {
        const produced = await invoke<string>("extract_audio", {
          inputPath: job.path,
          outputPath,
          format,
          bitrate: format === "wav" ? null : bitrate,
          startSeconds: null,
          endSeconds: null,
          normalize,
          fadeIn,
          fadeOut,
          outputDuration: duration,
          embedThumbnail,
          // En batch, on n'écrit pas de tags partagés (ce serait absurde),
          // sauf l'auto-titre dérivé du nom de fichier pour chaque job.
          metadata: format === "wav" ? null : {
            title: stripExtension(job.fileName),
            artist: null,
            album: null,
            year: null,
          },
        });
        successCount++;
        setBatchJobs((prev) =>
          prev.map((j) =>
            j.id === job.id
              ? { ...j, status: "done", outputPath: produced, percent: 100 }
              : j,
          ),
        );
        addHistoryEntry({
          kind: "audio",
          sourcePath: job.path,
          sourceFileName: job.fileName,
          outputPath: produced,
          outputFileName: baseName(produced),
          format,
          bitrate: format === "wav" ? null : bitrate,
          trimStart: null,
          trimEnd: null,
          durationSeconds: duration,
        });
      } catch (e) {
        failureCount++;
        setBatchJobs((prev) =>
          prev.map((j) =>
            j.id === job.id ? { ...j, status: "error", error: String(e) } : j,
          ),
        );
      }
    }
    currentJobIdRef.current = null;
    setBatchRunning(false);

    const total = successCount + failureCount;
    if (failureCount === 0) {
      void notify("Lot terminé", `${successCount} fichier${successCount > 1 ? "s" : ""} extraits.`);
    } else {
      void notify(
        "Lot terminé avec erreurs",
        `${successCount}/${total} réussis, ${failureCount} échec${failureCount > 1 ? "s" : ""}.`,
      );
    }
    if (soundOnComplete) void invoke("play_completion_sound");
  };

  const reveal = async (path: string) => {
    try {
      await invoke("reveal_in_finder", { path });
    } catch (e) {
      console.error(e);
    }
  };

  const reset = () => {
    setStatus({ kind: "idle" });
    setBatchJobs([]);
  };

  const removeBatchJob = (id: string) => {
    setBatchJobs((prev) => prev.filter((j) => j.id !== id));
  };

  const removeHistoryEntry = (id: string) =>
    setHistory((h) => h.filter((e) => e.id !== id));
  const clearHistory = () => {
    if (confirm("Vider tout l'historique ?")) setHistory([]);
  };

  const reuseFromHistory = (entry: HistoryEntry) => {
    setView("extract");
    void loadFile(entry.sourcePath);
  };

  // Réinitialise toutes les préférences en localStorage (utilisé par Réglages).
  const resetAllPreferences = () => {
    if (!confirm("Réinitialiser toutes les préférences (préréglages, historique, options) ?")) return;
    setHistory([]);
    setPresets(BUILTIN_PRESETS.map((p) => ({ ...p })));
    setFormat("mp3");
    setBitrate("192k");
    setOutputDir(null);
    setNormalize(false);
    setFadeIn(false);
    setFadeOut(false);
    setEmbedThumbnail(false);
    setSoundOnComplete(true);
    setThemePref("system");
  };

  // Statistiques pour la sidebar.
  const totalHistorySeconds = useMemo(
    () => history.reduce((s, e) => s + (e.durationSeconds || 0), 0),
    [history],
  );

  // ===== Rendu =====
  const showOptions =
    status.kind === "ready" || (status.kind === "batch" && !batchRunning);

  return (
    <div className="app-shell">
      <Sidebar
        view={view}
        onChange={setView}
        historyCount={history.length}
        totalSeconds={totalHistorySeconds}
      />
      <main className="app-main">
        {view === "extract" && (
          <>
            <header className="page__header">
              <h1>Extraire l'audio</h1>
            </header>
            <p className="page__intro">
              Glisse une vidéo (ou un fichier audio à transcoder) pour en
              extraire la piste son. Choisis le format, applique des effets
              et utilise des préréglages pour aller vite.
            </p>
            <section className="stage">
        {(status.kind === "idle" || status.kind === "error") && (
          <button
            className={`dropzone ${hovering ? "dropzone--hover" : ""}`}
            onClick={pickFile}
            type="button"
          >
            <div className="dropzone__icon" aria-hidden>
              <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 16V4" />
                <path d="m6 10 6-6 6 6" />
                <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
            </div>
            <div className="dropzone__title">Glisser une vidéo ici</div>
            <div className="dropzone__hint">ou plusieurs pour traiter en lot</div>
            <div className="dropzone__formats">MP4 · MOV · MKV · AVI · WEBM · M4V</div>
          </button>
        )}

        {status.kind === "loading" && (
          <div className="filecard filecard--loading">
            <div className="filecard__body">
              <div className="filecard__name">Lecture des infos…</div>
              <div className="filecard__meta">{status.path}</div>
            </div>
          </div>
        )}

        {status.kind === "ready" && (
          <ReadyEditor
            info={status.info}
            waveformPath={status.waveformPath}
            trimStart={trimStart}
            trimEnd={trimEnd}
            onTrimChange={(s, e) => {
              setTrimStart(s);
              setTrimEnd(e);
            }}
            onAutoTrim={autoTrimSilence}
          />
        )}

        {status.kind === "extracting" && (
          <>
            <div className="filecard">
              <div className="filecard__icon" aria-hidden>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="6" width="20" height="12" rx="2" />
                  <path d="m23 7-7 5 7 5V7z" />
                </svg>
              </div>
              <div className="filecard__body">
                <div className="filecard__name">{status.info.fileName}</div>
                <div className="filecard__meta">Extraction en cours…</div>
              </div>
            </div>
            <div className="extracting-block">
              <Waveform />
              {status.percent != null && <ProgressBar percent={status.percent} />}
            </div>
          </>
        )}

        {status.kind === "done" && (
          <>
            <div className="filecard">
              <div className="filecard__icon" aria-hidden>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
              </div>
              <div className="filecard__body">
                <div className="filecard__name">{baseName(status.output)}</div>
                <div className="filecard__meta">Prêt à écouter — extrait de {status.info.fileName}</div>
              </div>
            </div>
            {/* Lecteur inline pour écouter le résultat avant d'aller dans Finder */}
            <audio
              src={convertFileSrc(status.output)}
              controls
              className="output-player"
              preload="metadata"
            />
          </>
        )}

        {status.kind === "batch" && (
          <BatchView
            jobs={batchJobs}
            running={batchRunning}
            onRemove={removeBatchJob}
            onReveal={reveal}
          />
        )}

        {showOptions && (
          <div className="options">
            <div className="presets-row">
              <span className="effects__label">Préréglage</span>
              <div className="presets">
                {presets.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`preset-chip ${activePresetId === p.id ? "preset-chip--active" : ""}`}
                    onClick={() => applyPreset(p)}
                  >
                    <span>{p.name}</span>
                  </button>
                ))}
                {activePresetId === null && (
                  <span className="preset-chip preset-chip--custom">Personnalisé</span>
                )}
                <button
                  type="button"
                  className="preset-chip preset-chip--add"
                  onClick={savePreset}
                  title="Enregistrer la config actuelle"
                >
                  +
                </button>
                <button
                  type="button"
                  className="linkbtn linkbtn--muted"
                  onClick={() => setView("presets")}
                  title="Éditer / créer / supprimer les préréglages"
                >
                  Gérer
                </button>
              </div>
            </div>
            <Segmented
              label="Format"
              options={FORMATS}
              value={format}
              onChange={userSetFormat}
            />
            <Segmented
              label="Qualité"
              options={BITRATES.map((b) => ({ value: b, label: b }))}
              value={bitrate}
              onChange={userSetBitrate}
              disabled={format === "wav"}
            />
            <div className="effects">
              <span className="effects__label">Effets</span>
              <Toggle label="Normaliser" checked={normalize} onChange={userSetNormalize} />
              <Toggle label="Fondu entrée" checked={fadeIn} onChange={userSetFadeIn} />
              <Toggle label="Fondu sortie" checked={fadeOut} onChange={userSetFadeOut} />
              <Toggle
                label="Pochette"
                checked={embedThumbnail}
                onChange={userSetEmbedThumbnail}
                disabled={
                  format === "wav" ||
                  (status.kind === "ready" && isAudioOnly(status.info.path))
                }
              />
              <Toggle label="Son fin" checked={soundOnComplete} onChange={setSoundOnComplete} />
            </div>

            {/* Tags ID3 — uniquement en mode single, format MP3/AAC */}
            {status.kind === "ready" && format !== "wav" && (
              <div className="metadata">
                <button
                  type="button"
                  className="metadata__toggle linkbtn"
                  onClick={() => setShowMetadata((s) => !s)}
                >
                  {showMetadata ? "▾" : "▸"} Métadonnées ID3 (titre, artiste…)
                </button>
                {showMetadata && (
                  <div className="metadata__fields">
                    <label>
                      <span>Titre</span>
                      <input
                        type="text"
                        value={tagTitle}
                        onChange={(e) => setTagTitle(e.target.value)}
                        placeholder="Titre du morceau"
                      />
                    </label>
                    <label>
                      <span>Artiste</span>
                      <input
                        type="text"
                        value={tagArtist}
                        onChange={(e) => setTagArtist(e.target.value)}
                        placeholder="Nom de l'artiste"
                      />
                    </label>
                    <label>
                      <span>Album</span>
                      <input
                        type="text"
                        value={tagAlbum}
                        onChange={(e) => setTagAlbum(e.target.value)}
                        placeholder="Nom de l'album"
                      />
                    </label>
                    <label>
                      <span>Année</span>
                      <input
                        type="text"
                        value={tagYear}
                        onChange={(e) => setTagYear(e.target.value)}
                        placeholder="2026"
                        inputMode="numeric"
                        maxLength={4}
                      />
                    </label>
                  </div>
                )}
              </div>
            )}
            <div className="output-location">
              <span className="output-location__label">Dossier</span>
              <span className="output-location__value" title={outputDir ?? ""}>
                {outputDir
                  ? shortenPath(outputDir)
                  : status.kind === "batch"
                  ? "À côté de chaque source"
                  : "À côté de la vidéo"}
              </span>
              <button className="linkbtn" onClick={pickOutputDir}>Modifier</button>
              {outputDir && (
                <button
                  className="linkbtn linkbtn--muted"
                  onClick={() => setOutputDir(null)}
                >
                  Réinitialiser
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      <footer className="footer">
        <div className="actions">
          {status.kind === "ready" && (
            <>
              <button className="btn btn--ghost" onClick={reset}>Annuler</button>
              <button className="btn" onClick={extract}>
                Extraire en {format.toUpperCase()}
              </button>
            </>
          )}
          {status.kind === "extracting" && (
            <button className="btn" disabled>
              {status.percent != null ? `${Math.round(status.percent)} %` : "Extraction…"}
            </button>
          )}
          {status.kind === "done" && (
            <>
              <button className="btn btn--ghost" onClick={() => reveal(status.output)}>
                Afficher dans le Finder
              </button>
              <button className="btn" onClick={reset}>Nouvelle vidéo</button>
            </>
          )}
          {status.kind === "error" && (
            <button className="btn btn--ghost" onClick={reset}>Réessayer</button>
          )}
          {status.kind === "batch" && (
            <>
              <button
                className="btn btn--ghost"
                onClick={reset}
                disabled={batchRunning}
              >
                Vider la file
              </button>
              <button
                className="btn"
                onClick={runBatch}
                disabled={
                  batchRunning ||
                  batchJobs.filter((j) => j.status === "queued").length === 0
                }
              >
                {batchRunning
                  ? "Traitement…"
                  : `Lancer (${batchJobs.filter((j) => j.status === "queued").length})`}
              </button>
            </>
          )}
        </div>

        {status.kind === "done" && (
          <div className="success">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 6 9 17l-5-5" />
            </svg>
            <span>
              Fichier créé&nbsp;:&nbsp;
              <span className="success__path">{baseName(status.output)}</span>
            </span>
          </div>
        )}

        {status.kind === "error" && (
          <div className="errorcard">{status.message}</div>
        )}
      </footer>
          </>
        )}

        {view === "convert" && (
          <ConvertView active reveal={reveal} showToast={showToast} addHistory={addVideoHistory} />
        )}
        {view === "compress" && (
          <CompressView active reveal={reveal} showToast={showToast} addHistory={addVideoHistory} />
        )}
        {view === "trim" && (
          <TrimView active reveal={reveal} showToast={showToast} addHistory={addVideoHistory} />
        )}
        {view === "merge" && (
          <MergeView active reveal={reveal} showToast={showToast} addHistory={addVideoHistory} />
        )}
        {view === "togif" && (
          <ToGifView active reveal={reveal} showToast={showToast} addHistory={addVideoHistory} />
        )}
        {view === "frame" && (
          <FrameExtractView active reveal={reveal} showToast={showToast} addHistory={addVideoHistory} />
        )}
        {view === "transform" && (
          <TransformView active reveal={reveal} showToast={showToast} addHistory={addVideoHistory} />
        )}
        {view === "crop" && (
          <CropView active reveal={reveal} showToast={showToast} addHistory={addVideoHistory} />
        )}
        {view === "speed" && (
          <SpeedView active reveal={reveal} showToast={showToast} addHistory={addVideoHistory} />
        )}
        {/* DownloadView : monté une fois pour toutes après la 1ère visite.
            On utilise display:none au lieu d'un unmount conditionnel pour
            que le state (URL analysée, téléchargement en cours, événements
            de progression) survive aux navigations entre outils. */}
        {downloadMounted && (
          <div
            style={{
              display: view === "download" ? "contents" : "none",
            }}
          >
            <DownloadView reveal={reveal} showToast={showToast} addHistory={addVideoHistory} />
          </div>
        )}

        {view === "history" && (
          <HistoryView
            entries={history}
            onReveal={reveal}
            onRemove={removeHistoryEntry}
            onReuse={reuseFromHistory}
            onClearAll={clearHistory}
          />
        )}

        {view === "presets" && (
          <PresetsView
            presets={presets}
            activeId={activePresetId}
            onApply={(p) => { applyPreset(p); setView("extract"); }}
            onUpdate={updatePreset}
            onRemove={removePreset}
            onReset={resetPresetToDefault}
            onCreate={createBlankPreset}
            onSaveCurrent={savePreset}
            onBack={() => setView("extract")}
          />
        )}

        {view === "settings" && (
          <SettingsView
            soundOnComplete={soundOnComplete}
            setSoundOnComplete={setSoundOnComplete}
            themePref={themePref}
            setThemePref={setThemePref}
            onResetAll={resetAllPreferences}
            historyCount={history.length}
            totalSeconds={totalHistorySeconds}
          />
        )}
      </main>

      {toast && (
        <div className={`toast toast--${toast.kind}`} role="status" aria-live="polite">
          <span className="toast__icon" aria-hidden>
            {toast.kind === "success" && (
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            )}
            {toast.kind === "info" && (
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
            )}
            {toast.kind === "error" && (
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v4M12 16h.01" />
              </svg>
            )}
          </span>
          <span className="toast__message">{toast.message}</span>
        </div>
      )}
    </div>
  );
}

// ===== Editor en mode "ready" =====

function ReadyEditor({
  info,
  waveformPath,
  trimStart,
  trimEnd,
  onTrimChange,
  onAutoTrim,
}: {
  info: MediaInfo;
  waveformPath: string | null;
  trimStart: number;
  trimEnd: number;
  onTrimChange: (start: number, end: number) => void;
  onAutoTrim: () => void;
}) {
  const duration = info.durationSeconds ?? 0;
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioInput = isAudioOnly(info.path);

  // Cale le lecteur (video OU audio) à la position t (clamp aux bornes).
  const seekPlayer = (t: number) => {
    const el = audioInput ? audioRef.current : videoRef.current;
    if (el && isFinite(t)) {
      el.currentTime = Math.max(0, Math.min(t, duration));
    }
  };

  return (
    <div className="editor">
      {audioInput ? (
        <div className="audio-placeholder">
          <div className="audio-placeholder__icon" aria-hidden>
            <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
          </div>
          <div className="audio-placeholder__name">{info.fileName}</div>
          <audio
            ref={audioRef}
            src={convertFileSrc(info.path)}
            controls
            preload="metadata"
            className="audio-placeholder__player"
          />
        </div>
      ) : (
        <video
          ref={videoRef}
          className="editor__video"
          src={convertFileSrc(info.path)}
          controls
          preload="metadata"
        />
      )}
      <TrimEditor
        duration={duration}
        start={trimStart}
        end={trimEnd}
        waveformPath={waveformPath}
        onChange={(s, e, which) => {
          onTrimChange(s, e);
          seekPlayer(which === "start" ? s : e);
        }}
        onAutoTrim={onAutoTrim}
      />
    </div>
  );
}

function TrimEditor({
  duration,
  start,
  end,
  waveformPath,
  onChange,
  onAutoTrim,
}: {
  duration: number;
  start: number;
  end: number;
  waveformPath: string | null;
  onChange: (start: number, end: number, which: "start" | "end") => void;
  onAutoTrim?: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  const startPct = duration > 0 ? (start / duration) * 100 : 0;
  const endPct = duration > 0 ? (end / duration) * 100 : 100;

  const xToTime = (clientX: number): number => {
    const el = trackRef.current;
    if (!el || duration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return pct * duration;
  };

  const handleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleMove =
    (which: "start" | "end") =>
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.buttons !== 1) return;
      const t = xToTime(e.clientX);
      if (which === "start") {
        const ns = Math.min(t, end - MIN_TRIM_DURATION);
        onChange(Math.max(0, ns), end, "start");
      } else {
        const ne = Math.max(t, start + MIN_TRIM_DURATION);
        onChange(start, Math.min(duration, ne), "end");
      }
    };

  const selectedDuration = Math.max(0, end - start);

  return (
    <div className="trim">
      <div className="trim__track" ref={trackRef}>
        {waveformPath ? (
          <img
            className="trim__waveform"
            src={convertFileSrc(waveformPath)}
            alt=""
            draggable={false}
          />
        ) : (
          <div className="trim__waveform-loading">Génération de la forme d'onde…</div>
        )}
        <div className="trim__mask trim__mask--left" style={{ width: `${startPct}%` }} />
        <div
          className="trim__mask trim__mask--right"
          style={{ left: `${endPct}%`, width: `${100 - endPct}%` }}
        />
        <div
          className="trim__selection"
          style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }}
          aria-hidden
        />
        <div
          className="trim__handle"
          style={{ left: `${startPct}%` }}
          onPointerDown={handleDown}
          onPointerMove={handleMove("start")}
          role="slider"
          aria-label="Début"
          aria-valuemin={0}
          aria-valuemax={Math.floor(duration)}
          aria-valuenow={Math.floor(start)}
        />
        <div
          className="trim__handle"
          style={{ left: `${endPct}%` }}
          onPointerDown={handleDown}
          onPointerMove={handleMove("end")}
          role="slider"
          aria-label="Fin"
          aria-valuemin={0}
          aria-valuemax={Math.floor(duration)}
          aria-valuenow={Math.floor(end)}
        />
      </div>
      <div className="trim__labels">
        <span>{formatTime(start)}</span>
        <span className="trim__labels__duration">
          Sélection&nbsp;: {formatTime(selectedDuration)}
        </span>
        <span>{formatTime(end)}</span>
      </div>
      {onAutoTrim && (
        <div className="trim__autotrim">
          <button className="linkbtn" onClick={onAutoTrim}>
            Détecter les silences automatiquement
          </button>
        </div>
      )}
    </div>
  );
}

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

// Petit toggle pour les effets audio.
function Toggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={`toggle ${checked ? "toggle--on" : ""} ${disabled ? "toggle--disabled" : ""}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle__dot" />
      <span className="toggle__label">{label}</span>
    </label>
  );
}

// ===== Vue batch =====

function BatchView({
  jobs,
  running,
  onRemove,
  onReveal,
}: {
  jobs: BatchJob[];
  running: boolean;
  onRemove: (id: string) => void;
  onReveal: (path: string) => void;
}) {
  return (
    <div className="batch">
      <div className="batch__header">
        <span>{jobs.length} fichier{jobs.length > 1 ? "s" : ""} en file</span>
        <span className="batch__counts">
          <span className="batch__count">{jobs.filter((j) => j.status === "done").length} ✓</span>
          {jobs.some((j) => j.status === "error") && (
            <span className="batch__count batch__count--err">
              {jobs.filter((j) => j.status === "error").length} ✗
            </span>
          )}
        </span>
      </div>
      <ul className="batch__list">
        {jobs.map((job) => (
          <li key={job.id} className={`batch-job batch-job--${job.status}`}>
            <div className="batch-job__icon" aria-hidden>
              {job.status === "queued" && (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                </svg>
              )}
              {job.status === "processing" && (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M12 3a9 9 0 0 1 9 9" />
                </svg>
              )}
              {job.status === "done" && (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
              {job.status === "error" && (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              )}
            </div>
            <div className="batch-job__body">
              <div className="batch-job__name" title={job.path}>{job.fileName}</div>
              <div className="batch-job__meta">
                {job.status === "queued" && (job.durationSeconds != null
                  ? `Durée ${formatTime(job.durationSeconds)} · en attente`
                  : "Lecture des infos…")}
                {job.status === "processing" && (job.percent != null
                  ? `En cours · ${Math.round(job.percent)} %`
                  : "En cours…")}
                {job.status === "done" && "Terminé"}
                {job.status === "error" && (job.error ?? "Erreur")}
              </div>
              {job.status === "processing" && job.percent != null && (
                <ProgressBar percent={job.percent} />
              )}
            </div>
            <div className="batch-job__actions">
              {job.status === "done" && job.outputPath && (
                <button
                  className="iconbtn iconbtn--inline"
                  onClick={() => onReveal(job.outputPath!)}
                  title="Afficher dans le Finder"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </svg>
                </button>
              )}
              {!running && (
                <button
                  className="iconbtn iconbtn--inline iconbtn--danger"
                  onClick={() => onRemove(job.id)}
                  title="Retirer"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ===== Sidebar (navigation latérale) =====

// Items de navigation, regroupés par section. Une section peut contenir
// des sous-headers (mini-titres en italique gris) entre les items pour
// distinguer des familles d'outils dans une même catégorie.
type NavItem = { kind: "item"; id: View; label: string; icon: React.ReactNode; badge?: number };
type NavSubheader = { kind: "subheader"; label: string };
type NavEntry = NavItem | NavSubheader;
type NavSection = { header?: string; entries: NavEntry[] };

function Sidebar({
  view,
  onChange,
  historyCount,
  totalSeconds,
}: {
  view: View;
  onChange: (v: View) => void;
  historyCount: number;
  totalSeconds: number;
}) {
  // Petit helper pour construire un NavItem sans répéter `kind: "item"`.
  const item = (
    id: View,
    label: string,
    icon: React.ReactNode,
    badge?: number,
  ): NavItem => ({ kind: "item", id, label, icon, badge });

  const sections: NavSection[] = [
    {
      header: "Audio",
      entries: [
        item(
          "extract",
          "Extraire",
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5" />
            <path d="m5 12 7 7 7-7" />
          </svg>,
        ),
      ],
    },
    {
      header: "Vidéo",
      entries: [
        { kind: "subheader", label: "Format" },
        item(
          "convert",
          "Convertir",
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-3-6.7" />
            <path d="M21 3v5h-5" />
          </svg>,
        ),
        item(
          "compress",
          "Compresser",
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 14h6v6" />
            <path d="M20 10h-6V4" />
            <path d="m14 10 7-7" />
            <path d="m3 21 7-7" />
          </svg>,
        ),
        { kind: "subheader", label: "Édition" },
        item(
          "trim",
          "Découper",
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M20 4 8.12 15.88" />
            <path d="M14.47 14.48 20 20" />
            <path d="M8.12 8.12 12 12" />
          </svg>,
        ),
        item(
          "merge",
          "Fusionner",
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 6 4 10l4 4" />
            <path d="M16 18l4-4-4-4" />
            <path d="M4 10h7a4 4 0 0 1 4 4v0" />
            <path d="M20 14h-7a4 4 0 0 0-4-4v0" />
          </svg>,
        ),
        item(
          "transform",
          "Redimensionner",
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 1 1 9 9" />
            <path d="m21 12-3-3-3 3" />
            <path d="M9 3 6 6l3 3" />
          </svg>,
        ),
        item(
          "crop",
          "Recadrer",
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 2v14a2 2 0 0 0 2 2h14" />
            <path d="M18 22V8a2 2 0 0 0-2-2H2" />
          </svg>,
        ),
        item(
          "speed",
          "Vitesse",
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 12 8 8" />
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v1M17 12h-1M12 17v-1M7 12h1" />
          </svg>,
        ),
        { kind: "subheader", label: "Image" },
        item(
          "togif",
          "Vers GIF",
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M7 10v4" />
            <path d="M11 10h2v4h-2z" />
            <path d="M16 10h2M16 12h1.5M16 14v-4" />
          </svg>,
        ),
        item(
          "frame",
          "Extraire image",
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="9" cy="10" r="2" />
            <path d="m21 15-5-5L5 21" />
          </svg>,
        ),
      ],
    },
    {
      header: "Web",
      entries: [
        item(
          "download",
          "Télécharger",
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="m7 10 5 5 5-5" />
            <path d="M12 15V3" />
          </svg>,
        ),
      ],
    },
    {
      entries: [
        item(
          "history",
          "Historique",
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v5h5" />
            <path d="M12 7v5l3 2" />
          </svg>,
          historyCount,
        ),
        item(
          "settings",
          "Réglages",
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>,
        ),
      ],
    },
  ];
  return (
    <aside className="sidebar">
      <header className="sidebar__brand">
        <span className="sidebar__brand-icon"><BrandIcon size={26} /></span>
        <span className="sidebar__brand-name">Media Studio</span>
      </header>
      <nav className="sidebar__nav">
        {sections.map((section, idx) => (
          <div key={idx} className="sidebar__section">
            {section.header && (
              <div className="sidebar__section-header">{section.header}</div>
            )}
            {section.entries.map((entry, j) =>
              entry.kind === "subheader" ? (
                <div key={`sub-${j}`} className="sidebar__subheader">
                  {entry.label}
                </div>
              ) : (
                <button
                  key={entry.id}
                  type="button"
                  className={`sidebar__item ${view === entry.id ? "sidebar__item--active" : ""}`}
                  onClick={() => onChange(entry.id)}
                >
                  <span className="sidebar__item-icon">{entry.icon}</span>
                  <span className="sidebar__item-label">{entry.label}</span>
                  {entry.badge != null && entry.badge > 0 && (
                    <span className="sidebar__item-badge">{entry.badge}</span>
                  )}
                </button>
              ),
            )}
          </div>
        ))}
      </nav>
      <footer className="sidebar__footer">
        {totalSeconds > 0 ? (
          <>
            <span>{formatTime(totalSeconds)}</span>
            <span className="sidebar__footer-hint">cumulés extraits</span>
          </>
        ) : (
          <span className="sidebar__footer-hint">Pas encore d'extraction</span>
        )}
      </footer>
    </aside>
  );
}

// ===== Page Historique =====

function HistoryView({
  entries,
  onReveal,
  onRemove,
  onReuse,
  onClearAll,
}: {
  entries: HistoryEntry[];
  onReveal: (path: string) => void;
  onRemove: (id: string) => void;
  onReuse: (entry: HistoryEntry) => void;
  onClearAll: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.outputFileName.toLowerCase().includes(q) ||
        e.sourceFileName.toLowerCase().includes(q),
    );
  }, [entries, query]);

  return (
    <div className="page">
      <header className="page__header">
        <h1>Historique</h1>
        {entries.length > 0 && (
          <button className="linkbtn linkbtn--muted" onClick={onClearAll}>
            Tout effacer
          </button>
        )}
      </header>

      {entries.length === 0 ? (
        <div className="page__empty">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v5h5" />
          </svg>
          <p>Aucune extraction encore.</p>
          <p className="page__empty-hint">Tes extractions apparaîtront ici.</p>
        </div>
      ) : (
        <>
          <div className="search">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              placeholder="Rechercher dans l'historique…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="search__clear" onClick={() => setQuery("")} aria-label="Effacer">
                ×
              </button>
            )}
          </div>
          {filtered.length === 0 ? (
            <p className="page__empty-hint">Aucun résultat.</p>
          ) : (
            <ul className="history-list">
              {filtered.map((e) => (
                <li key={e.id} className="history-item">
                  <div className="history-item__head">
                    <span className="history-item__name" title={e.outputFileName}>
                      {e.outputFileName}
                    </span>
                    <span className={`history-item__badge history-item__badge--${e.kind}`}>
                      {historyKindLabel(e)}
                    </span>
                  </div>
                  <div className="history-item__meta">
                    <span>{formatTime(e.durationSeconds)}</span>
                    {e.kind === "audio" && e.bitrate && <span>· {e.bitrate}</span>}
                    {e.kind === "audio" && e.trimStart != null && e.trimEnd != null && <span>· extrait</span>}
                    {e.kind !== "audio" && e.videoSummary && <span>· {e.videoSummary}</span>}
                    {e.kind !== "audio" && e.outputSizeBytes != null && (
                      <span>· {formatHistoryBytes(e.outputSizeBytes)}</span>
                    )}
                    <span>· {formatHistoryDate(e.timestamp)}</span>
                  </div>
                  <div className="history-item__source" title={e.sourcePath}>
                    depuis {e.sourceFileName}
                  </div>
                  <div className="history-item__actions">
                    <button
                      className="iconbtn iconbtn--inline"
                      onClick={() => onReveal(e.outputPath)}
                      title="Afficher dans le Finder"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                      </svg>
                    </button>
                    {e.kind === "audio" && (
                      <button
                        className="iconbtn iconbtn--inline"
                        onClick={() => onReuse(e)}
                        title="Recharger cette vidéo"
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 12a9 9 0 1 0 3-6.7" />
                          <path d="M3 4v5h5" />
                        </svg>
                      </button>
                    )}
                    <button
                      className="iconbtn iconbtn--inline iconbtn--danger"
                      onClick={() => onRemove(e.id)}
                      title="Supprimer de l'historique"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      </svg>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

// ===== Page Préréglages =====

function PresetsView({
  presets,
  activeId,
  onApply,
  onUpdate,
  onRemove,
  onReset,
  onCreate,
  onSaveCurrent,
  onBack,
}: {
  presets: Preset[];
  activeId: string | null;
  onApply: (p: Preset) => void;
  onUpdate: (id: string, changes: Partial<Preset>) => void;
  onRemove: (id: string) => void;
  onReset: (id: string) => void;
  onCreate: () => string;
  onSaveCurrent: () => void;
  onBack: () => void;
}) {
  // ID du préréglage actuellement en mode édition (un seul à la fois).
  const [editingId, setEditingId] = useState<string | null>(null);

  const handleCreate = () => {
    const newId = onCreate();
    setEditingId(newId);
  };

  return (
    <div className="page">
      <header className="page__header">
        <div className="page__header-title">
          <button
            type="button"
            className="iconbtn iconbtn--inline"
            onClick={onBack}
            title="Retour à Extraire"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <h1>Préréglages</h1>
        </div>
        <div className="page__header-actions">
          <button className="btn btn--ghost" onClick={onSaveCurrent}>
            Enregistrer la config actuelle
          </button>
          <button className="btn" onClick={handleCreate}>
            + Nouveau
          </button>
        </div>
      </header>
      <p className="page__intro">
        Tous les préréglages sont modifiables et renommables. Les préréglages
        marqués "Par défaut" peuvent être restaurés à leurs valeurs d'origine
        via le bouton "Réinitialiser".
      </p>
      <ul className="preset-list">
        {presets.map((p) =>
          editingId === p.id ? (
            <PresetEditCard
              key={p.id}
              preset={p}
              onSave={(changes) => {
                onUpdate(p.id, changes);
                setEditingId(null);
              }}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <PresetCard
              key={p.id}
              preset={p}
              isActive={activeId === p.id}
              onApply={() => onApply(p)}
              onEdit={() => setEditingId(p.id)}
              onRemove={() => onRemove(p.id)}
              onReset={() => onReset(p.id)}
            />
          ),
        )}
      </ul>
    </div>
  );
}

function PresetCard({
  preset,
  isActive,
  onApply,
  onEdit,
  onRemove,
  onReset,
}: {
  preset: Preset;
  isActive: boolean;
  onApply: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onReset: () => void;
}) {
  return (
    <li className={`preset-item ${isActive ? "preset-item--active" : ""}`}>
      <div className="preset-item__head">
        <h3 className="preset-item__name">{preset.name}</h3>
        {preset.builtin && <span className="preset-item__pill">Par défaut</span>}
        {isActive && (
          <span className="preset-item__pill preset-item__pill--active">Actif</span>
        )}
      </div>
      <div className="preset-item__params">
        <span className="param-chip">{preset.format.toUpperCase()}</span>
        {preset.format !== "wav" && <span className="param-chip">{preset.bitrate}</span>}
        {preset.normalize && <span className="param-chip">Normalisé</span>}
        {preset.fadeIn && <span className="param-chip">Fade in</span>}
        {preset.fadeOut && <span className="param-chip">Fade out</span>}
        {preset.embedThumbnail && <span className="param-chip">Pochette</span>}
      </div>
      <div className="preset-item__actions">
        <button className="btn btn--ghost" onClick={onApply}>
          Appliquer
        </button>
        <button className="btn btn--ghost" onClick={onEdit}>
          Modifier
        </button>
        {preset.builtin ? (
          <button
            className="iconbtn"
            onClick={onReset}
            title="Réinitialiser aux valeurs d'origine"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <path d="M3 4v5h5" />
            </svg>
          </button>
        ) : (
          <button
            className="iconbtn iconbtn--danger"
            onClick={onRemove}
            title="Supprimer"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            </svg>
          </button>
        )}
      </div>
    </li>
  );
}

// Carte en mode édition : tous les paramètres du préréglage sont éditables.
function PresetEditCard({
  preset,
  onSave,
  onCancel,
}: {
  preset: Preset;
  onSave: (changes: Partial<Preset>) => void;
  onCancel: () => void;
}) {
  // Brouillon local — n'est commité qu'au clic sur Enregistrer.
  const [draft, setDraft] = useState<Preset>({ ...preset });

  return (
    <li className="preset-item preset-item--editing">
      <div className="preset-edit">
        <label className="preset-edit__field preset-edit__field--name">
          <span>Nom</span>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            autoFocus
          />
        </label>

        <Segmented<Format>
          label="Format"
          options={FORMATS}
          value={draft.format}
          onChange={(v) => setDraft({ ...draft, format: v })}
        />

        <Segmented<Bitrate>
          label="Qualité"
          options={BITRATES.map((b) => ({ value: b, label: b }))}
          value={draft.bitrate}
          onChange={(v) => setDraft({ ...draft, bitrate: v })}
          disabled={draft.format === "wav"}
        />

        <div className="effects">
          <span className="effects__label">Effets</span>
          <Toggle
            label="Normaliser"
            checked={draft.normalize}
            onChange={(v) => setDraft({ ...draft, normalize: v })}
          />
          <Toggle
            label="Fondu entrée"
            checked={draft.fadeIn}
            onChange={(v) => setDraft({ ...draft, fadeIn: v })}
          />
          <Toggle
            label="Fondu sortie"
            checked={draft.fadeOut}
            onChange={(v) => setDraft({ ...draft, fadeOut: v })}
          />
          <Toggle
            label="Pochette"
            checked={draft.embedThumbnail}
            onChange={(v) => setDraft({ ...draft, embedThumbnail: v })}
            disabled={draft.format === "wav"}
          />
        </div>
      </div>
      <div className="preset-item__actions">
        <button className="btn btn--ghost" onClick={onCancel}>
          Annuler
        </button>
        <button
          className="btn"
          onClick={() => onSave({
            name: draft.name.trim() || preset.name,
            format: draft.format,
            bitrate: draft.bitrate,
            normalize: draft.normalize,
            fadeIn: draft.fadeIn,
            fadeOut: draft.fadeOut,
            embedThumbnail: draft.embedThumbnail,
          })}
        >
          Enregistrer
        </button>
      </div>
    </li>
  );
}

// ===== Page Réglages =====

function SettingsView({
  soundOnComplete,
  setSoundOnComplete,
  themePref,
  setThemePref,
  onResetAll,
  historyCount,
  totalSeconds,
}: {
  soundOnComplete: boolean;
  setSoundOnComplete: (v: boolean) => void;
  themePref: ThemePref;
  setThemePref: (v: ThemePref) => void;
  onResetAll: () => void;
  historyCount: number;
  totalSeconds: number;
}) {
  return (
    <div className="page">
      <header className="page__header">
        <h1>Réglages</h1>
      </header>

      <section className="settings-section">
        <h2>Apparence</h2>
        <Segmented<ThemePref>
          label="Thème"
          options={[
            { value: "light", label: "Clair" },
            { value: "dark", label: "Sombre" },
            { value: "system", label: "Système" },
          ]}
          value={themePref}
          onChange={setThemePref}
        />
        <p className="settings-text settings-text--muted">
          {themePref === "system"
            ? "Suit automatiquement les Préférences Système macOS."
            : themePref === "light"
            ? "Mode clair forcé, ignore la préférence macOS."
            : "Mode sombre forcé, ignore la préférence macOS."}
        </p>
      </section>

      <section className="settings-section">
        <h2>Comportement</h2>
        <div className="settings-row">
          <Toggle
            label="Jouer un son à la fin de l'extraction"
            checked={soundOnComplete}
            onChange={setSoundOnComplete}
          />
        </div>
      </section>

      <section className="settings-section">
        <h2>Statistiques</h2>
        <p className="settings-text">
          {historyCount} extraction{historyCount > 1 ? "s" : ""} dans l'historique
          {totalSeconds > 0 && ` — ${formatTime(totalSeconds)} d'audio cumulés.`}
        </p>
      </section>

      <section className="settings-section">
        <h2>Données</h2>
        <p className="settings-text">
          Toutes les préférences (format, qualité, préréglages, historique) sont stockées
          en local. Aucun envoi réseau.
        </p>
        <button className="btn btn--ghost" onClick={onResetAll}>
          Réinitialiser toutes les préférences
        </button>
      </section>

      <section className="settings-section">
        <h2>À propos</h2>
        <p className="settings-text">
          <strong>Media Studio</strong> 0.2.0<br />
          Suite multi-outils audio &amp; vidéo, construite avec Tauri v2 · React · ffmpeg 8.1
        </p>
      </section>
    </div>
  );
}
