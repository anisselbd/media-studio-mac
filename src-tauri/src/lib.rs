use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

// ===== Parsing utilitaire =====

fn parse_hms_to_seconds(s: &str) -> Option<f64> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].trim().parse().ok()?;
    let m: f64 = parts[1].trim().parse().ok()?;
    let sec: f64 = parts[2].trim().parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec)
}

fn parse_duration(stderr: &str) -> Option<f64> {
    for line in stderr.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Duration:") {
            let dur = rest.split(',').next()?.trim();
            return parse_hms_to_seconds(dur);
        }
    }
    None
}

fn has_audio_stream(stderr: &str) -> bool {
    stderr.lines().any(|line| {
        let trimmed = line.trim();
        trimmed.starts_with("Stream") && trimmed.contains("Audio:")
    })
}

fn humanize_ffmpeg_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("does not contain any stream") {
        return "Ce fichier ne contient aucune piste exploitable.".into();
    }
    if lower.contains("output file does not contain") && lower.contains("audio") {
        return "Aucune piste audio à extraire dans ce fichier.".into();
    }
    if lower.contains("invalid data found when processing input") {
        return "Le fichier semble corrompu ou son format n'est pas reconnu.".into();
    }
    if lower.contains("no such file or directory") {
        return "Fichier source introuvable.".into();
    }
    if lower.contains("permission denied") {
        return "Permission refusée pour le fichier ou le dossier de sortie.".into();
    }
    if lower.contains("no space left on device") {
        return "Espace disque insuffisant pour écrire le fichier.".into();
    }
    if lower.contains("read-only file system") {
        return "Le dossier de sortie est en lecture seule.".into();
    }
    let last_lines: Vec<&str> = stderr.lines().rev().take(5).collect();
    last_lines.into_iter().rev().collect::<Vec<_>>().join("\n")
}

// Hash stable d'un chemin (pour générer des noms de fichiers cache déterministes).
fn hash_string(s: &str) -> String {
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

// ===== Types =====

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaInfo {
    path: String,
    file_name: String,
    duration_seconds: Option<f64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    percent: f64,
}

// Payload pour les outils vidéo : on inclut un job_id pour permettre au
// frontend de router la progression vers la bonne vue / le bon job
// (utile si on enchaîne plusieurs encodages plus tard).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoProgressPayload {
    job_id: String,
    percent: f64,
}

// Métadonnées optionnelles à inscrire dans les tags ID3 (MP3) ou
// equivalent (AAC/M4A). Chaque champ est optionnel.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    year: Option<String>,
}

impl Metadata {
    // Renvoie les paires d'arguments `-metadata key=value` à appliquer à ffmpeg.
    fn to_ffmpeg_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(t) = self.title.as_ref().filter(|s| !s.is_empty()) {
            args.push("-metadata".into());
            args.push(format!("title={t}"));
        }
        if let Some(a) = self.artist.as_ref().filter(|s| !s.is_empty()) {
            args.push("-metadata".into());
            args.push(format!("artist={a}"));
        }
        if let Some(al) = self.album.as_ref().filter(|s| !s.is_empty()) {
            args.push("-metadata".into());
            args.push(format!("album={al}"));
        }
        if let Some(y) = self.year.as_ref().filter(|s| !s.is_empty()) {
            args.push("-metadata".into());
            // `date` est la clé standard ffmpeg pour l'année / la date de sortie.
            args.push(format!("date={y}"));
        }
        args
    }
}

// ===== Commandes =====

#[tauri::command]
async fn ffmpeg_version(app: tauri::AppHandle) -> Result<String, String> {
    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(["-version"])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
async fn get_media_info(app: tauri::AppHandle, path: String) -> Result<MediaInfo, String> {
    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(["-hide_banner", "-i", &path])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let stderr = String::from_utf8_lossy(&output.stderr);

    if !has_audio_stream(&stderr) {
        return Err("Ce fichier ne contient pas de piste audio.".into());
    }

    let duration_seconds = parse_duration(&stderr);

    let file_name = std::path::Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());

    Ok(MediaInfo {
        path,
        file_name,
        duration_seconds,
    })
}

// Génère une image PNG de la forme d'onde audio du fichier source.
// Filtre ffmpeg utilisé : `showwavespic` mixé en mono, fond transparent,
// dimensions adaptées à l'affichage UI (1600x140).
//
// Le PNG est mis en cache dans le dossier `app_cache_dir` (par hash du chemin
// source) : si l'utilisateur recharge la même vidéo, pas besoin de regénérer.
//
// Retourne le chemin absolu du PNG produit (le frontend l'utilise ensuite
// via `convertFileSrc()` pour l'afficher dans une <img>).
#[tauri::command]
async fn generate_waveform(
    app: tauri::AppHandle,
    input_path: String,
) -> Result<String, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Dossier cache introuvable : {e}"))?;
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Création du cache impossible : {e}"))?;

    let out_path = cache_dir.join(format!("waveform-{}.png", hash_string(&input_path)));
    let out_str = out_path.to_string_lossy().to_string();

    // Mise en cache : pas de regénération si déjà présent.
    if out_path.exists() {
        return Ok(out_str);
    }

    let filter = "aformat=channel_layouts=mono,showwavespic=s=1600x140:colors=#0071e3:scale=lin";

    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args([
            "-y",
            "-i",
            &input_path,
            "-filter_complex",
            filter,
            "-frames:v",
            "1",
            &out_str,
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(out_str)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(humanize_ffmpeg_error(&stderr))
    }
}

fn build_codec_args(format: &str, bitrate: Option<&str>) -> Result<Vec<String>, String> {
    match format {
        "mp3" => Ok(vec![
            "-c:a".into(),
            "libmp3lame".into(),
            "-b:a".into(),
            bitrate.unwrap_or("192k").into(),
        ]),
        "aac" => Ok(vec![
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            bitrate.unwrap_or("192k").into(),
        ]),
        "wav" => Ok(vec!["-c:a".into(), "pcm_s16le".into()]),
        other => Err(format!("Format non supporté : {other}")),
    }
}

// Construit la chaîne de filtres `-af` selon les options post-traitement choisies.
// - `normalize`     : applique loudnorm EBU R128 (cible -14 LUFS, standard YouTube/Spotify)
// - `fade_in`       : fondu d'ouverture de 1 seconde
// - `fade_out`      : fondu de fermeture de 1 seconde (à la fin de la piste)
// - `output_secs`   : durée de la piste de sortie (nécessaire pour positionner le fade out)
//
// Retourne None s'il n'y a aucun filtre à appliquer (on n'ajoute alors pas `-af`).
fn build_audio_filter(
    normalize: bool,
    fade_in: bool,
    fade_out: bool,
    output_secs: f64,
) -> Option<String> {
    let mut filters: Vec<String> = Vec::new();
    if normalize {
        filters.push("loudnorm=I=-14:LRA=11:TP=-1.5".into());
    }
    if fade_in {
        filters.push("afade=t=in:st=0:d=1".into());
    }
    if fade_out && output_secs > 1.0 {
        let st = output_secs - 1.0;
        filters.push(format!("afade=t=out:st={st}:d=1"));
    }
    if filters.is_empty() {
        None
    } else {
        Some(filters.join(","))
    }
}

