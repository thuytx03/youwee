use super::*;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};

/// A rectangle in the SOURCE video's pixel space, already clamped inside the
/// frame by the caller (delogo rejects boxes that touch the border).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextRegion {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// Build the `-vf` chain for one mode.
///
/// - `delogo` interpolates each box from its border pixels. Best result on a
///   plain background, smears on a busy one.
/// - `blur` crops each box, blurs it, and overlays it back — always opaque, but
///   visibly a blur.
/// - `fill` paints a solid black box. Crude but absolutely covers the text.
///
/// Deliberately avoids `|` and `$(` so the string clears `validate_ffmpeg_args`.
fn build_filter(regions: &[TextRegion], mode: &str) -> Result<String, String> {
    if regions.is_empty() {
        return Err("No regions given".to_string());
    }

    match mode {
        "delogo" => Ok(regions
            .iter()
            .map(|r| format!("delogo=x={}:y={}:w={}:h={}", r.x, r.y, r.w, r.h))
            .collect::<Vec<_>>()
            .join(",")),

        "fill" => Ok(regions
            .iter()
            .map(|r| {
                format!(
                    "drawbox=x={}:y={}:w={}:h={}:color=black:t=fill",
                    r.x, r.y, r.w, r.h
                )
            })
            .collect::<Vec<_>>()
            .join(",")),

        // One split per region: isolate the box, blur it hard, composite it back
        // at the same coordinates. Chained so several regions each get their own
        // crop/blur/overlay triple.
        "blur" => {
            let mut parts: Vec<String> = Vec::new();
            let mut current = "0:v".to_string();
            for (i, r) in regions.iter().enumerate() {
                let base = format!("b{}", i);
                parts.push(format!(
                    "[{cur}]split=2[{b}main][{b}src];\
                     [{b}src]crop={w}:{h}:{x}:{y},boxblur=luma_radius=min(cw\\,ch)/6:luma_power=3[{b}blur];\
                     [{b}main][{b}blur]overlay={x}:{y}[{b}out]",
                    cur = current,
                    b = base,
                    x = r.x,
                    y = r.y,
                    w = r.w,
                    h = r.h,
                ));
                current = format!("{}out", base);
            }
            // Returned as a filter_complex, not a simple -vf chain.
            Ok(parts.join(";"))
        }

        other => Err(format!("Unknown mode: {}", other)),
    }
}

/// Remove burned-in text from a video by covering regions of the source frame.
///
/// Processes the WHOLE file so the output stays frame-for-frame aligned with the
/// input — the caller swaps a clip's source to this file and every existing
/// sourceStartFrame / durationFrames stays valid.
///
/// Output goes to `app_data_dir/cleaned/`, NOT `previews/`: the preview folder is
/// swept for files older than 7 days, which would silently break a saved draft
/// that references the cleaned video.
#[tauri::command]
pub async fn editor_remove_text_region(
    app: AppHandle,
    job_id: String,
    input_path: String,
    regions: Vec<TextRegion>,
    mode: String,
) -> Result<String, String> {
    if regions.is_empty() {
        return Err("Select at least one region to remove".to_string());
    }

    let ffmpeg_path = get_ffmpeg_path(&app)
        .await
        .ok_or("FFmpeg not found. Please install FFmpeg from the Dependencies tab.")?;

    let out_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?
        .join("cleaned");
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("Failed to create output dir: {}", e))?;

    // Cache key covers everything that changes the pixels, so re-running with
    // the same boxes and mode is free while tweaking a box re-renders.
    let mut hasher = DefaultHasher::new();
    input_path.hash(&mut hasher);
    mode.hash(&mut hasher);
    for r in &regions {
        r.x.hash(&mut hasher);
        r.y.hash(&mut hasher);
        r.w.hash(&mut hasher);
        r.h.hash(&mut hasher);
    }
    let output_path = out_dir.join(format!("clean_{:x}.mp4", hasher.finish()));
    let output_str = output_path.to_string_lossy().to_string();

    if output_path.exists() {
        return Ok(output_str);
    }

    let filter = build_filter(&regions, &mode)?;

    // Duration drives the percent readout; a failure here is not fatal.
    let (total_duration_secs, total_frames) =
        match editor_get_video_metadata(app.clone(), input_path.clone()).await {
            Ok(m) => (m.duration, (m.duration * m.fps) as i64),
            Err(_) => (0.0, 0),
        };

    let mut args: Vec<String> = vec!["-y".into(), "-i".into(), input_path.clone()];
    if mode == "blur" {
        args.push("-filter_complex".into());
        args.push(filter);
        // The last labelled output of the chain carries the composited video.
        args.push("-map".into());
        args.push(format!("[b{}out]", regions.len() - 1));
        args.push("-map".into());
        args.push("0:a?".into());
    } else {
        args.push("-vf".into());
        args.push(filter);
    }
    args.extend([
        // CRF 18 + copied audio: this is an intermediate that gets encoded again
        // on export, so it must not add its own generation loss.
        "-c:v".into(),
        "libx264".into(),
        "-crf".into(),
        "18".into(),
        "-preset".into(),
        "medium".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-c:a".into(),
        "copy".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:2".into(),
        output_str.clone(),
    ]);

    validate_ffmpeg_args(&args)?;

    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut jobs = ACTIVE_JOBS.lock().await;
        jobs.insert(job_id.clone(), cancel_tx);
    }

    let mut cmd = Command::new(&ffmpeg_path);
    cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.hide_window();
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start FFmpeg: {}", e))?;

    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
    let mut reader = BufReader::new(stderr).lines();

    let app_clone = app.clone();
    let job_id_clone = job_id.clone();
    let progress_task = tokio::spawn(async move {
        let mut current_frame: i64 = 0;
        let mut current_time_secs: f64 = 0.0;
        let mut current_speed = String::new();

        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(val) = line.strip_prefix("frame=") {
                current_frame = val
                    .trim()
                    .split_whitespace()
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(current_frame);
            } else if let Some(val) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = val.trim().parse::<i64>() {
                    current_time_secs = us as f64 / 1_000_000.0;
                }
            } else if let Some(val) = line.strip_prefix("speed=") {
                current_speed = val.trim().to_string();
            } else if line == "progress=continue" || line == "progress=end" {
                let percent = if total_duration_secs > 0.0 && current_time_secs > 0.0 {
                    (current_time_secs / total_duration_secs * 100.0).min(100.0)
                } else {
                    0.0
                };
                let _ = app_clone.emit(
                    "editor-progress",
                    EditorProcessingProgress {
                        job_id: job_id_clone.clone(),
                        percent,
                        frame: current_frame,
                        total_frames,
                        fps: 0.0,
                        speed: current_speed.clone(),
                        time: String::new(),
                        size: String::new(),
                    },
                );
            }
        }
    });

    tokio::select! {
        status = child.wait() => {
            progress_task.abort();
            {
                let mut jobs = ACTIVE_JOBS.lock().await;
                jobs.remove(&job_id);
            }
            match status {
                Ok(s) if s.success() => {
                    let _ = app.emit("editor-progress", EditorProcessingProgress {
                        job_id: job_id.clone(),
                        percent: 100.0,
                        frame: total_frames,
                        total_frames,
                        fps: 0.0,
                        speed: "done".to_string(),
                        time: String::new(),
                        size: String::new(),
                    });
                    Ok(output_str)
                }
                Ok(s) => {
                    // Leave no half-written file behind for the cache to find.
                    tokio::fs::remove_file(&output_path).await.ok();
                    Err(format!("FFmpeg exited with code: {:?}", s.code()))
                }
                Err(e) => {
                    tokio::fs::remove_file(&output_path).await.ok();
                    Err(format!("FFmpeg process error: {}", e))
                }
            }
        }
        _ = &mut cancel_rx => {
            child.kill().await.ok();
            progress_task.abort();
            tokio::fs::remove_file(&output_path).await.ok();
            {
                let mut jobs = ACTIVE_JOBS.lock().await;
                jobs.remove(&job_id);
            }
            Err("Processing cancelled".to_string())
        }
    }
}

