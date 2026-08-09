use super::*;
use crate::services::{
    extract_audio_for_whisper, synthesize_gemini, synthesize_openai, transcribe_audio,
    WhisperResponseFormat,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsResult {
    /// Absolute path to the generated WAV file.
    pub path: String,
    /// Final audio duration in milliseconds (after any speed-fit).
    pub duration_ms: i64,
    /// Speed factor applied to fit the window (1.0 = unchanged).
    pub speed: f64,
}

// Voiceover timing (phương án A+, theo VideoLingo): if the synthesized clip is
// longer than the subtitle window, speed it up with atempo so it fits.
//
// MAX_SPEED is the ceiling past which the voice starts to sound unnatural. It
// has to be well above 1.5: translating into a more verbose language (EN → VI
// routinely runs 30-50% longer) regularly needs ~1.6-1.8x to fit the original
// cue, and clipping the speed there instead let every long line overflow into
// the next cue — which is what made the voiceover drift behind the subtitles.
const MIN_SPEED: f64 = 1.0;
const MAX_SPEED: f64 = 2.0;

fn tts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Failed to get app data directory")?
        .join("tts");
    std::fs::create_dir_all(&dir).ok();
    Ok(dir)
}

/// Duration in seconds of an in-memory WAV file, from its header alone
/// (data chunk length / byte rate). Both TTS providers hand us WAV — OpenAI
/// with response_format "wav", Gemini wrapped by pcm_s16le_to_wav — so this
/// avoids spawning ffprobe once per subtitle line.
fn wav_duration_seconds(bytes: &[u8]) -> Option<f64> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut pos = 12usize;
    let mut byte_rate: Option<u32> = None;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().ok()?) as usize;
        if id == b"fmt " {
            if pos + 20 > bytes.len() {
                return None;
            }
            byte_rate = Some(u32::from_le_bytes(bytes[pos + 16..pos + 20].try_into().ok()?));
        } else if id == b"data" {
            let rate = byte_rate? as f64;
            if rate <= 0.0 {
                return None;
            }
            // A header can claim more data than the file holds (truncated
            // stream); the bytes actually present are the ground truth.
            let available = bytes.len() - pos - 8;
            return Some(size.min(available) as f64 / rate);
        }
        // Chunks are word-aligned: odd sizes carry a pad byte.
        pos += 8 + size + (size & 1);
    }
    None
}

/// Measure an audio file's duration (seconds) via ffprobe.
async fn probe_audio_duration(app: &AppHandle, path: &str) -> Option<f64> {
    let ffprobe = get_ffprobe_path(app).await?;
    let mut cmd = Command::new(&ffprobe);
    cmd.args([
        "-v",
        "quiet",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
    ]);
    cmd.hide_window();
    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).trim().parse::<f64>().ok()
}

/// Transcribe a video's audio to SRT via Whisper, from a video file on disk.
/// The editor's media assets are browser blob URLs (no real file path), so the
/// panel writes the blob to a temp file via the fs plugin's binary channel and
/// passes the path here. Sending the bytes through invoke args (JSON-serialized
/// number array) froze the UI for large videos.
#[tauri::command]
pub async fn editor_transcribe_video(
    app: AppHandle,
    video_path: String,
    api_key: String,
    language: Option<String>,
    whisper_endpoint_url: Option<String>,
    whisper_model: Option<String>,
) -> Result<String, String> {
    if api_key.is_empty() {
        return Err("Whisper API key not configured".to_string());
    }
    if !Path::new(&video_path).exists() {
        return Err(format!("Video file not found: {}", video_path));
    }
    let temp_dir = std::env::temp_dir().join(format!(
        "youwee_editor_stt_{}",
        chrono::Utc::now().timestamp_millis()
    ));
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("temp dir: {}", e))?;

    let audio_out = temp_dir.join("audio.mp3");
    let audio_out_str = audio_out.to_string_lossy().to_string();
    let ffmpeg_path = get_ffmpeg_path(&app)
        .await
        .map(|p| p.to_string_lossy().to_string());
    extract_audio_for_whisper(&video_path, &audio_out_str, ffmpeg_path.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    let result = transcribe_audio(
        &api_key,
        &audio_out_str,
        WhisperResponseFormat::Srt,
        language.as_deref(),
        whisper_endpoint_url.as_deref(),
        whisper_model.as_deref(),
    )
    .await
    .map_err(|e| e.to_string());

    std::fs::remove_dir_all(&temp_dir).ok();
    Ok(result?.text)
}