#[tauri::command]
async fn extract_audio(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
    format: String,
    bitrate: Option<String>,
    start_seconds: Option<f64>,
    end_seconds: Option<f64>,
    normalize: bool,
    fade_in: bool,
    fade_out: bool,
    output_duration: f64,
    embed_thumbnail: bool,
    // Tags ID3/M4A optionnels. None ou champs vides → pas de tags écrits.
    metadata: Option<Metadata>,
) -> Result<String, String> {
    let codec_args = build_codec_args(&format, bitrate.as_deref())?;
    let audio_filter = build_audio_filter(normalize, fade_in, fade_out, output_duration);
    let supports_cover = (format == "mp3" || format == "aac") && embed_thumbnail;

    let mut args: Vec<String> = vec!["-y".into()];
    if let Some(start) = start_seconds {
        if start > 0.0 {
            args.push("-ss".into());
            args.push(format!("{start}"));
        }
    }
    args.push("-i".into());
    args.push(input_path.clone());
    if let (Some(start), Some(end)) = (start_seconds, end_seconds) {
        let duration = end - start;
        if duration > 0.0 {
            args.push("-t".into());
            args.push(format!("{duration}"));
        }
    }

    if supports_cover {
        // Extrait une vignette carrée 400x400 via le filtre thumbnail
        // (sélectionne la frame la plus représentative dans le segment).
        args.push("-filter_complex".into());
        args.push(
            "[0:v]thumbnail,scale=400:400:force_original_aspect_ratio=increase,crop=400:400[cover]".into(),
        );
        args.push("-map".into());
        args.push("0:a:0".into());
        if let Some(ref filter) = audio_filter {
            args.push("-af".into());
            args.push(filter.clone());
        }
        args.extend(codec_args);
        args.push("-map".into());
        args.push("[cover]".into());
        args.push("-c:v".into());
        args.push("mjpeg".into());
        args.push("-disposition:v".into());
        args.push("attached_pic".into());
        args.push("-metadata:s:v".into());
        args.push("title=Cover".into());
    } else {
        args.push("-vn".into());
        args.extend(codec_args);
        if let Some(filter) = audio_filter {
            args.push("-af".into());
            args.push(filter);
        }
    }

    // Tags ID3 / M4A en sortie. WAV peut techniquement les recevoir aussi,
    // mais le support des players est inégal — on les écrit quand même si demandés.
    if let Some(m) = metadata.as_ref() {
        args.extend(m.to_ffmpeg_args());
    }

    args.extend([
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output_path.clone(),
    ]);

    let (mut rx, _child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(args)
        .spawn()
        .map_err(|e| format!("Échec du lancement de ffmpeg : {e}"))?;

    // Durée de référence pour le pourcentage : la durée du trim si fourni,
    // sinon on lira la Duration: depuis stderr (comme avant).
    let mut total_seconds: Option<f64> = match (start_seconds, end_seconds) {
        (Some(s), Some(e)) if e > s => Some(e - s),
        _ => None,
    };
    let mut stderr_buf = String::new();
    let mut success = false;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(data) => {
                let s = String::from_utf8_lossy(&data);
                stderr_buf.push_str(&s);
                if total_seconds.is_none() {
                    total_seconds = parse_duration(&stderr_buf);
                }
            }
            CommandEvent::Stdout(data) => {
                let s = String::from_utf8_lossy(&data);
                for line in s.lines() {
                    if let Some(us_str) = line.strip_prefix("out_time_us=") {
                        if let Ok(us) = us_str.trim().parse::<i64>() {
                            if let Some(total) = total_seconds {
                                if total > 0.0 {
                                    let current = us as f64 / 1_000_000.0;
                                    let percent =
                                        ((current / total) * 100.0).clamp(0.0, 100.0);
                                    let _ = app.emit(
                                        "extract-progress",
                                        ProgressPayload { percent },
                                    );
                                }
                            }
                        }
                    } else if line.starts_with("progress=end") {
                        let _ =
                            app.emit("extract-progress", ProgressPayload { percent: 100.0 });
                    }
                }
            }
            CommandEvent::Terminated(payload) => {
                success = matches!(payload.code, Some(0));
            }
            _ => {}
        }
    }

    if success {
        Ok(output_path)
    } else {
        Err(humanize_ffmpeg_error(&stderr_buf))
    }
}

// ===== Outils vidéo (Vague 1) =====
//
// Helper interne : lance ffmpeg avec les args fournis, émet la progression
// sur l'event `video-progress` en utilisant job_id pour router côté frontend.
// Si total_seconds est connu, on calcule un pourcentage précis ; sinon on
// se rabat sur la lecture du Duration: depuis stderr (cas d'un seul input).
async fn run_ffmpeg_with_progress(
    app: &tauri::AppHandle,
    job_id: String,
    args: Vec<String>,
    known_total: Option<f64>,
) -> Result<(), String> {
    let (mut rx, _child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(args)
        .spawn()
        .map_err(|e| format!("Échec du lancement de ffmpeg : {e}"))?;

    let mut total_seconds: Option<f64> = known_total;
    let mut stderr_buf = String::new();
    let mut success = false;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(data) => {
                let s = String::from_utf8_lossy(&data);
                stderr_buf.push_str(&s);
                if total_seconds.is_none() {
                    total_seconds = parse_duration(&stderr_buf);
                }
            }
            CommandEvent::Stdout(data) => {
                let s = String::from_utf8_lossy(&data);
                for line in s.lines() {
                    if let Some(us_str) = line.strip_prefix("out_time_us=") {
                        if let Ok(us) = us_str.trim().parse::<i64>() {
                            if let Some(total) = total_seconds {
                                if total > 0.0 {
                                    let current = us as f64 / 1_000_000.0;
                                    let percent =
                                        ((current / total) * 100.0).clamp(0.0, 100.0);
                                    let _ = app.emit(
                                        "video-progress",
                                        VideoProgressPayload {
                                            job_id: job_id.clone(),
                                            percent,
                                        },
                                    );
                                }
                            }
                        }
                    } else if line.starts_with("progress=end") {
                        let _ = app.emit(
                            "video-progress",
                            VideoProgressPayload {
                                job_id: job_id.clone(),
                                percent: 100.0,
                            },
                        );
                    }
                }
            }
            CommandEvent::Terminated(payload) => {
                success = matches!(payload.code, Some(0));
            }
            _ => {}
        }
    }

    if success {
        Ok(())
    } else {
        Err(humanize_ffmpeg_error(&stderr_buf))
    }
}