/// Every filesystem path referenced by any saved draft's media manifest.
///
/// Read as raw JSON rather than a typed struct: the manifest shape belongs to the
/// TypeScript side and adding a field there must never break this sweep. All we
/// need is the `path` of each entry.
fn draft_referenced_paths() -> HashSet<String> {
    let mut keep = HashSet::new();
    let Ok(conn) = get_db() else { return keep };
    let Ok(mut stmt) = conn.prepare("SELECT media_json FROM editor_drafts") else {
        return keep;
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) else {
        return keep;
    };
    for media_json in rows.filter_map(|r| r.ok()) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&media_json) else {
            continue;
        };
        if let Some(entries) = value.as_array() {
            for e in entries {
                if let Some(p) = e.get("path").and_then(|p| p.as_str()) {
                    keep.insert(p.to_string());
                }
            }
        }
    }
    keep
}

/// Delete generated files in `cleaned/` that no saved draft references.
///
/// Deliberately NOT age-based like `editor_cleanup_previews`: a cleaned video is
/// the only copy of that edit, so deleting one a draft still points at would make
/// the project unopenable. Reachability from a draft is the only safe test.
///
/// Returns the number of bytes reclaimed.
#[tauri::command]
pub async fn editor_cleanup_derived(app: AppHandle) -> Result<u64, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    let dir = app_data.join("cleaned");
    let mut freed: u64 = 0;

    if dir.exists() {
        let keep = draft_referenced_paths();

        for entry in std::fs::read_dir(&dir)
            .map_err(|e| format!("Failed to read cleaned dir: {}", e))?
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if keep.contains(&path.to_string_lossy().to_string()) {
                continue;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            if std::fs::remove_file(&path).is_ok() {
                freed += size;
            }
        }
    }

    // Also sweep stale IPC staging files (tmp/ holds videos the frontend hands
    // to transcribe/export commands; both sides delete them within seconds, so
    // anything older than an hour is an orphan from a crash mid-run).
    let tmp_dir = app_data.join("tmp");
    if tmp_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&tmp_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let Ok(meta) = entry.metadata() else { continue };
                let stale = meta
                    .modified()
                    .ok()
                    .and_then(|m| m.elapsed().ok())
                    .is_some_and(|age| age.as_secs() > 3600);
                if stale && std::fs::remove_file(&path).is_ok() {
                    freed += meta.len();
                }
            }
        }
    }

    Ok(freed)
}

/// Delete one generated file, used when its asset is removed from the library.
///
/// Refuses paths outside `cleaned/` so a bug in the caller can never be turned
/// into "delete an arbitrary file", and skips anything a draft still references.
#[tauri::command]
pub async fn editor_delete_derived_file(app: AppHandle, path: String) -> Result<bool, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?
        .join("cleaned");

    let target = std::path::Path::new(&path);
    // Compare canonicalized parents: a relative path or `..` segment must not
    // escape the managed directory.
    let ok_parent = match (target.parent().map(|p| p.canonicalize()), dir.canonicalize()) {
        (Some(Ok(p)), Ok(d)) => p == d,
        _ => false,
    };
    if !ok_parent {
        return Err("Refusing to delete a file outside the managed directory".to_string());
    }

    if draft_referenced_paths().contains(&path) {
        return Ok(false);
    }

    Ok(std::fs::remove_file(target).is_ok())
}
