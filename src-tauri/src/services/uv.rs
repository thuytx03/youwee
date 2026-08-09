// Shared uv (Astral) bootstrap for app-managed Python tools.
//
// FaceFusion (face swap) and VieNeu (local TTS) each get a self-contained
// install under app_data/<tool>/ with their own venv; both are built and run
// by the single uv launcher this module downloads to app_data/bin/uv.
use crate::utils::{extract_tar_gz, extract_zip, CommandExt};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// Progress payload shared by every tool's setup flow; the Tauri event name
/// ("facefusion-setup", "vieneu-setup", …) identifies the tool.
#[derive(Debug, Clone, Serialize)]
pub struct SetupProgress {
    /// Tool-specific stage id, e.g. "download-uv" | "python" | "deps" | "done".
    pub stage: String,
    /// 0..100 within the current stage, or -1 when indeterminate.
    pub percent: i32,
    /// A human-readable status line (the latest tool output).
    pub message: String,
}

pub fn emit_setup(app: &AppHandle, event: &str, stage: &str, percent: i32, message: &str) {
    let _ = app.emit(
        event,
        SetupProgress {
            stage: stage.to_string(),
            percent,
            message: message.to_string(),
        },
    );
}

pub fn uv_path(app: &AppHandle) -> Option<PathBuf> {
    let name = if cfg!(windows) { "uv.exe" } else { "uv" };
    app.path()
        .app_data_dir()
        .ok()
        .map(|p| p.join("bin").join(name))
}

fn uv_download_url() -> Result<String, String> {
    let base = "https://github.com/astral-sh/uv/releases/latest/download";
    let asset = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "uv-aarch64-apple-darwin.tar.gz",
        ("macos", "x86_64") => "uv-x86_64-apple-darwin.tar.gz",
        ("windows", "x86_64") => "uv-x86_64-pc-windows-msvc.zip",
        ("linux", "x86_64") => "uv-x86_64-unknown-linux-gnu.tar.gz",
        ("linux", "aarch64") => "uv-aarch64-unknown-linux-gnu.tar.gz",
        (os, arch) => return Err(format!("Unsupported platform for uv: {}-{}", os, arch)),
    };
    Ok(format!("{}/{}", base, asset))
}

/// Ensure the uv launcher exists under app_data/bin, downloading it if missing.
/// Emits a "download-uv" stage on `event` while fetching.
pub async fn ensure_uv(app: &AppHandle, event: &str) -> Result<PathBuf, String> {
    let path = uv_path(app).ok_or("Failed to resolve app data dir")?;
    if path.exists() {
        return Ok(path);
    }

    emit_setup(app, event, "download-uv", -1, "Downloading uv…");

    let bin_dir = path.parent().ok_or("Bad uv path")?.to_path_buf();
    tokio::fs::create_dir_all(&bin_dir)
        .await
        .map_err(|e| format!("Failed to create bin dir: {}", e))?;

    let url = uv_download_url()?;
    let client = reqwest::Client::builder()
        .user_agent("Youwee")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to download uv: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("uv download failed: HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read uv download: {}", e))?;

    let target = if cfg!(windows) { "uv.exe" } else { "uv" };
    if url.ends_with(".zip") {
        extract_zip(&bytes, &bin_dir, target).await?;
    } else {
        extract_tar_gz(&bytes, &bin_dir, target).await?;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(&path, perms);
        }
    }

    if !path.exists() {
        return Err("uv binary missing after extraction".to_string());
    }
    Ok(path)
}

/// Run one uv command in `cwd`, streaming its output as setup progress on
/// `event` under `stage`. Fails with the tail of the output on non-zero exit.
/// uv's own Python downloads land under `cwd`/.python so a manual delete of
/// the tool dir leaves nothing behind elsewhere.
pub async fn run_uv_step(
    app: &AppHandle,
    uv: &Path,
    args: &[&str],
    cwd: &Path,
    event: &str,
    stage: &str,
) -> Result<(), String> {
    let mut cmd = Command::new(uv);
    cmd.args(args)
        .current_dir(cwd)
        .env("UV_PYTHON_INSTALL_DIR", cwd.join(".python"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Dropped future (cancelled install) must not leave uv running.
        .kill_on_drop(true);
    cmd.hide_window();

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start uv: {}", e))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let app_out = app.clone();
    let event_out = event.to_string();
    let stage_out = stage.to_string();
    let tail_out = tokio::spawn(async move {
        let mut tail = String::new();
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            emit_setup(&app_out, &event_out, &stage_out, -1, &line);
            push_tail(&mut tail, &line);
        }
        tail
    });
    let app_err = app.clone();
    let event_err = event.to_string();
    let stage_err = stage.to_string();
    let tail_err = tokio::spawn(async move {
        let mut tail = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            emit_setup(&app_err, &event_err, &stage_err, -1, &line);
            push_tail(&mut tail, &line);
        }
        tail
    });

    let status = child
        .wait()
        .await
        .map_err(|e| format!("uv process error: {}", e))?;
    let out = tail_out.await.unwrap_or_default();
    let err = tail_err.await.unwrap_or_default();

    if status.success() {
        Ok(())
    } else {
        let combined = format!("{}\n{}", out, err);
        let tail: Vec<&str> = combined.lines().filter(|l| !l.trim().is_empty()).collect();
        let tail = tail
            .iter()
            .rev()
            .take(6)
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        Err(format!("uv {} failed:\n{}", args.first().unwrap_or(&""), tail))
    }
}

fn push_tail(tail: &mut String, line: &str) {
    if tail.len() > 4000 {
        tail.drain(..2000);
    }
    tail.push_str(line);
    tail.push('\n');
}