// Convertit une vidéo vers un autre conteneur / codec.
//
// - `video_codec` : "h264" | "h265" | "av1" | "copy" (copie le flux sans ré-encodage)
// - `audio_mode`  : "copy" | "aac" (re-transcode audio en aac 192k)
// - `crf`         : qualité (18 très haute → 28 légère). Ignoré si copy.
// - `preset`      : vitesse encodage (ultrafast..veryslow). Ignoré si copy.
#[tauri::command]
async fn convert_video(
    app: tauri::AppHandle,
    job_id: String,
    input_path: String,
    output_path: String,
    video_codec: String,
    audio_mode: String,
    crf: Option<u32>,
    preset: Option<String>,
) -> Result<String, String> {
    let mut args: Vec<String> = vec!["-y".into(), "-i".into(), input_path.clone()];

    // Codec vidéo
    match video_codec.as_str() {
        "copy" => {
            args.push("-c:v".into());
            args.push("copy".into());
        }
        "h264" => {
            args.push("-c:v".into());
            args.push("libx264".into());
            if let Some(c) = crf {
                args.push("-crf".into());
                args.push(c.to_string());
            }
            if let Some(p) = preset.as_ref() {
                args.push("-preset".into());
                args.push(p.clone());
            }
            // Garantit la compatibilité macOS / iOS native (yuv420p).
            args.push("-pix_fmt".into());
            args.push("yuv420p".into());
            // faststart : moov atom au début, permet la lecture HTML5
            // progressive (sinon le lecteur Tauri affiche un écran noir
            // jusqu'au téléchargement complet).
            args.push("-movflags".into());
            args.push("+faststart".into());
        }
        "h265" => {
            args.push("-c:v".into());
            args.push("libx265".into());
            if let Some(c) = crf {
                args.push("-crf".into());
                args.push(c.to_string());
            }
            if let Some(p) = preset.as_ref() {
                args.push("-preset".into());
                args.push(p.clone());
            }
            // hvc1 = tag conteneur exigé par QuickTime pour lire le H.265.
            args.push("-tag:v".into());
            args.push("hvc1".into());
        }
        "av1" => {
            args.push("-c:v".into());
            args.push("libsvtav1".into());
            if let Some(c) = crf {
                args.push("-crf".into());
                args.push(c.to_string());
            }
            // SVT-AV1 utilise -preset numérique (0=lent/qualité, 13=rapide).
            if let Some(p) = preset.as_ref() {
                args.push("-preset".into());
                args.push(p.clone());
            }
        }
        other => return Err(format!("Codec vidéo non supporté : {other}")),
    }

    // Codec audio
    match audio_mode.as_str() {
        "copy" => {
            args.push("-c:a".into());
            args.push("copy".into());
        }
        "aac" => {
            args.push("-c:a".into());
            args.push("aac".into());
            args.push("-b:a".into());
            args.push("192k".into());
        }
        "opus" => {
            // Opus est le codec audio attendu par le conteneur WEBM
            // (AAC y est interdit). 128k offre une excellente qualité.
            args.push("-c:a".into());
            args.push("libopus".into());
            args.push("-b:a".into());
            args.push("128k".into());
        }
        other => return Err(format!("Mode audio non supporté : {other}")),
    }

    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());
    args.push(output_path.clone());

    run_ffmpeg_with_progress(&app, job_id, args, None).await?;
    Ok(output_path)
}

// Compresseur vidéo : ré-encode en H.264 avec un BITRATE CIBLE explicite.
//
// Pourquoi un bitrate plutôt qu'un CRF :
//   Le CRF cible une qualité visuelle constante. Sur une source déjà
//   très compressée, libx264 a un plancher de qualité qui peut produire
//   un fichier plus gros que la source. Un bitrate cible explicite +
//   maxrate/bufsize plafonne la taille de sortie de manière prévisible.
//
// Options :
// - `video_bitrate_k` : bitrate vidéo cible en kbps (ex: 800)
// - `scale_height` : redimensionne la vidéo à cette hauteur (préserve
//   le ratio, `scale=-2:H`). None = on garde la résolution source.
// - `audio_bitrate_k` : bitrate audio AAC en kbps. None = copie source.
#[tauri::command]
async fn compress_video(
    app: tauri::AppHandle,
    job_id: String,
    input_path: String,
    output_path: String,
    video_bitrate_k: u32,
    preset: String,
    scale_height: Option<u32>,
    audio_bitrate_k: Option<u32>,
) -> Result<String, String> {
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        input_path.clone(),
    ];

    // Filtre de redimensionnement si demandé.
    // `-2` au lieu de `-1` pour la largeur force la divisibilité par 2,
    // nécessaire pour libx264 + yuv420p.
    if let Some(h) = scale_height {
        args.push("-vf".into());
        args.push(format!("scale=-2:{h}"));
    }

    args.push("-c:v".into());
    args.push("libx264".into());
    args.push("-b:v".into());
    args.push(format!("{video_bitrate_k}k"));
    // maxrate à 1.5x + bufsize 2x = comportement VBR contrôlé qui évite
    // les pics extrêmes tout en gardant de la flexibilité sur les scènes
    // chargées. Ces valeurs sont standard pour du streaming/web.
    args.push("-maxrate".into());
    args.push(format!("{}k", (video_bitrate_k * 3) / 2));
    args.push("-bufsize".into());
    args.push(format!("{}k", video_bitrate_k * 2));
    args.push("-preset".into());
    args.push(preset);
    args.push("-pix_fmt".into());
    args.push("yuv420p".into());
    // faststart déplace le moov atom au début du fichier : indispensable
    // pour que les lecteurs HTML5 (et le lecteur Tauri) puissent commencer
    // à lire avant la fin du téléchargement.
    args.push("-movflags".into());
    args.push("+faststart".into());

    // Audio : copy ou ré-encode AAC.
    match audio_bitrate_k {
        Some(k) => {
            args.push("-c:a".into());
            args.push("aac".into());
            args.push("-b:a".into());
            args.push(format!("{k}k"));
        }
        None => {
            args.push("-c:a".into());
            args.push("copy".into());
        }
    }

    args.extend([
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output_path.clone(),
    ]);

    run_ffmpeg_with_progress(&app, job_id, args, None).await?;
    Ok(output_path)
}

// Découpe rapide SANS ré-encodage. Copy stream only.
//
// Note : ffmpeg coupe au keyframe le plus proche, donc le début effectif
// peut différer de quelques fractions de seconde. C'est le prix à payer
// pour avoir une opération quasi instantanée (pas de transcodage).
#[tauri::command]
async fn fast_trim_video(
    app: tauri::AppHandle,
    job_id: String,
    input_path: String,
    output_path: String,
    start_seconds: f64,
    end_seconds: f64,
) -> Result<String, String> {
    let duration = end_seconds - start_seconds;
    if duration <= 0.0 {
        return Err("Plage de découpe invalide.".into());
    }

    // -ss avant -i = seek rapide au keyframe. -t après = durée à conserver.
    let args: Vec<String> = vec![
        "-y".into(),
        "-ss".into(),
        format!("{start_seconds}"),
        "-i".into(),
        input_path.clone(),
        "-t".into(),
        format!("{duration}"),
        "-c".into(),
        "copy".into(),
        // -avoid_negative_ts évite des timestamps négatifs sur certains formats.
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output_path.clone(),
    ];

    run_ffmpeg_with_progress(&app, job_id, args, Some(duration)).await?;
    Ok(output_path)
}