/// Synthesize one subtitle line to a WAV clip, fitted to `window_ms` (the
/// subtitle cue length) when provided. Returns path + final duration.
#[tauri::command]
pub async fn editor_tts_synthesize(
    app: AppHandle,
    provider: String,
    voice: String,
    text: String,
    model: Option<String>,
    api_key: String,
    window_ms: Option<i64>,
    index: Option<i64>,
) -> Result<TtsResult, String> {
    if text.trim().is_empty() {
        return Err("Empty text for TTS".to_string());
    }
    let model = model.unwrap_or_default();

    let dir = tts_dir(&app)?;
    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let idx = index.unwrap_or(0);
    let raw_path = dir.join(format!("tts_{}_{}_raw.wav", stamp, idx));

    // 1. Synthesize a raw WAV from the chosen provider. Cloud providers hand
    // back bytes we persist; the local (VieNeu) worker writes the file itself
    // and needs no API key.
    let bytes = match provider.to_lowercase().as_str() {
        "openai" => {
            let b = synthesize_openai(&api_key, &model, &voice, &text).await?;
            tokio::fs::write(&raw_path, &b)
                .await
                .map_err(|e| format!("Failed to write TTS audio: {}", e))?;
            b
        }
        "gemini" => {
            let b = synthesize_gemini(&api_key, &model, &voice, &text).await?;
            tokio::fs::write(&raw_path, &b)
                .await
                .map_err(|e| format!("Failed to write TTS audio: {}", e))?;
            b
        }
        "local" => {
            crate::services::synthesize_vieneu(&app, &text, &voice, &raw_path).await?;
            tokio::fs::read(&raw_path)
                .await
                .map_err(|e| format!("Failed to read local TTS audio: {}", e))?
        }
        other => return Err(format!("Unsupported TTS provider: {}", other)),
    };

    let raw_str = raw_path.to_string_lossy().to_string();
    // Header parse first (no process spawn); ffprobe only as a fallback for a
    // provider response that isn't a well-formed WAV.
    let raw_dur = match wav_duration_seconds(&bytes) {
        Some(d) => d,
        None => probe_audio_duration(&app, &raw_str).await.unwrap_or(0.0),
    };

    // 2. Speed-fit if longer than the subtitle window.
    let window_s = window_ms.map(|w| w as f64 / 1000.0).unwrap_or(0.0);
    let mut speed = 1.0_f64;
    if window_s > 0.05 && raw_dur > window_s {
        speed = (raw_dur / window_s).clamp(MIN_SPEED, MAX_SPEED);
    }

    if (speed - 1.0).abs() < 0.02 {
        let dur_ms = (raw_dur * 1000.0).round() as i64;
        return Ok(TtsResult {
            path: raw_str,
            duration_ms: dur_ms,
            speed: 1.0,
        });
    }

    // atempo accepts 0.5..2.0 per filter; our cap is exactly 2.0 so one pass suffices.
    let ffmpeg = get_ffmpeg_path(&app).await.ok_or("FFmpeg not found")?;
    let fit_path = dir.join(format!("tts_{}_{}.wav", stamp, idx));
    let fit_str = fit_path.to_string_lossy().to_string();
    let mut cmd = Command::new(&ffmpeg);
    cmd.args([
        "-y",
        "-i",
        &raw_str,
        "-filter:a",
        &format!("atempo={:.3}", speed),
        &fit_str,
    ]);
    cmd.hide_window();
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run ffmpeg atempo: {}", e))?;
    if !out.status.success() {
        // Fall back to the raw (unfitted) clip rather than failing the whole run.
        let dur_ms = (raw_dur * 1000.0).round() as i64;
        return Ok(TtsResult {
            path: raw_str,
            duration_ms: dur_ms,
            speed: 1.0,
        });
    }
    let _ = tokio::fs::remove_file(&raw_path).await;

    // atempo scales tempo by exactly `speed`, so the output duration is known
    // analytically — no need to probe the file again.
    let fit_dur = raw_dur / speed;
    Ok(TtsResult {
        path: fit_str,
        duration_ms: (fit_dur * 1000.0).round() as i64,
        speed,
    })
}
