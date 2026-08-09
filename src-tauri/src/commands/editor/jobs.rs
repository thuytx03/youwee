use super::*;

/// Execute FFmpeg command with progress tracking
#[tauri::command]
pub async fn editor_execute_ffmpeg_command(
    app: AppHandle,
    job_id: String,
    command_args: Vec<String>,
    input_path: String,
    output_path: String,
) -> Result<(), String> {
    println!("[EDITOR FFMPEG] Starting editor_execute_ffmpeg_command");
    println!("[EDITOR FFMPEG] Job ID: {}", job_id);
    println!("[EDITOR FFMPEG] Args: {:?}", command_args);
    println!("[EDITOR FFMPEG] Input: {}", input_path);
    println!("[EDITOR FFMPEG] Output: {}", output_path);

    validate_ffmpeg_args(&command_args)?;

    let ffmpeg_path = get_ffmpeg_path(&app).await.ok_or("FFmpeg not found")?;
    println!("[EDITOR FFMPEG] FFmpeg path: {:?}", ffmpeg_path);

    let metadata = editor_get_video_metadata(app.clone(), input_path.clone()).await?;
    let total_duration_secs = metadata.duration;
    let total_frames = (metadata.duration * metadata.fps) as i64;
    println!(
        "[EDITOR FFMPEG] Total duration: {} secs, Total frames: {}",
        total_duration_secs, total_frames
    );

    let mut args = command_args;
    if !args.iter().any(|a| a == "-progress") {
        let insert_pos = args.len().saturating_sub(1);
        args.insert(insert_pos, "-progress".to_string());
        args.insert(insert_pos + 1, "pipe:2".to_string());
    }

    println!("[EDITOR FFMPEG] Final args count: {}", args.len());
    for (i, arg) in args.iter().enumerate() {
        println!("[EDITOR FFMPEG]   arg[{}]: '{}'", i, arg);
    }

    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();

    {
        let mut jobs = ACTIVE_JOBS.lock().await;
        jobs.insert(job_id.clone(), cancel_tx);
    }

    println!("[EDITOR FFMPEG] Spawning FFmpeg process...");
    let mut cmd = Command::new(&ffmpeg_path);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.hide_window();
    let mut child = cmd.spawn().map_err(|e| {
        println!("[EDITOR FFMPEG] Failed to spawn: {}", e);
        format!("Failed to start FFmpeg: {}", e)
    })?;
    println!("[EDITOR FFMPEG] FFmpeg process spawned successfully");

    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
    let mut reader = BufReader::new(stderr).lines();

    let app_clone = app.clone();
    let job_id_clone = job_id.clone();

    let progress_task = tokio::spawn(async move {
        let mut current_frame: i64 = 0;
        let mut current_fps: f64 = 0.0;
        let mut current_time = String::new();
        let mut current_time_secs: f64 = 0.0;
        let mut current_size = String::new();
        let mut current_speed = String::new();
        let mut error_lines: Vec<String> = Vec::new();

        while let Ok(Some(line)) = reader.next_line().await {
            println!("[EDITOR FFMPEG STDERR] {}", line);

            if line.contains("Error") || line.contains("error") || line.contains("Invalid") {
                error_lines.push(line.clone());
            }

            if line.starts_with("frame=") {
                if let Some(val) = line.strip_prefix("frame=") {
                    current_frame = val
                        .trim()
                        .split_whitespace()
                        .next()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(current_frame);
                }
            } else if line.starts_with("fps=") {
                if let Some(val) = line.strip_prefix("fps=") {
                    current_fps = val
                        .trim()
                        .split_whitespace()
                        .next()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(current_fps);
                }
            } else if line.starts_with("out_time_us=") {
                if let Some(val) = line.strip_prefix("out_time_us=") {
                    if let Ok(us) = val.trim().parse::<i64>() {
                        current_time_secs = us as f64 / 1_000_000.0;
                    }
                }
            } else if line.starts_with("out_time=") {
                if let Some(val) = line.strip_prefix("out_time=") {
                    let time_str = val.trim();
                    current_time = if let Some(dot_pos) = time_str.find('.') {
                        time_str[..dot_pos].to_string()
                    } else {
                        time_str.to_string()
                    };
                }
            } else if line.starts_with("total_size=") {
                if let Some(val) = line.strip_prefix("total_size=") {
                    let bytes: i64 = val.trim().parse().unwrap_or(0);
                    current_size = format!("{:.1} MB", bytes as f64 / 1_000_000.0);
                }
            } else if line.starts_with("speed=") {
                if let Some(val) = line.strip_prefix("speed=") {
                    current_speed = val.trim().to_string();
                }
            } else if line == "progress=continue" || line == "progress=end" {
                let percent = if total_duration_secs > 0.0 && current_time_secs > 0.0 {
                    (current_time_secs / total_duration_secs * 100.0).min(100.0)
                } else if total_frames > 0 && current_frame > 0 {
                    (current_frame as f64 / total_frames as f64 * 100.0).min(100.0)
                } else {
                    0.0
                };

                println!(
                    "[EDITOR FFMPEG PROGRESS] time_secs={}, duration={}, percent={:.1}%",
                    current_time_secs, total_duration_secs, percent
                );

                let progress = EditorProcessingProgress {
                    job_id: job_id_clone.clone(),
                    percent,
                    frame: current_frame,
                    total_frames,
                    fps: current_fps,
                    speed: current_speed.clone(),
                    time: current_time.clone(),
                    size: current_size.clone(),
                };

                let _ = app_clone.emit("editor-progress", &progress);
            }
        }

        if !error_lines.is_empty() {
            println!("[EDITOR FFMPEG] Collected errors: {:?}", error_lines);
        }
    });

    tokio::select! {
        status = child.wait() => {
            println!("[EDITOR FFMPEG] Process exited with status: {:?}", status);
            progress_task.abort();

            {
                let mut jobs = ACTIVE_JOBS.lock().await;
                jobs.remove(&job_id);
            }

            match status {
                Ok(exit_status) if exit_status.success() => {
                    println!("[EDITOR FFMPEG] Success! Output: {}", output_path);
                    let _ = app.emit("editor-progress", EditorProcessingProgress {
                        job_id: job_id.clone(),
                        percent: 100.0,
                        frame: total_frames,
                        total_frames,
                        fps: 0.0,
                        speed: "done".to_string(),
                        time: "".to_string(),
                        size: "".to_string(),
                    });
                    Ok(())
                }
                Ok(exit_status) => {
                    println!("[EDITOR FFMPEG] Failed with exit code: {:?}", exit_status.code());
                    Err(format!("FFmpeg exited with code: {:?}", exit_status.code()))
                }
                Err(e) => {
                    println!("[EDITOR FFMPEG] Process error: {}", e);
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

#[tauri::command]
pub async fn editor_cancel_ffmpeg(job_id: String) -> Result<(), String> {
    let mut jobs = ACTIVE_JOBS.lock().await;
    if let Some(cancel_tx) = jobs.remove(&job_id) {
        cancel_tx.send(()).ok();
        Ok(())
    } else {
        Err("Job not found".to_string())
    }
}

#[tauri::command]
pub async fn editor_get_history(
    _app: AppHandle,
    limit: i32,
) -> Result<Vec<EditorJob>, String> {
    let conn = get_db()?;

    let mut stmt = conn
        .prepare(
            "SELECT id, input_path, output_path, task_type, user_prompt,
         ffmpeg_command, status, progress, error_message, created_at, completed_at
         FROM editor_jobs
         ORDER BY created_at DESC
         LIMIT ?1",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let jobs = stmt
        .query_map(params![limit], |row| {
            Ok(EditorJob {
                id: row.get(0)?,
                input_path: row.get(1)?,
                output_path: row.get(2)?,
                task_type: row.get(3)?,
                user_prompt: row.get(4)?,
                ffmpeg_command: row.get(5)?,
                status: row.get(6)?,
                progress: row.get(7)?,
                error_message: row.get(8)?,
                created_at: row.get(9)?,
                completed_at: row.get(10)?,
            })
        })
        .map_err(|e| format!("Query failed: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(jobs)
}

#[tauri::command]
pub async fn editor_delete_job(_app: AppHandle, id: String) -> Result<(), String> {
    let conn = get_db()?;

    conn.execute("DELETE FROM editor_jobs WHERE id = ?1", params![id])
        .map_err(|e| format!("Failed to delete job: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn editor_clear_history(_app: AppHandle) -> Result<u64, String> {
    let conn = get_db()?;

    let deleted = conn
        .execute("DELETE FROM editor_jobs", [])
        .map_err(|e| format!("Failed to clear history: {}", e))?;

    Ok(deleted as u64)
}

#[tauri::command]
pub async fn editor_save_job(
    _app: AppHandle,
    id: String,
    input_path: String,
    output_path: Option<String>,
    task_type: String,
    user_prompt: Option<String>,
    ffmpeg_command: String,
) -> Result<(), String> {
    let conn = get_db()?;
    let created_at = chrono::Utc::now().to_rfc3339();
    let status = "pending".to_string();

    conn.execute(
        "INSERT INTO editor_jobs (id, input_path, output_path, task_type, user_prompt, ffmpeg_command, status, progress, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, input_path, output_path, task_type, user_prompt, ffmpeg_command, status, 0.0, created_at],
    )
    .map_err(|e| format!("Failed to save job: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn editor_update_job(
    _app: AppHandle,
    id: String,
    status: String,
    progress: f64,
    error_message: Option<String>,
) -> Result<(), String> {
    let conn = get_db()?;

    if status == "completed" || status == "failed" || status == "cancelled" {
        let completed_at = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE editor_jobs SET status = ?1, progress = ?2, error_message = ?3, completed_at = ?4 WHERE id = ?5",
            params![status, progress, error_message, completed_at, id],
        )
        .map_err(|e| format!("Failed to update job: {}", e))?;
    } else {
        conn.execute(
            "UPDATE editor_jobs SET status = ?1, progress = ?2, error_message = ?3 WHERE id = ?4",
            params![status, progress, error_message, id],
        )
        .map_err(|e| format!("Failed to update job: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn editor_get_presets(_app: AppHandle) -> Result<Vec<EditorPreset>, String> {
    let conn = get_db()?;

    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, task_type, prompt_template, icon, created_at
         FROM editor_presets
         ORDER BY name ASC",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let presets = stmt
        .query_map([], |row| {
            Ok(EditorPreset {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                task_type: row.get(3)?,
                prompt_template: row.get(4)?,
                icon: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| format!("Query failed: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(presets)
}

#[tauri::command]
pub async fn editor_save_preset(
    _app: AppHandle,
    name: String,
    description: Option<String>,
    prompt_template: String,
    task_type: String,
) -> Result<(), String> {
    let conn = get_db()?;
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO editor_presets (id, name, description, task_type, prompt_template, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, name, description, task_type, prompt_template, created_at],
    )
    .map_err(|e| format!("Failed to save preset: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn editor_delete_preset(_app: AppHandle, id: String) -> Result<(), String> {
    let conn = get_db()?;

    conn.execute("DELETE FROM editor_presets WHERE id = ?1", params![id])
        .map_err(|e| format!("Failed to delete preset: {}", e))?;

    Ok(())
}

/// Finalize an Elah export: move the MP4 the frontend already wrote to a temp
/// file (via the fs plugin's binary channel — passing the bytes through invoke
/// args froze the UI on large exports) into its destination and record the
/// result in editor_jobs. Returns the written file path.
#[tauri::command]
pub async fn editor_save_export(
    _app: AppHandle,
    temp_path: String,
    output_path: String,
    input_name: Option<String>,
) -> Result<String, String> {
    let src = Path::new(&temp_path);
    if !src.exists() {
        return Err(format!("Temp export file not found: {}", temp_path));
    }
    let path = Path::new(&output_path);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create output directory: {}", e))?;
    }

    // rename is instant on the same volume; fall back to copy across volumes.
    if tokio::fs::rename(src, path).await.is_err() {
        tokio::fs::copy(src, path)
            .await
            .map_err(|e| format!("Failed to write exported file: {}", e))?;
        let _ = tokio::fs::remove_file(src).await;
    }

    // Record in history (best-effort — a DB error should not lose the file).
    if let Ok(conn) = get_db() {
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let input = input_name.unwrap_or_else(|| "timeline".to_string());
        let _ = conn.execute(
            "INSERT INTO editor_jobs (id, input_path, output_path, task_type, user_prompt, ffmpeg_command, status, progress, created_at, completed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id,
                input,
                output_path,
                "elah_export",
                Option::<String>::None,
                "[elah webcodecs export]",
                "completed",
                100.0,
                now,
                now
            ],
        );
    }

    Ok(output_path)
}