// Fusion de plusieurs vidéos via le concat demuxer.
//
// Exige que toutes les vidéos aient les mêmes codecs / résolution / fps.
// Si elles diffèrent, ffmpeg renverra une erreur — on remontera le message
// brut, l'utilisateur saura qu'il faut d'abord les harmoniser via le
// convertisseur.
//
// On crée un fichier liste temporaire dans le cache de l'app :
//   file '/abs/path/to/video1.mp4'
//   file '/abs/path/to/video2.mp4'
//   ...
#[tauri::command]
async fn merge_videos(
    app: tauri::AppHandle,
    job_id: String,
    input_paths: Vec<String>,
    output_path: String,
) -> Result<String, String> {
    if input_paths.len() < 2 {
        return Err("Au moins deux vidéos sont nécessaires pour la fusion.".into());
    }

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Dossier cache introuvable : {e}"))?;
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Création du cache impossible : {e}"))?;

    let list_path = cache_dir.join(format!("concat-{}.txt", hash_string(&job_id)));
    let mut list_content = String::new();
    for path in &input_paths {
        // Échappe les apostrophes pour respecter la syntaxe demuxer concat :
        //   file 'chemin'
        // Une apostrophe se ferme et se rouvre : '\'' devient '\'\\''\''.
        let escaped = path.replace('\'', "'\\''");
        list_content.push_str(&format!("file '{escaped}'\n"));
    }
    std::fs::write(&list_path, list_content)
        .map_err(|e| format!("Écriture de la liste impossible : {e}"))?;

    let list_str = list_path.to_string_lossy().to_string();
    let args: Vec<String> = vec![
        "-y".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        list_str,
        "-c".into(),
        "copy".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output_path.clone(),
    ];

    let result = run_ffmpeg_with_progress(&app, job_id, args, None).await;
    // Nettoyage du fichier liste, même en cas d'erreur.
    let _ = std::fs::remove_file(&list_path);
    result?;
    Ok(output_path)
}

// Variante de run_ffmpeg_with_progress qui projette le pourcentage dans
// une plage `[offset, offset+scale]` au lieu de 0-100. Utilisée pour les
// pipelines multi-passes où on veut une barre continue (ex: GIF =
// palettegen 0-50% + paletteuse 50-100%).
async fn run_ffmpeg_scaled_progress(
    app: &tauri::AppHandle,
    job_id: String,
    args: Vec<String>,
    known_total: Option<f64>,
    offset_percent: f64,
    scale_percent: f64,
) -> Result<(), String> {
    let (mut rx, _child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(args)
        .spawn()
        .map_err(|e| format!("Échec du lancement de ffmpeg : {e}"))?;

    let mut total_seconds: Option<f64> = known_total;
    let mut stderr_buf = String::new();
    let mut success = false;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(data) => {
                let s = String::from_utf8_lossy(&data);
                stderr_buf.push_str(&s);
                if total_seconds.is_none() {
                    total_seconds = parse_duration(&stderr_buf);
                }
            }
            CommandEvent::Stdout(data) => {
                let s = String::from_utf8_lossy(&data);
                for line in s.lines() {
                    if let Some(us_str) = line.strip_prefix("out_time_us=") {
                        if let Ok(us) = us_str.trim().parse::<i64>() {
                            if let Some(total) = total_seconds {
                                if total > 0.0 {
                                    let current = us as f64 / 1_000_000.0;
                                    let raw = (current / total).clamp(0.0, 1.0);
                                    let scaled = (offset_percent + raw * scale_percent)
                                        .clamp(0.0, 100.0);
                                    let _ = app.emit(
                                        "video-progress",
                                        VideoProgressPayload {
                                            job_id: job_id.clone(),
                                            percent: scaled,
                                        },
                                    );
                                }
                            }
                        }
                    } else if line.starts_with("progress=end") {
                        let end_pct = (offset_percent + scale_percent).clamp(0.0, 100.0);
                        let _ = app.emit(
                            "video-progress",
                            VideoProgressPayload {
                                job_id: job_id.clone(),
                                percent: end_pct,
                            },
                        );
                    }
                }
            }
            CommandEvent::Terminated(payload) => {
                success = matches!(payload.code, Some(0));
            }
            _ => {}
        }
    }

    if success {
        Ok(())
    } else {
        Err(humanize_ffmpeg_error(&stderr_buf))
    }
}

// Conversion vidéo → GIF haute qualité, en 2 passes pour progression
// continue.
//
// Sans 2-pass explicite, le pipeline GIF (palettegen + paletteuse en un seul
// filter_complex split) lit toute la vidéo une première fois pour générer la
// palette avant d'écrire la moindre frame. Côté UI, la barre de progression
// stagne à 0% pendant toute cette phase puis saute à 100% à la fin — l'UX
// donne l'impression d'un bug.
//
// Solution : on découpe en 2 commandes ffmpeg explicites, et on projette
// chaque passe dans une moitié de la barre :
//   Pass 1 (palettegen)  →  progression 0%   →  50%
//   Pass 2 (paletteuse)  →  progression 50%  → 100%
//
// La palette est écrite dans un fichier PNG temporaire dans app_cache_dir,
// puis supprimée à la fin (même en cas d'erreur).
//
// Paramètres :
// - `fps`           : nombre d'images par seconde du GIF (10 typique, 20 fluide)
// - `scale_height`  : hauteur cible en pixels (préserve le ratio)
// - `start_seconds` / `end_seconds` : segment optionnel à découper
#[tauri::command]
async fn convert_to_gif(
    app: tauri::AppHandle,
    job_id: String,
    input_path: String,
    output_path: String,
    fps: u32,
    scale_height: u32,
    start_seconds: Option<f64>,
    end_seconds: Option<f64>,
) -> Result<String, String> {
    let known = match (start_seconds, end_seconds) {
        (Some(s), Some(e)) if e > s => Some(e - s),
        _ => None,
    };

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Dossier cache introuvable : {e}"))?;
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Création du cache impossible : {e}"))?;
    let palette_path = cache_dir.join(format!("palette-{}.png", hash_string(&job_id)));
    let palette_str = palette_path.to_string_lossy().to_string();

    // ===== Pass 1 : génération de la palette =====
    let mut args1: Vec<String> = vec!["-y".into()];
    if let Some(start) = start_seconds {
        if start > 0.0 {
            args1.push("-ss".into());
            args1.push(format!("{start}"));
        }
    }
    args1.push("-i".into());
    args1.push(input_path.clone());
    if let (Some(s), Some(e)) = (start_seconds, end_seconds) {
        if e > s {
            args1.push("-t".into());
            args1.push(format!("{}", e - s));
        }
    }
    let filter1 = format!(
        "fps={fps},scale=-2:{scale_height}:flags=lanczos,\
         palettegen=max_colors=256:stats_mode=diff"
    );
    args1.push("-vf".into());
    args1.push(filter1);
    args1.push("-progress".into());
    args1.push("pipe:1".into());
    args1.push("-nostats".into());
    args1.push(palette_str.clone());

    let pass1 = run_ffmpeg_scaled_progress(&app, job_id.clone(), args1, known, 0.0, 50.0).await;
    if let Err(e) = pass1 {
        let _ = std::fs::remove_file(&palette_path);
        return Err(e);
    }

    // ===== Pass 2 : écriture du GIF avec la palette =====
    let mut args2: Vec<String> = vec!["-y".into()];
    if let Some(start) = start_seconds {
        if start > 0.0 {
            args2.push("-ss".into());
            args2.push(format!("{start}"));
        }
    }
    args2.push("-i".into());
    args2.push(input_path.clone());
    args2.push("-i".into());
    args2.push(palette_str.clone());
    if let (Some(s), Some(e)) = (start_seconds, end_seconds) {
        if e > s {
            args2.push("-t".into());
            args2.push(format!("{}", e - s));
        }
    }
    let filter2 = format!(
        "[0:v]fps={fps},scale=-2:{scale_height}:flags=lanczos[x];\
         [x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle"
    );
    args2.push("-filter_complex".into());
    args2.push(filter2);
    args2.push("-loop".into());
    args2.push("0".into());
    args2.push("-progress".into());
    args2.push("pipe:1".into());
    args2.push("-nostats".into());
    args2.push(output_path.clone());

    let pass2 = run_ffmpeg_scaled_progress(&app, job_id, args2, known, 50.0, 50.0).await;

    // Nettoyage du PNG palette dans tous les cas.
    let _ = std::fs::remove_file(&palette_path);

    pass2?;
    Ok(output_path)
}

