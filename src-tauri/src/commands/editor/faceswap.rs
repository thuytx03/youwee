use super::*;
use crate::services::{
    best_execution_provider, check_facefusion_internal, clean_facefusion_models_internal,
    facefusion_storage_internal, get_facefusion_config, install_facefusion_internal,
    resolve_facefusion, set_facefusion_config, uninstall_facefusion_internal, FaceFusionConfig,
    FaceFusionStatus, FaceFusionStorage,
};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use tokio::io::AsyncReadExt;

#[tauri::command]
pub async fn check_facefusion(app: AppHandle) -> Result<FaceFusionStatus, String> {
    Ok(check_facefusion_internal(&app).await)
}

/// Download and set up an app-managed FaceFusion install (uv + Python + deps).
/// Streams progress via the `facefusion-setup` event.
#[tauri::command]
pub async fn install_facefusion(app: AppHandle) -> Result<FaceFusionStatus, String> {
    install_facefusion_internal(&app).await
}

#[tauri::command]
pub async fn uninstall_facefusion(app: AppHandle) -> Result<FaceFusionStatus, String> {
    uninstall_facefusion_internal(&app).await?;
    Ok(check_facefusion_internal(&app).await)
}

/// Disk usage of the managed install, for the Storage settings section.
#[tauri::command]
pub async fn facefusion_storage(app: AppHandle) -> Result<FaceFusionStorage, String> {
    Ok(facefusion_storage_internal(&app).await)
}

/// Clear the model cache (.assets) without uninstalling. Returns bytes freed.
#[tauri::command]
pub async fn clean_facefusion_models(app: AppHandle) -> Result<u64, String> {
    clean_facefusion_models_internal(&app).await
}

#[tauri::command]
pub async fn get_facefusion_config_cmd(app: AppHandle) -> Result<FaceFusionConfig, String> {
    Ok(get_facefusion_config(&app).await)
}

#[tauri::command]
pub async fn set_facefusion_config_cmd(
    app: AppHandle,
    dir: Option<String>,
    python: Option<String>,
) -> Result<FaceFusionStatus, String> {
    set_facefusion_config(&app, &FaceFusionConfig { dir, python }).await?;
    Ok(check_facefusion_internal(&app).await)
}

/// Latest "NN%" in a chunk of tqdm output, if any. FaceFusion redraws its bars
/// with carriage returns, so this runs over \r-separated segments, not lines.
fn parse_percent(segment: &str) -> Option<f64> {
    let bytes = segment.as_bytes();
    let mut result = None;
    for (i, &b) in bytes.iter().enumerate() {
        if b != b'%' {
            continue;
        }
        let mut start = i;
        while start > 0 && bytes[start - 1].is_ascii_digit() {
            start -= 1;
        }
        if start < i {
            if let Ok(v) = segment[start..i].parse::<f64>() {
                if (0.0..=100.0).contains(&v) {
                    result = Some(v);
                }
            }
        }
    }
    result
}

/// The tqdm bar's label ("Analysing", "Processing", …), shown as the job stage.
fn parse_stage(segment: &str) -> Option<String> {
    let label = segment.split(':').next()?.trim();
    if label.is_empty() || !label.chars().all(|c| c.is_alphabetic() || c == ' ') {
        return None;
    }
    Some(label.to_string())
}

/// Forward FaceFusion's console progress as editor-progress events. Reads raw
/// bytes because tqdm separates updates with \r, which line readers never yield.
async fn pump_progress<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    app: AppHandle,
    job_id: String,
) -> String {
    let mut buf = [0u8; 4096];
    let mut pending = String::new();
    let mut tail = String::new();
    let mut last_emitted: i64 = -1;

    loop {
        let n = match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        pending.push_str(&String::from_utf8_lossy(&buf[..n]));

        while let Some(pos) = pending.find(['\r', '\n']) {
            let segment: String = pending.drain(..=pos).collect();
            let segment = segment.trim_end_matches(['\r', '\n']);
            if segment.trim().is_empty() {
                continue;
            }
            // Keep the last few real lines for the error message on failure.
            if tail.len() > 4000 {
                tail.drain(..2000);
            }
            tail.push_str(segment);
            tail.push('\n');

            if let Some(percent) = parse_percent(segment) {
                let rounded = percent.round() as i64;
                if rounded != last_emitted {
                    last_emitted = rounded;
                    let _ = app.emit(
                        "editor-progress",
                        EditorProcessingProgress {
                            job_id: job_id.clone(),
                            percent,
                            frame: 0,
                            total_frames: 0,
                            fps: 0.0,
                            speed: parse_stage(segment).unwrap_or_default(),
                            time: String::new(),
                            size: String::new(),
                        },
                    );
                }
            }
        }
    }
    tail
}

