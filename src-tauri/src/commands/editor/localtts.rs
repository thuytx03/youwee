use super::*;
use crate::services::{
    add_vieneu_voice, cached_sample_path, check_vieneu_internal, clean_vieneu_models_internal,
    delete_vieneu_generation, delete_vieneu_voice, get_engine_config,
    install_vieneu_internal, set_engine_config, synthesize_vieneu, LocalTtsEngineConfig,
    list_vieneu_generations, list_vieneu_voices, record_vieneu_generation, warm_worker,
    uninstall_vieneu_internal, update_vieneu_internal, vieneu_storage_internal,
    vieneu_version_internal, LocalTtsStatus, LocalTtsStorage, LocalTtsVersion, LocalTtsVoices,
    TtsGeneration, VoiceProfile,
};

#[tauri::command]
pub async fn editor_local_tts_status(app: AppHandle) -> Result<LocalTtsStatus, String> {
    Ok(check_vieneu_internal(&app).await)
}

#[tauri::command]
pub async fn editor_local_tts_install(app: AppHandle) -> Result<LocalTtsStatus, String> {
    install_vieneu_internal(&app).await
}

#[tauri::command]
pub async fn editor_local_tts_uninstall(app: AppHandle) -> Result<LocalTtsStatus, String> {
    uninstall_vieneu_internal(&app).await?;
    Ok(check_vieneu_internal(&app).await)
}

#[tauri::command]
pub async fn editor_local_tts_voices(app: AppHandle) -> Result<LocalTtsVoices, String> {
    list_vieneu_voices(&app).await
}

/// Start the synthesis worker ahead of time (fire-and-forget from the UI) so
/// the first preview doesn't pay for model loading.
#[tauri::command]
pub async fn editor_local_tts_warm(app: AppHandle) -> Result<(), String> {
    warm_worker(&app).await
}

/// Synthesize (or reuse) a voice's preview sample. Samples are cached on disk
/// keyed by voice + text, so repeat previews — including the first one after
/// an app restart — return instantly instead of re-synthesizing.
#[tauri::command]
pub async fn editor_local_tts_sample(
    app: AppHandle,
    voice: String,
    text: String,
) -> Result<String, String> {
    let path = cached_sample_path(&app, &voice, &text)
        .await
        .ok_or("Failed to resolve app data dir")?;
    if tokio::fs::metadata(&path).await.is_ok() {
        return Ok(path.to_string_lossy().to_string());
    }
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create samples dir: {}", e))?;
    }
    synthesize_vieneu(&app, &text, &voice, &path).await?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn editor_local_tts_engine_config(
    app: AppHandle,
) -> Result<LocalTtsEngineConfig, String> {
    Ok(get_engine_config(&app).await)
}

#[tauri::command]
pub async fn editor_local_tts_set_engine_config(
    app: AppHandle,
    precision: String,
) -> Result<LocalTtsEngineConfig, String> {
    set_engine_config(&app, &LocalTtsEngineConfig { precision }).await?;
    Ok(get_engine_config(&app).await)
}

/// Clone a voice from an audio file the user picked (any format ffmpeg reads).
#[tauri::command]
pub async fn editor_local_tts_add_voice(
    app: AppHandle,
    name: String,
    source_path: String,
) -> Result<VoiceProfile, String> {
    let ffmpeg = get_ffmpeg_path(&app).await.ok_or("FFmpeg not found")?;
    add_vieneu_voice(&app, &name, &source_path, &ffmpeg).await
}

#[tauri::command]
pub async fn editor_local_tts_delete_voice(app: AppHandle, id: String) -> Result<(), String> {
    delete_vieneu_voice(&app, &id).await
}

/// Record one studio-generated audio in the persistent history.
#[tauri::command]
pub async fn editor_local_tts_record_generation(
    app: AppHandle,
    text: String,
    voice_label: String,
    path: String,
    duration_ms: i64,
) -> Result<TtsGeneration, String> {
    record_vieneu_generation(&app, &text, &voice_label, &path, duration_ms).await
}

#[tauri::command]
pub async fn editor_local_tts_generations(app: AppHandle) -> Result<Vec<TtsGeneration>, String> {
    Ok(list_vieneu_generations(&app).await)
}

#[tauri::command]
pub async fn editor_local_tts_delete_generation(app: AppHandle, id: String) -> Result<(), String> {
    delete_vieneu_generation(&app, &id).await
}

/// Installed/pinned version; pass check_remote to also query PyPI.
#[tauri::command]
pub async fn editor_local_tts_version(
    app: AppHandle,
    check_remote: Option<bool>,
) -> Result<LocalTtsVersion, String> {
    Ok(vieneu_version_internal(&app, check_remote.unwrap_or(false)).await)
}

#[tauri::command]
pub async fn editor_local_tts_update(
    app: AppHandle,
    version: Option<String>,
) -> Result<LocalTtsVersion, String> {
    update_vieneu_internal(&app, version).await
}

#[tauri::command]
pub async fn editor_local_tts_storage(app: AppHandle) -> Result<LocalTtsStorage, String> {
    Ok(vieneu_storage_internal(&app).await)
}

#[tauri::command]
pub async fn editor_local_tts_clean_models(app: AppHandle) -> Result<u64, String> {
    clean_vieneu_models_internal(&app).await
}