// ===== Téléchargeur yt-dlp (Vague 3) =====

// Infos d'une URL telles que renvoyées par `yt-dlp -J`. On ne déserialise
// que les champs qui nous intéressent (yt-dlp en renvoie des dizaines).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YtDlpInfo {
    title: String,
    uploader: Option<String>,
    duration_seconds: Option<f64>,
    thumbnail: Option<String>,
    webpage_url: Option<String>,
    extractor: Option<String>,
}

// Vérifie que le binaire yt-dlp est présent et lisible. Le frontend appelle
// ça au montage de la vue pour afficher un message d'aide si le binaire
// manque (l'utilisateur doit le télécharger manuellement la première fois).
#[tauri::command]
async fn ytdlp_version(app: tauri::AppHandle) -> Result<String, String> {
    let output = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| format!("Binaire yt-dlp introuvable : {e}"))?
        .args(["--version"])
        .output()
        .await
        .map_err(|e| format!("Impossible de lancer yt-dlp : {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

// Récupère les métadonnées d'un lien sans télécharger la vidéo.
// `yt-dlp -J` (ou --dump-json) imprime un objet JSON complet sur stdout.
#[tauri::command]
async fn ytdlp_info(app: tauri::AppHandle, url: String) -> Result<YtDlpInfo, String> {
    let output = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| format!("Binaire yt-dlp introuvable : {e}"))?
        .args(["-J", "--no-warnings", "--no-playlist", &url])
        .output()
        .await
        .map_err(|e| format!("Impossible de lancer yt-dlp : {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(humanize_ytdlp_error(&stderr));
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("JSON invalide : {e}"))?;

    Ok(YtDlpInfo {
        title: v
            .get("title")
            .and_then(|s| s.as_str())
            .unwrap_or("Sans titre")
            .to_string(),
        uploader: v.get("uploader").and_then(|s| s.as_str()).map(String::from),
        duration_seconds: v.get("duration").and_then(|d| d.as_f64()),
        thumbnail: v.get("thumbnail").and_then(|s| s.as_str()).map(String::from),
        webpage_url: v
            .get("webpage_url")
            .and_then(|s| s.as_str())
            .map(String::from),
        extractor: v
            .get("extractor_key")
            .and_then(|s| s.as_str())
            .map(String::from),
    })
}

// Traduit les erreurs courantes yt-dlp en français lisible.
fn humanize_ytdlp_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("unsupported url") {
        return "Ce lien n'est pas pris en charge par yt-dlp.".into();
    }
    if lower.contains("video unavailable") || lower.contains("private video") {
        return "Vidéo indisponible (privée, supprimée ou bloquée).".into();
    }
    if lower.contains("sign in") || lower.contains("login required") {
        return "Cette vidéo demande une connexion (non supporté).".into();
    }
    if lower.contains("http error 403") {
        return "Accès refusé par le serveur (403). Réessaie plus tard.".into();
    }
    // Sinon on remonte les 3 dernières lignes utiles.
    stderr
        .lines()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n")
}

// Résultat d'un téléchargement : chemin + taille du fichier produit.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadResult {
    output_path: String,
    size_bytes: u64,
}

// Payload de progression spécifique au téléchargement : on ajoute la
// vitesse instantanée et l'ETA (info utile pour l'utilisateur sur des
// gros téléchargements).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgressPayload {
    job_id: String,
    percent: f64,
    speed: Option<String>,
    eta: Option<String>,
}

// Parse une ligne yt-dlp du type :
//   [download]   5.4% of   45.23MiB at  2.50MiB/s ETA 00:17
// Renvoie (percent, speed_str, eta_str).
fn parse_ytdlp_progress(line: &str) -> Option<(f64, Option<String>, Option<String>)> {
    let rest = line.strip_prefix("[download]")?.trim_start();
    let pct_end = rest.find('%')?;
    let percent: f64 = rest[..pct_end].trim().parse().ok()?;
    let after_pct = &rest[pct_end + 1..];
    // Speed : entre "at " et " ETA" (ou fin de ligne).
    let speed = after_pct.split("at ").nth(1).and_then(|s| {
        let until = s.find(" ETA").unwrap_or(s.len());
        let candidate = s[..until].trim();
        if candidate.is_empty() {
            None
        } else {
            Some(candidate.to_string())
        }
    });
    // ETA : ce qui vient après "ETA ".
    let eta = after_pct
        .split("ETA ")
        .nth(1)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Some((percent, speed, eta))
}

// Télécharge une vidéo (ou audio extrait) via yt-dlp.
//
// Mode :
//   "video"  → télécharge la vidéo, avec un cap optionnel de résolution
//              via `max_height` (None = best disponible)
//   "audio"  → extrait l'audio, format à choisir ("mp3" ou "m4a")
//
// La progression est émise via l'event "download-progress" (distinct de
// "video-progress" car on transporte aussi speed et eta).
//
// Performance : `--concurrent-fragments 4` télécharge 4 fragments HLS/DASH
// en parallèle. Sur des sources fragmentées (YouTube etc.), ça multiplie
// le débit effectif par 2-4×.
#[tauri::command]
async fn ytdlp_download(
    app: tauri::AppHandle,
    job_id: String,
    url: String,
    output_dir: String,
    mode: String,
    max_height: Option<u32>,
    audio_format: Option<String>,
) -> Result<DownloadResult, String> {
    let template = format!("{output_dir}/%(title)s.%(ext)s");

    let mut args: Vec<String> = vec![
        "--no-playlist".into(),
        "--no-warnings".into(),
        "--newline".into(),
        "--concurrent-fragments".into(),
        "4".into(),
        "-o".into(),
        template,
    ];

    match mode.as_str() {
        "video" => {
            if let Some(h) = max_height {
                args.push("-f".into());
                args.push(format!(
                    "bestvideo[height<={h}]+bestaudio/best[height<={h}]"
                ));
            } else {
                args.push("-f".into());
                args.push("bestvideo+bestaudio/best".into());
            }
            args.push("--merge-output-format".into());
            args.push("mp4".into());
        }
        "audio" => {
            args.push("-x".into());
            args.push("--audio-format".into());
            args.push(audio_format.clone().unwrap_or_else(|| "mp3".into()));
            args.push("--audio-quality".into());
            args.push("0".into()); // meilleure qualité
        }
        other => return Err(format!("Mode non supporté : {other}")),
    }

    // Imprime le chemin du fichier final sur stdout (yt-dlp finit par
    // afficher "[ExtractAudio] Destination: PATH" pour audio, ou pour
    // vidéo "[Merger] Merging formats into PATH". On parse pour récupérer
    // ce chemin.
    args.push(url);

    let (mut rx, _child) = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| format!("Binaire yt-dlp introuvable : {e}"))?
        .args(args)
        .spawn()
        .map_err(|e| format!("Échec du lancement de yt-dlp : {e}"))?;

    let mut stderr_buf = String::new();
    let mut final_path: Option<String> = None;
    let mut success = false;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(data) => {
                let s = String::from_utf8_lossy(&data);
                for line in s.lines() {
                    if let Some((percent, speed, eta)) = parse_ytdlp_progress(line) {
                        let _ = app.emit(
                            "download-progress",
                            DownloadProgressPayload {
                                job_id: job_id.clone(),
                                percent: percent.clamp(0.0, 100.0),
                                speed,
                                eta,
                            },
                        );
                    }
                    // Capture du chemin final.
                    // - "[ExtractAudio] Destination: /path/file.mp3"
                    // - "[Merger] Merging formats into "/path/file.mp4""
                    if let Some(idx) = line.find("Destination: ") {
                        let p = line[idx + "Destination: ".len()..].trim();
                        final_path = Some(p.to_string());
                    } else if let Some(idx) = line.find("Merging formats into") {
                        let after = line[idx + "Merging formats into".len()..].trim();
                        let cleaned = after.trim_matches('"').trim();
                        final_path = Some(cleaned.to_string());
                    }
                }
            }
            CommandEvent::Stderr(data) => {
                let s = String::from_utf8_lossy(&data);
                stderr_buf.push_str(&s);
            }
            CommandEvent::Terminated(payload) => {
                success = matches!(payload.code, Some(0));
            }
            _ => {}
        }
    }

    if !success {
        return Err(humanize_ytdlp_error(&stderr_buf));
    }

    // Émet 100% final (yt-dlp peut s'arrêter à 99% si le merger ne logue
    // pas de ligne de progression supplémentaire).
    let _ = app.emit(
        "download-progress",
        DownloadProgressPayload {
            job_id,
            percent: 100.0,
            speed: None,
            eta: None,
        },
    );

    let path = final_path.ok_or_else(|| {
        "Téléchargement terminé mais chemin du fichier introuvable.".to_string()
    })?;

    let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(DownloadResult {
        output_path: path,
        size_bytes,
    })
}