/// Swap the face(s) in `target_video` with the face from `source_image` by
/// running the user's FaceFusion install headlessly.
///
/// Output goes to `app_data_dir/cleaned/` so it shares the derived-file
/// lifecycle with text removal: swept by `editor_cleanup_derived` when no draft
/// references it, deletable via `editor_delete_derived_file`.
#[tauri::command]
pub async fn editor_face_swap(
    app: AppHandle,
    job_id: String,
    source_image: String,
    target_video: String,
    enhance: bool,
    provider: Option<String>,
) -> Result<String, String> {
    if !Path::new(&source_image).exists() {
        return Err(format!("Source image not found: {}", source_image));
    }
    if !Path::new(&target_video).exists() {
        return Err(format!("Target video not found: {}", target_video));
    }

    let (install, _kind) = resolve_facefusion(&app).await?;

    let out_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?
        .join("cleaned");
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("Failed to create output dir: {}", e))?;

    // Same inputs + same options → same file; re-running a finished swap is
    // free. Provider is deliberately NOT part of the key: it changes speed, not
    // the output pixels, so CPU and GPU runs should share one cached result.
    let mut hasher = DefaultHasher::new();
    source_image.hash(&mut hasher);
    target_video.hash(&mut hasher);
    enhance.hash(&mut hasher);
    let output_path = out_dir.join(format!("swap_{:x}.mp4", hasher.finish()));
    let output_str = output_path.to_string_lossy().to_string();

    if output_path.exists() {
        return Ok(output_str);
    }

    let mut args: Vec<String> = vec![
        "facefusion.py".into(),
        "headless-run".into(),
        "--source-paths".into(),
        source_image,
        "--target-path".into(),
        target_video,
        "--output-path".into(),
        output_str.clone(),
        "--processors".into(),
        "face_swapper".into(),
        // Pin the swapper model: FaceFusion 3.5's default (hyperswap_1a_256)
        // fails its own source/hash validation on download, aborting the swap
        // with no output. inswapper_128 is the long-standing, reliably-hosted
        // model.
        "--face-swapper-model".into(),
        "inswapper_128".into(),
        // Prefer HuggingFace over the (very slow from some regions) GitHub
        // release mirror so a model still missing after setup downloads fast
        // enough to pass validation instead of timing out mid-swap.
        "--download-providers".into(),
        "huggingface".into(),
    ];
    if enhance {
        args.push("face_enhancer".into());
    }
    // Resolve the execution provider. "auto" (the default) must become a real
    // accelerator — FaceFusion runs on CPU when none is given, which is ~8x
    // slower than CoreML/CUDA here. An explicit choice is passed through as-is.
    let resolved_provider = match provider.as_deref() {
        Some(p) if !p.is_empty() && p != "auto" => p.to_string(),
        _ => best_execution_provider(&app).await,
    };
    args.push("--execution-providers".into());
    args.push(resolved_provider);

    // Thread count scaled to the actual machine, not hard-coded. The CPU-bound
    // stages (decode, detect, merge, encode) parallelize; the GPU inference does
    // not, so past a handful of threads there's no gain (measured: 4 and 8 tied
    // on an 8-core Mac). Use about half the cores so a weaker Windows box — or a
    // user doing other work — stays responsive, clamped to a sane 2..8 band.
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let threads = (cores / 2).clamp(2, 8);
    args.push("--execution-thread-count".into());
    args.push(threads.to_string());

    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut jobs = ACTIVE_JOBS.lock().await;
        jobs.insert(job_id.clone(), cancel_tx);
    }

    let mut cmd = Command::new(&install.python);
    cmd.args(&args)
        .current_dir(&install.dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.hide_window();
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start FaceFusion: {}", e))?;

    // tqdm writes to stderr, log lines to stdout; watch both so progress and
    // error text survive whichever stream FaceFusion picks for them.
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
    let out_task = tokio::spawn(pump_progress(stdout, app.clone(), job_id.clone()));
    let err_task = tokio::spawn(pump_progress(stderr, app.clone(), job_id.clone()));

    let result = tokio::select! {
        status = child.wait() => {
            let stdout_tail = out_task.await.unwrap_or_default();
            let stderr_tail = err_task.await.unwrap_or_default();
            match status {
                // FaceFusion can exit 0 without writing output (e.g. its content
                // filter blocked the media), so success is "the file exists".
                Ok(s) if s.success() && output_path.exists() => {
                    let _ = app.emit("editor-progress", EditorProcessingProgress {
                        job_id: job_id.clone(),
                        percent: 100.0,
                        frame: 0,
                        total_frames: 0,
                        fps: 0.0,
                        speed: "done".to_string(),
                        time: String::new(),
                        size: String::new(),
                    });
                    Ok(output_str)
                }
                Ok(s) => {
                    tokio::fs::remove_file(&output_path).await.ok();
                    let tail: String = format!("{}{}", stdout_tail, stderr_tail)
                        .lines()
                        .rev()
                        .take(8)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect::<Vec<_>>()
                        .join("\n");
                    if s.success() {
                        Err(format!("FaceFusion produced no output.\n{}", tail))
                    } else {
                        Err(format!("FaceFusion exited with code {:?}.\n{}", s.code(), tail))
                    }
                }
                Err(e) => {
                    tokio::fs::remove_file(&output_path).await.ok();
                    Err(format!("FaceFusion process error: {}", e))
                }
            }
        }
        _ = &mut cancel_rx => {
            child.kill().await.ok();
            out_task.abort();
            err_task.abort();
            tokio::fs::remove_file(&output_path).await.ok();
            Err("Processing cancelled".to_string())
        }
    };

    {
        let mut jobs = ACTIVE_JOBS.lock().await;
        jobs.remove(&job_id);
    }
    result
}
