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
// longer than the subtitle window, speed it up with atempo — but never past
// MAX_SPEED so the voice doesn't distort. Beyond that we accept slight overflow
// (the user can nudge the clip on the timeline).
const MIN_SPEED: f64 = 1.0;
const MAX_SPEED: f64 = 1.5;

fn tts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Failed to get app data directory")?
        .join("tts");
    std::fs::create_dir_all(&dir).ok();
    Ok(dir)
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

/// Transcribe a video's audio to SRT via Whisper, from raw video bytes.
/// The editor's media assets are browser blob URLs (no real file path), so the
/// panel fetches the blob and sends the bytes here rather than a path.
#[tauri::command]
pub async fn editor_transcribe_bytes(
    app: AppHandle,
    bytes: Vec<u8>,
    filename: String,
    api_key: String,
    language: Option<String>,
    whisper_endpoint_url: Option<String>,
    whisper_model: Option<String>,
) -> Result<String, String> {
    if api_key.is_empty() {
        return Err("Whisper API key not configured".to_string());
    }
    // Write the incoming video to a temp file, extract audio, transcribe as SRT.
    let temp_dir = std::env::temp_dir().join(format!("youwee_editor_stt_{}", chrono::Utc::now().timestamp_millis()));
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("temp dir: {}", e))?;
    let ext = Path::new(&filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4");
    let video_path = temp_dir.join(format!("input.{}", ext));
    tokio::fs::write(&video_path, &bytes)
        .await
        .map_err(|e| format!("write temp video: {}", e))?;

    let audio_out = temp_dir.join("audio.mp3");
    let audio_out_str = audio_out.to_string_lossy().to_string();
    let ffmpeg_path = get_ffmpeg_path(&app)
        .await
        .map(|p| p.to_string_lossy().to_string());
    extract_audio_for_whisper(
        &video_path.to_string_lossy(),
        &audio_out_str,
        ffmpeg_path.as_deref(),
    )
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

    // 1. Synthesize raw WAV bytes from the chosen provider.
    let bytes = match provider.to_lowercase().as_str() {
        "openai" => synthesize_openai(&api_key, &model, &voice, &text).await?,
        "gemini" => synthesize_gemini(&api_key, &model, &voice, &text).await?,
        other => return Err(format!("Unsupported TTS provider: {}", other)),
    };

    let dir = tts_dir(&app)?;
    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let idx = index.unwrap_or(0);
    let raw_path = dir.join(format!("tts_{}_{}_raw.wav", stamp, idx));
    tokio::fs::write(&raw_path, &bytes)
        .await
        .map_err(|e| format!("Failed to write TTS audio: {}", e))?;

    let raw_str = raw_path.to_string_lossy().to_string();
    let raw_dur = probe_audio_duration(&app, &raw_str).await.unwrap_or(0.0);

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

    // atempo accepts 0.5..2.0 per filter; our cap is 1.5 so one pass suffices.
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

    let fit_dur = probe_audio_duration(&app, &fit_str)
        .await
        .unwrap_or(raw_dur / speed);
    Ok(TtsResult {
        path: fit_str,
        duration_ms: (fit_dur * 1000.0).round() as i64,
        speed,
    })
}