// Construit une chaîne de filtres `atempo` pour ajuster la vitesse audio.
//
// `atempo` ne supporte qu'un facteur entre 0.5 et 2.0. Pour atteindre 4x
// on chaîne `atempo=2.0,atempo=2.0`. Pour 0.25x : `atempo=0.5,atempo=0.5`.
// Pour speed = 1.0 (pas de changement), on retourne le filtre identité
// `anull` qui passe l'audio inchangé.
fn build_atempo_chain(speed: f64) -> String {
    if (speed - 1.0).abs() < 0.001 {
        return "anull".into();
    }
    let mut filters: Vec<String> = Vec::new();
    let mut remaining = speed;
    if speed > 1.0 {
        while remaining > 2.0 {
            filters.push("atempo=2.0".into());
            remaining /= 2.0;
        }
        filters.push(format!("atempo={remaining}"));
    } else {
        while remaining < 0.5 {
            filters.push("atempo=0.5".into());
            remaining *= 2.0;
        }
        filters.push(format!("atempo={remaining}"));
    }
    filters.join(",")
}

// Modifie la vitesse de lecture d'une vidéo (ralenti ou accéléré).
//
// Vidéo : on ajuste les Presentation Timestamps via `setpts=1/speed*PTS`.
//   speed = 2.0 → vidéo 2x plus rapide (durée /2)
//   speed = 0.5 → vidéo 2x plus lente (durée x2)
// Audio : on enchaîne des `atempo` pour atteindre la même vitesse en
// préservant le pitch (la voix ne devient pas chipmunk ni grave).
//
// Si `keep_audio` est faux, on droppe complètement l'audio (sortie muette).
// Utile pour les très grands facteurs où l'audio devient inintelligible.
#[tauri::command]
async fn change_speed(
    app: tauri::AppHandle,
    job_id: String,
    input_path: String,
    output_path: String,
    speed: f64,
    keep_audio: bool,
) -> Result<String, String> {
    if speed < 0.1 || speed > 8.0 {
        return Err("Vitesse hors plage (0.1× à 8×).".into());
    }
    if (speed - 1.0).abs() < 0.001 {
        return Err("Vitesse identique à la source, rien à faire.".into());
    }

    let pts_factor = 1.0 / speed;

    let filter_complex = if keep_audio {
        let atempo = build_atempo_chain(speed);
        format!("[0:v]setpts={pts_factor}*PTS[v];[0:a]{atempo}[a]")
    } else {
        format!("[0:v]setpts={pts_factor}*PTS[v]")
    };

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        input_path.clone(),
        "-filter_complex".into(),
        filter_complex,
        "-map".into(),
        "[v]".into(),
    ];
    if keep_audio {
        args.push("-map".into());
        args.push("[a]".into());
    }
    args.extend([
        "-c:v".into(),
        "libx264".into(),
        "-crf".into(),
        "20".into(),
        "-preset".into(),
        "medium".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-movflags".into(),
        "+faststart".into(),
    ]);
    if keep_audio {
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-b:a".into());
        args.push("128k".into());
    }
    args.extend([
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output_path.clone(),
    ]);

    // La durée de sortie = durée d'entrée / speed. On ne la connaît qu'après
    // le parse de stderr ; on laisse run_ffmpeg_with_progress la déterminer
    // automatiquement (ça donnera une progression scaled correcte).
    run_ffmpeg_with_progress(&app, job_id, args, None).await?;
    Ok(output_path)
}

// Recadre une vidéo dans une zone rectangulaire arbitraire.
//
// Le filtre ffmpeg `crop=W:H:X:Y` extrait un rectangle de WxH pixels à
// partir du coin (X, Y). Les valeurs reçues du frontend sont des pixels
// absolus (calculés depuis la résolution naturelle de la vidéo). On les
// force à des multiples de 2 ici : libx264 + yuv420p exige des dimensions
// paires sinon l'encodage échoue avec "width not divisible by 2".
//
// Comme on applique un filtre, on doit ré-encoder. CRF 20 = haute qualité.
#[tauri::command]
async fn crop_video(
    app: tauri::AppHandle,
    job_id: String,
    input_path: String,
    output_path: String,
    crop_x: u32,
    crop_y: u32,
    crop_width: u32,
    crop_height: u32,
) -> Result<String, String> {
    let cw = (crop_width / 2) * 2;
    let ch = (crop_height / 2) * 2;
    let cx = (crop_x / 2) * 2;
    let cy = (crop_y / 2) * 2;

    if cw < 16 || ch < 16 {
        return Err("Zone de recadrage trop petite (16 px min).".into());
    }

    let filter = format!("crop={cw}:{ch}:{cx}:{cy}");

    let args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        input_path.clone(),
        "-vf".into(),
        filter,
        "-c:v".into(),
        "libx264".into(),
        "-crf".into(),
        "20".into(),
        "-preset".into(),
        "medium".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-c:a".into(),
        "copy".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output_path.clone(),
    ];

    run_ffmpeg_with_progress(&app, job_id, args, None).await?;
    Ok(output_path)
}

// Transforme une vidéo : rotation, retournement, redimensionnement.
//
// On compose les filtres ffmpeg dans l'ordre :
//   1. Rotation (transpose)
//   2. Retournements (hflip / vflip)
//   3. Mise à l'échelle (scale)
//
// `transpose` accepte :
//   0 = 90° anti-horaire + flip vertical
//   1 = 90° horaire
//   2 = 90° anti-horaire
//   3 = 90° horaire + flip vertical
// Pour 180° on chaîne deux transpose=2.
//
// Puisqu'on applique des filtres vidéo, on est obligé de ré-encoder
// (pas de `-c copy` possible). On utilise CRF 20 = qualité haute par défaut.
#[tauri::command]
async fn transform_video(
    app: tauri::AppHandle,
    job_id: String,
    input_path: String,
    output_path: String,
    scale_height: Option<u32>,
    rotation: u32,
    flip_h: bool,
    flip_v: bool,
) -> Result<String, String> {
    let mut filters: Vec<String> = Vec::new();

    match rotation {
        90 => filters.push("transpose=1".into()),
        180 => filters.push("transpose=2,transpose=2".into()),
        270 => filters.push("transpose=2".into()),
        0 => {}
        other => return Err(format!("Rotation non supportée : {other}°")),
    }
    if flip_h {
        filters.push("hflip".into());
    }
    if flip_v {
        filters.push("vflip".into());
    }
    if let Some(h) = scale_height {
        filters.push(format!("scale=-2:{h}"));
    }

    if filters.is_empty() {
        return Err("Aucune transformation sélectionnée.".into());
    }

    let args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        input_path.clone(),
        "-vf".into(),
        filters.join(","),
        "-c:v".into(),
        "libx264".into(),
        "-crf".into(),
        "20".into(),
        "-preset".into(),
        "medium".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-c:a".into(),
        "copy".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output_path.clone(),
    ];

    run_ffmpeg_with_progress(&app, job_id, args, None).await?;
    Ok(output_path)
}

// Extrait une frame unique d'une vidéo à un instant précis.
//
// Opération rapide (1 frame, pas d'encodage vidéo), donc pas de progression
// streamée — on attend juste le résultat. `-ss` placé avant `-i` fait un
// seek rapide au keyframe le plus proche, ce qui est suffisamment précis
// pour une capture (et beaucoup plus rapide qu'un seek frame-précis).
//
// Format de sortie déterminé par l'extension du `output_path` :
//   .png → PNG sans perte
//   .jpg → JPEG, quality 2 (très haute qualité ; ffmpeg utilise une
//          échelle 2-31 où 2 = best)
#[tauri::command]
async fn extract_frame(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
    time_seconds: f64,
) -> Result<String, String> {
    let args: Vec<String> = vec![
        "-y".into(),
        "-ss".into(),
        format!("{time_seconds}"),
        "-i".into(),
        input_path,
        "-frames:v".into(),
        "1".into(),
        "-q:v".into(),
        "2".into(),
        output_path.clone(),
    ];

    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(args)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(output_path)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(humanize_ffmpeg_error(&stderr))
    }
}

// Renvoie quelques métadonnées de base d'une vidéo : durée + taille fichier.
// Utilisée par les vues vidéo pour estimer la taille post-compression et
// afficher la durée.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoInfo {
    path: String,
    file_name: String,
    duration_seconds: Option<f64>,
    size_bytes: u64,
}

// Génère N vignettes JPG d'une vidéo à intervalles réguliers.
//
// Utilisée par la vue "Découpe" pour afficher une frise sous la piste de
// trim. Les vignettes sont mises en cache (hash du chemin source + count)
// pour éviter de re-générer à chaque ouverture.
//
// Stratégie : un seul appel ffmpeg avec un filtre `select` qui sélectionne
// `count` frames réparties uniformément sur la durée. Plus rapide que N
// appels avec -ss.
#[tauri::command]
async fn generate_video_thumbnails(
    app: tauri::AppHandle,
    input_path: String,
    count: u32,
) -> Result<Vec<String>, String> {
    let count = count.clamp(2, 24);

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Dossier cache introuvable : {e}"))?;
    let thumb_dir = cache_dir.join(format!(
        "thumbs-{}-{}",
        hash_string(&input_path),
        count
    ));
    std::fs::create_dir_all(&thumb_dir)
        .map_err(|e| format!("Création du cache impossible : {e}"))?;

    // Si déjà généré, on renvoie les paths existants.
    let existing: Vec<String> = (1..=count)
        .map(|i| thumb_dir.join(format!("thumb_{i:03}.jpg")))
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    if existing.len() == count as usize {
        return Ok(existing);
    }

    // Récupère la durée pour calculer l'intervalle entre vignettes.
    let info_output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(["-hide_banner", "-i", &input_path])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&info_output.stderr);
    let duration =
        parse_duration(&stderr).ok_or_else(|| "Durée vidéo introuvable.".to_string())?;
    if duration <= 0.0 {
        return Err("Durée vidéo invalide.".into());
    }

    // Filtre fps = nombre de vignettes / durée. ffmpeg génère donc
    // exactement `count` frames réparties uniformément. scale=180:-2
    // garde le ratio (largeur divisible par 2 pour les codecs JPEG).
    let fps = count as f64 / duration;
    let filter = format!("fps={fps},scale=180:-2");
    let out_pattern = thumb_dir
        .join("thumb_%03d.jpg")
        .to_string_lossy()
        .to_string();

    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args([
            "-y",
            "-i",
            &input_path,
            "-vf",
            &filter,
            "-frames:v",
            &count.to_string(),
            "-q:v",
            "5",
            &out_pattern,
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(humanize_ffmpeg_error(&stderr));
    }

    let paths: Vec<String> = (1..=count)
        .map(|i| thumb_dir.join(format!("thumb_{i:03}.jpg")))
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    if paths.is_empty() {
        return Err("Aucune vignette n'a pu être générée.".into());
    }

    Ok(paths)
}

#[tauri::command]
async fn get_video_info(app: tauri::AppHandle, path: String) -> Result<VideoInfo, String> {
    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(["-hide_banner", "-i", &path])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let duration_seconds = parse_duration(&stderr);

    let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let file_name = std::path::Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());

    Ok(VideoInfo {
        path,
        file_name,
        duration_seconds,
        size_bytes,
    })
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .args(["-R", &path])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// Notification macOS via AppleScript.
//
// On utilise osascript plutôt que le plugin tauri-notification parce qu'en
// mode dev, ce dernier ne déclenche pas l'affichage : le binaire debug n'est
// pas un vrai .app enregistré dans le système notification daemon de macOS.
// osascript invoque l'API NSUserNotification au niveau système et fonctionne
// en dev comme depuis un .app bundle.
//
// Les guillemets doubles dans title/body sont échappés pour ne pas casser
// la syntaxe AppleScript.
#[cfg(target_os = "macos")]
#[tauri::command]
fn system_notify(title: String, body: String) -> Result<(), String> {
    let t = title.replace('\\', "\\\\").replace('"', "\\\"");
    let b = body.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(r#"display notification "{b}" with title "{t}""#);
    std::process::Command::new("osascript")
        .args(["-e", &script])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn system_notify(_title: String, _body: String) -> Result<(), String> {
    Err("Notification disponible uniquement sur macOS".into())
}

// Joue un son système macOS. `afplay` est le lecteur audio CLI préinstallé.
// `Glass.aiff` est un son court Apple, idéal pour signaler la fin d'une tâche.
#[cfg(target_os = "macos")]
#[tauri::command]
fn play_completion_sound() -> Result<(), String> {
    std::process::Command::new("afplay")
        .arg("/System/Library/Sounds/Glass.aiff")
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn play_completion_sound() -> Result<(), String> {
    Ok(())
}

// Détecte les silences en début et fin de fichier audio.
//
// On utilise le filtre `silencedetect` qui imprime sur stderr les bornes
// de chaque zone de silence détectée :
//   [silencedetect @ ...] silence_start: 0
//   [silencedetect @ ...] silence_end: 1.234 | silence_duration: 1.234
//
// On extrait : la fin du silence initial (si à 0) → trimStart suggéré
//              le début du silence final (juste avant la fin) → trimEnd suggéré
//
// Seuils : -30 dB et minimum 0.5 s de silence pour être pris en compte.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SilenceRange {
    trim_start: f64,
    trim_end: f64,
}

#[tauri::command]
async fn detect_silence(
    app: tauri::AppHandle,
    input_path: String,
    total_duration: f64,
) -> Result<SilenceRange, String> {
    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args([
            "-hide_banner",
            "-i",
            &input_path,
            "-af",
            "silencedetect=n=-30dB:d=0.5",
            "-f",
            "null",
            "-",
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let stderr = String::from_utf8_lossy(&output.stderr);

    let mut trim_start: f64 = 0.0;
    let mut trim_end: f64 = total_duration;

    // Itère chronologiquement sur les lignes silencedetect.
    let mut last_silence_start: Option<f64> = None;
    for line in stderr.lines() {
        let line = line.trim();
        if let Some(rest) = line.split("silence_start:").nth(1) {
            if let Ok(t) = rest.trim().parse::<f64>() {
                last_silence_start = Some(t);
            }
        } else if let Some(rest) = line.split("silence_end:").nth(1) {
            // "silence_end: <t> | silence_duration: <d>"
            let t_str = rest.split('|').next().unwrap_or("").trim();
            if let Ok(t) = t_str.parse::<f64>() {
                // Si le silence commençait à 0, sa fin = nouveau début utile
                if let Some(start) = last_silence_start {
                    if start <= 0.05 && t > trim_start {
                        trim_start = t;
                    }
                }
                last_silence_start = None;
            }
        }
    }
    // Si le fichier finit en silence (pas de silence_end après un silence_start),
    // ce silence_start est le bord à raboter.
    if let Some(start) = last_silence_start {
        if start > trim_start && start < total_duration {
            trim_end = start;
        }
    }

    // Garde-fou : sélection résultante minimum 0.5 s
    if trim_end - trim_start < 0.5 {
        return Err("Aucun silence significatif détecté.".into());
    }

    Ok(SilenceRange { trim_start, trim_end })
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn reveal_in_finder(_path: String) -> Result<(), String> {
    Err("Fonction disponible uniquement sur macOS".into())
}

// Construit la barre de menu macOS native.
//
// Tauri v2 a une API pour les menus déclaratifs. Sur macOS, le menu apparaît
// dans la barre système en haut de l'écran (pas dans la fenêtre).
// Chaque MenuItem avec un id propre déclenche un événement on_menu_event qu'on
// route vers le frontend via app.emit().
fn build_menu(handle: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // Menu "Application" (devient le menu nommé d'après l'app sur macOS).
    let app_menu = Submenu::with_items(
        handle,
        "Media Studio",
        true,
        &[
            &PredefinedMenuItem::about(handle, None, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "preferences", "Préférences…", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::show_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        handle,
        "Fichier",
        true,
        &[
            &MenuItem::with_id(handle, "open_file", "Ouvrir un fichier…", true, Some("CmdOrCtrl+O"))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, None)?,
        ],
    )?;

    // Édition : on inclut les classiques pour activer Cmd+C/V dans les
    // champs texte (sinon ils ne marchent pas en webview macOS).
    let edit_menu = Submenu::with_items(
        handle,
        "Édition",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        handle,
        "Affichage",
        true,
        &[
            &MenuItem::with_id(handle, "view_extract", "Extraire l'audio", true, Some("CmdOrCtrl+1"))?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "view_convert", "Convertir une vidéo", true, Some("CmdOrCtrl+2"))?,
            &MenuItem::with_id(handle, "view_compress", "Compresser une vidéo", true, Some("CmdOrCtrl+3"))?,
            &MenuItem::with_id(handle, "view_trim", "Découpe rapide", true, Some("CmdOrCtrl+4"))?,
            &MenuItem::with_id(handle, "view_merge", "Fusionner des vidéos", true, Some("CmdOrCtrl+5"))?,
            &MenuItem::with_id(handle, "view_togif", "Vers GIF", true, Some("CmdOrCtrl+6"))?,
            &MenuItem::with_id(handle, "view_frame", "Extraire une image", true, None::<&str>)?,
            &MenuItem::with_id(handle, "view_transform", "Redimensionner / Pivoter", true, None::<&str>)?,
            &MenuItem::with_id(handle, "view_crop", "Recadrer", true, None::<&str>)?,
            &MenuItem::with_id(handle, "view_speed", "Vitesse", true, None::<&str>)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "view_download", "Télécharger une vidéo", true, None::<&str>)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "view_history", "Historique", true, Some("CmdOrCtrl+7"))?,
            &MenuItem::with_id(handle, "view_presets", "Préréglages", true, None::<&str>)?,
            &MenuItem::with_id(handle, "view_settings", "Réglages", true, Some("CmdOrCtrl+8"))?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        handle,
        "Fenêtre",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::fullscreen(handle, None)?,
        ],
    )?;

    Menu::with_items(
        handle,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            ffmpeg_version,
            get_media_info,
            generate_waveform,
            extract_audio,
            reveal_in_finder,
            system_notify,
            play_completion_sound,
            detect_silence,
            // Vague 1 vidéo
            convert_video,
            compress_video,
            fast_trim_video,
            merge_videos,
            get_video_info,
            generate_video_thumbnails,
            convert_to_gif,
            extract_frame,
            transform_video,
            crop_video,
            change_speed,
            ytdlp_version,
            ytdlp_info,
            ytdlp_download
        ])
        .setup(|app| {
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;
            Ok(())
        })
        // Tous les MenuItem custom (ids "open_file", "view_*", "preferences")
        // émettent un event consommé par le frontend.
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "open_file" => { let _ = app.emit("menu:open_file", ()); }
                "preferences" => { let _ = app.emit("menu:view", "settings"); }
                "view_extract" => { let _ = app.emit("menu:view", "extract"); }
                "view_convert" => { let _ = app.emit("menu:view", "convert"); }
                "view_compress" => { let _ = app.emit("menu:view", "compress"); }
                "view_trim" => { let _ = app.emit("menu:view", "trim"); }
                "view_merge" => { let _ = app.emit("menu:view", "merge"); }
                "view_togif" => { let _ = app.emit("menu:view", "togif"); }
                "view_frame" => { let _ = app.emit("menu:view", "frame"); }
                "view_transform" => { let _ = app.emit("menu:view", "transform"); }
                "view_crop" => { let _ = app.emit("menu:view", "crop"); }
                "view_speed" => { let _ = app.emit("menu:view", "speed"); }
                "view_download" => { let _ = app.emit("menu:view", "download"); }
                "view_history" => { let _ = app.emit("menu:view", "history"); }
                "view_presets" => { let _ = app.emit("menu:view", "presets"); }
                "view_settings" => { let _ = app.emit("menu:view", "settings"); }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application Tauri");
}
