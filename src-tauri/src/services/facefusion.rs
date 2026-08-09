use crate::services::uv;
use crate::utils::CommandExt;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Tauri event carrying this tool's SetupProgress payloads.
const SETUP_EVENT: &str = "facefusion-setup";

/// Where the user's own FaceFusion checkout lives (advanced/manual mode),
/// persisted like the other dependency choices under app_data/bin.
const CONFIG_FILE: &str = "facefusion.json";

/// Pinned FaceFusion version and the Python it runs on. Bumping these is how the
/// managed install is upgraded — a new tag re-clones on the next setup.
const FACEFUSION_TAG: &str = "3.5.0";
const PYTHON_VERSION: &str = "3.12";
const FACEFUSION_REPO: &str = "https://github.com/facefusion/facefusion.git";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FaceFusionConfig {
    /// Directory containing `facefusion.py` (a user-supplied checkout).
    pub dir: Option<String>,
    /// Explicit python interpreter for a user-supplied checkout.
    pub python: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaceFusionStatus {
    pub installed: bool,
    /// "managed" (app-installed) or "manual" (user-configured), when installed.
    pub kind: Option<String>,
    pub dir: Option<String>,
    pub python: Option<String>,
    pub error: Option<String>,
    /// Provider "auto" will resolve to on this machine ("coreml"|"cuda"|"cpu"),
    /// so the UI can warn that a CPU-only box will be very slow. None until
    /// installed.
    pub auto_provider: Option<String>,
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|p| p.join("bin").join(CONFIG_FILE))
}

pub async fn get_facefusion_config(app: &AppHandle) -> FaceFusionConfig {
    let Some(path) = config_path(app) else {
        return FaceFusionConfig::default();
    };
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => FaceFusionConfig::default(),
    }
}

pub async fn set_facefusion_config(app: &AppHandle, config: &FaceFusionConfig) -> Result<(), String> {
    let path = config_path(app).ok_or("Failed to get config path")?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create bin directory: {}", e))?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    tokio::fs::write(&path, json)
        .await
        .map_err(|e| format!("Failed to save FaceFusion config: {}", e))
}

// ── Managed install layout ────────────────────────────────────────────────
//
// app_data/facefusion/          ← FaceFusion checkout (facefusion.py, .venv/)
// app_data/bin/uv[.exe]         ← the uv launcher that builds & runs it

fn managed_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|p| p.join("facefusion"))
}

fn managed_python(dir: &Path) -> PathBuf {
    if cfg!(windows) {
        dir.join(".venv").join("Scripts").join("python.exe")
    } else {
        dir.join(".venv").join("bin").join("python")
    }
}

/// A validated install: the checkout dir and the interpreter to run it with.
pub struct FaceFusionInstall {
    pub dir: PathBuf,
    pub python: PathBuf,
}

fn venv_python_candidates(dir: &Path) -> Vec<PathBuf> {
    if cfg!(windows) {
        vec![
            dir.join(".venv").join("Scripts").join("python.exe"),
            dir.join("venv").join("Scripts").join("python.exe"),
        ]
    } else {
        vec![
            dir.join(".venv").join("bin").join("python"),
            dir.join("venv").join("bin").join("python"),
        ]
    }
}

/// Resolve a runnable install, preferring the app-managed one, then a
/// user-configured checkout. Returns the kind alongside so callers can report
/// which is in use.
pub async fn resolve_facefusion(app: &AppHandle) -> Result<(FaceFusionInstall, &'static str), String> {
    // 1. Managed install.
    if let Some(dir) = managed_dir(app) {
        let python = managed_python(&dir);
        if dir.join("facefusion.py").exists() && python.exists() {
            return Ok((FaceFusionInstall { dir, python }, "managed"));
        }
    }

    // 2. User-configured checkout.
    let config = get_facefusion_config(app).await;
    let dir_str = config
        .dir
        .filter(|d| !d.trim().is_empty())
        .ok_or("FaceFusion is not installed")?;
    let dir = PathBuf::from(&dir_str);
    if !dir.join("facefusion.py").exists() {
        return Err(format!("facefusion.py not found in {}", dir_str));
    }

    if let Some(python_str) = config.python.filter(|p| !p.trim().is_empty()) {
        let python = PathBuf::from(&python_str);
        if !python.exists() {
            return Err(format!("Configured python not found: {}", python_str));
        }
        return Ok((FaceFusionInstall { dir, python }, "manual"));
    }

    for candidate in venv_python_candidates(&dir) {
        if candidate.exists() {
            return Ok((FaceFusionInstall { dir, python: candidate }, "manual"));
        }
    }

    Err(format!(
        "No python venv found in {} (looked for .venv/ and venv/). Set the python path explicitly.",
        dir_str
    ))
}

pub async fn check_facefusion_internal(app: &AppHandle) -> FaceFusionStatus {
    let config = get_facefusion_config(app).await;
    match resolve_facefusion(app).await {
        Ok((install, kind)) => FaceFusionStatus {
            installed: true,
            kind: Some(kind.to_string()),
            dir: Some(install.dir.to_string_lossy().to_string()),
            python: Some(install.python.to_string_lossy().to_string()),
            error: None,
            auto_provider: Some(best_execution_provider(app).await),
        },
        Err(e) => FaceFusionStatus {
            installed: false,
            kind: None,
            dir: config.dir,
            python: config.python,
            error: Some(e),
            auto_provider: None,
        },
    }
}

// ── setup driver ──────────────────────────────────────────────────────────
// The uv bootstrap and streaming step runner live in services::uv, shared
// with the local-TTS (VieNeu) install.

fn emit_setup(app: &AppHandle, stage: &str, percent: i32, message: &str) {
    uv::emit_setup(app, SETUP_EVENT, stage, percent, message);
}

/// Download and set up a self-contained FaceFusion install into app_data using
/// uv (which brings its own Python). Idempotent-ish: skips the clone if the
/// checkout already exists, and pip install is safe to re-run.
pub async fn install_facefusion_internal(app: &AppHandle) -> Result<FaceFusionStatus, String> {
    let dir = managed_dir(app).ok_or("Failed to resolve app data dir")?;

    let uv_bin = uv::ensure_uv(app, SETUP_EVENT).await?;

    // Clone (or reuse an existing checkout at the pinned tag).
    if !dir.join("facefusion.py").exists() {
        emit_setup(app, "clone", -1, "Cloning FaceFusion…");
        // If a partial dir is there, clear it so git clone has an empty target.
        if dir.exists() {
            tokio::fs::remove_dir_all(&dir).await.ok();
        }
        if let Some(parent) = dir.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create dir: {}", e))?;
        }
        let dir_str = dir.to_string_lossy().to_string();
        let mut cmd = Command::new("git");
        cmd.args([
            "clone",
            "--depth",
            "1",
            "--branch",
            FACEFUSION_TAG,
            FACEFUSION_REPO,
            &dir_str,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        cmd.hide_window();
        let out = cmd
            .output()
            .await
            .map_err(|e| format!("git not available: {}. Install git and retry.", e))?;
        if !out.status.success() {
            return Err(format!(
                "git clone failed: {}",
                String::from_utf8_lossy(&out.stderr)
                    .lines()
                    .last()
                    .unwrap_or("unknown error")
            ));
        }
    }

    // Create the venv with a pinned Python (uv downloads it if absent).
    emit_setup(app, "python", -1, format!("Preparing Python {}…", PYTHON_VERSION).as_str());
    // --clear: a retry after a failed install leaves a stale .venv behind, and
    // uv refuses to reuse it ("A virtual environment already exists").
    uv::run_uv_step(
        app,
        &uv_bin,
        &["venv", "--clear", "--python", PYTHON_VERSION, ".venv"],
        &dir,
        SETUP_EVENT,
        "python",
    )
    .await?;

    // Install FaceFusion's dependencies into that venv. FaceFusion's own
    // requirements.txt is internally inconsistent (it pins numpy==2.3.4 while
    // its opencv pin needs numpy<2.3.0); pip installs it anyway with a warning,
    // but uv's stricter resolver rejects it outright. An override relaxes the
    // numpy pin to the range both packages accept — numpy 2.2.x, which
    // FaceFusion runs on fine.
    emit_setup(app, "deps", -1, "Installing dependencies (this can take a while)…");
    // Written next to requirements.txt and passed by its RELATIVE name below:
    // uv mis-parses a `--override` path containing spaces (it splits at the
    // first space, e.g. ".../Library/Application Support/…" → ".../Application"),
    // and the app_data path on macOS always has one. run_uv_step runs with
    // current_dir = the checkout, so the bare filename resolves correctly.
    const OVERRIDE_FILE: &str = "youwee_overrides.txt";
    tokio::fs::write(dir.join(OVERRIDE_FILE), "numpy<2.3.0\n")
        .await
        .map_err(|e| format!("Failed to write dependency override: {}", e))?;
    let python_arg = managed_python(&dir).to_string_lossy().to_string();
    uv::run_uv_step(
        app,
        &uv_bin,
        &[
            "pip",
            "install",
            "--python",
            &python_arg,
            "--override",
            OVERRIDE_FILE,
            "-r",
            "requirements.txt",
        ],
        &dir,
        SETUP_EVENT,
        "deps",
    )
    .await?;

    let status = check_facefusion_internal(app).await;
    if !status.installed {
        emit_setup(
            app,
            "error",
            -1,
            status.error.as_deref().unwrap_or("Install did not complete"),
        );
        return Ok(status);
    }

    // Pre-download the models now, while we have a progress UI, rather than on
    // the first swap. Two reasons this is done here and partly by hand:
    //  - FaceFusion fetches ~2GB mid-swap otherwise, with a flurry of tiny
    //    per-file tqdm bars that read as "downloading 0%" in the panel.
    //  - Its own downloader stalls on the big (~500MB) swapper model from some
    //    regions and then deletes the partial file as "corrupt", so the swap
    //    exits with no output. We fetch that one file ourselves with the app's
    //    HTTP client (same one that reliably pulls uv/ffmpeg) straight from
    //    HuggingFace, which is ~20x faster than the GitHub release mirror.
    emit_setup(app, "models", -1, "Downloading the face model (~550MB, one time)…");
    if let Err(e) = download_swapper_model(app, &dir).await {
        // Not fatal on its own — force-download below may still manage it — but
        // surface it so a total failure isn't silent.
        emit_setup(app, "models", -1, &format!("Face model download issue: {}", e));
    }

    // The remaining models (detector, landmarker, mask, …) are small; let
    // FaceFusion pull them, still preferring HuggingFace. Best-effort, and
    // hard-capped: its downloader can hang in a retry spin (100% CPU) on a bad
    // connection, and this step must never wedge the install — or outlive it.
    emit_setup(app, "models", -1, "Downloading remaining models…");
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(30 * 60),
        run_facefusion(
            app,
            &dir,
            &["force-download", "--download-providers", "huggingface"],
            "models",
        ),
    )
    .await;

    emit_setup(app, "done", 100, "FaceFusion is ready.");
    Ok(status)
}

/// The swapper model FaceFusion runs by default here, and its expected files on
/// the HuggingFace mirror. inswapper_128 is the reliably-hosted standard; the
/// 3.5 default (hyperswap) fails its own validation on download.
const SWAPPER_FILES: [&str; 2] = ["inswapper_128.onnx", "inswapper_128.hash"];
const HF_MODELS_BASE: &str = "https://huggingface.co/facefusion/models-3.0.0/resolve/main";

/// Fetch the swapper model straight into `.assets/models` with the app's HTTP
/// client, streaming byte progress. Skips a file already the right size.
async fn download_swapper_model(app: &AppHandle, dir: &Path) -> Result<(), String> {
    let models_dir = dir.join(".assets").join("models");
    tokio::fs::create_dir_all(&models_dir)
        .await
        .map_err(|e| format!("Failed to create models dir: {}", e))?;

    let client = reqwest::Client::builder()
        .user_agent("Youwee")
        .build()
        .map_err(|e| e.to_string())?;

    for file_name in SWAPPER_FILES {
        let dest = models_dir.join(file_name);
        let url = format!("{}/{}", HF_MODELS_BASE, file_name);

        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Failed to reach model host: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("Model download HTTP {}", resp.status()));
        }
        let total = resp.content_length().unwrap_or(0);

        // Skip if we already have a complete copy (e.g. a re-run of setup).
        if let Ok(meta) = tokio::fs::metadata(&dest).await {
            if total > 0 && meta.len() == total {
                continue;
            }
        }

        // Stream to a temp file, then rename — a half-written .onnx must never
        // be left where FaceFusion would try to validate it.
        let tmp = models_dir.join(format!("{}.part", file_name));
        let mut file = tokio::fs::File::create(&tmp)
            .await
            .map_err(|e| format!("Failed to create model file: {}", e))?;
        let mut downloaded: u64 = 0;
        let mut last_percent: i32 = -1;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Model download error: {}", e))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Failed to write model: {}", e))?;
            downloaded += chunk.len() as u64;
            if total > 0 {
                let percent = ((downloaded as f64 / total as f64) * 100.0) as i32;
                if percent != last_percent {
                    last_percent = percent;
                    emit_setup(
                        app,
                        "models",
                        percent,
                        &format!("Downloading {} — {}%", file_name, percent),
                    );
                }
            }
        }
        file.flush().await.ok();
        drop(file);
        tokio::fs::rename(&tmp, &dest)
            .await
            .map_err(|e| format!("Failed to finalize model: {}", e))?;
    }
    Ok(())
}

/// Run `facefusion.py <args>` with the managed venv, streaming tqdm/log output
/// as setup progress under `stage`.
async fn run_facefusion(
    app: &AppHandle,
    dir: &Path,
    args: &[&str],
    stage: &str,
) -> Result<(), String> {
    let python = managed_python(dir);
    let mut cmd = Command::new(&python);
    cmd.arg("facefusion.py")
        .args(args)
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // If this future is dropped (timeout, cancelled install), take the
        // child down with it — an orphaned force-download was observed spinning
        // at 100% CPU for hours after the app closed.
        .kill_on_drop(true);
    cmd.hide_window();

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start FaceFusion: {}", e))?;

    // tqdm writes to stderr with \r; read raw so per-file bars surface as
    // progress lines instead of one giant unterminated line.
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let app_e = app.clone();
    let stage_e = stage.to_string();
    let e_task = tokio::spawn(pump_download_progress(stderr, app_e, stage_e));
    let app_o = app.clone();
    let stage_o = stage.to_string();
    let o_task = tokio::spawn(pump_download_progress(stdout, app_o, stage_o));

    let status = child
        .wait()
        .await
        .map_err(|e| format!("FaceFusion process error: {}", e))?;
    let _ = e_task.await;
    let _ = o_task.await;

    if status.success() {
        Ok(())
    } else {
        Err(format!("FaceFusion exited with code {:?}", status.code()))
    }
}

/// Stream FaceFusion's \r-delimited tqdm output as setup progress, emitting the
/// current file name so the UI can show "Downloading <model>…".
async fn pump_download_progress<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    app: AppHandle,
    stage: String,
) {
    use tokio::io::AsyncReadExt;
    let mut buf = [0u8; 4096];
    let mut pending = String::new();
    let mut last = String::new();
    loop {
        let n = match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        pending.push_str(&String::from_utf8_lossy(&buf[..n]));
        while let Some(pos) = pending.find(['\r', '\n']) {
            let seg: String = pending.drain(..=pos).collect();
            let seg = seg.trim_end_matches(['\r', '\n']).trim();
            if seg.is_empty() {
                continue;
            }
            // Surface a friendlier line for downloads: the model file name.
            let msg = if let Some(idx) = seg.find("file_name=") {
                let name = seg[idx + 10..]
                    .trim_end_matches(['[', ']', ' '])
                    .split(['[', ' '])
                    .next()
                    .unwrap_or("")
                    .to_string();
                if name.is_empty() { seg.to_string() } else { format!("Downloading {}", name) }
            } else {
                seg.to_string()
            };
            if msg != last {
                last = msg.clone();
                emit_setup(&app, &stage, -1, &msg);
            }
        }
    }
}

/// Remove the app-managed install (not a user-configured checkout).
pub async fn uninstall_facefusion_internal(app: &AppHandle) -> Result<(), String> {
    if let Some(dir) = managed_dir(app) {
        if dir.exists() {
            tokio::fs::remove_dir_all(&dir)
                .await
                .map_err(|e| format!("Failed to remove install: {}", e))?;
        }
    }
    Ok(())
}

/// Best FaceFusion execution provider available on this machine, discovered by
/// asking onnxruntime what it can actually use. GPU providers are ~8x faster
/// than CPU here, and FaceFusion defaults to CPU when none is specified — so
/// "auto" must resolve to a real accelerator, not be left blank.
///
/// Returns FaceFusion's provider name ("coreml" | "cuda" | "cpu"), matching the
/// values accepted by `--execution-providers`.
pub async fn best_execution_provider(app: &AppHandle) -> String {
    let Ok((install, _)) = resolve_facefusion(app).await else {
        return "cpu".to_string();
    };
    let mut cmd = Command::new(&install.python);
    cmd.arg("-c")
        .arg("import onnxruntime as o; print(','.join(o.get_available_providers()))")
        .current_dir(&install.dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    cmd.hide_window();

    let Ok(out) = cmd.output().await else {
        return "cpu".to_string();
    };
    let avail = String::from_utf8_lossy(&out.stdout);
    // Preference order: CUDA (NVIDIA) → CoreML (Apple) → CPU. onnxruntime lists
    // whatever the platform build supports; pick the first accelerator present.
    if avail.contains("CUDAExecutionProvider") {
        "cuda".to_string()
    } else if avail.contains("CoreMLExecutionProvider") {
        "coreml".to_string()
    } else {
        "cpu".to_string()
    }
}

/// Disk usage of the managed install, broken down so the UI can show what a
/// cleanup would reclaim. Sizes are bytes; a missing part is 0.
#[derive(Debug, Clone, Serialize)]
pub struct FaceFusionStorage {
    pub installed: bool,
    /// Whether the app manages this install (only a managed one is removable here).
    pub managed: bool,
    /// AI model cache (.assets) — safe to clear; re-downloads on next swap.
    pub models_bytes: u64,
    /// Everything else (checkout, venv, bundled Python) — removed only by uninstall.
    pub runtime_bytes: u64,
    /// models + runtime.
    pub total_bytes: u64,
}

/// Sum the sizes of all files under `path` (recursive). Blocking, so callers
/// run it on a blocking thread.
fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            total += dir_size(&entry.path());
        } else {
            total += meta.len();
        }
    }
    total
}

pub async fn facefusion_storage_internal(app: &AppHandle) -> FaceFusionStorage {
    let Some(dir) = managed_dir(app) else {
        return FaceFusionStorage {
            installed: false,
            managed: false,
            models_bytes: 0,
            runtime_bytes: 0,
            total_bytes: 0,
        };
    };
    let managed = dir.join("facefusion.py").exists();

    // Size the two parts off the main thread — a full checkout is thousands of files.
    let dir_clone = dir.clone();
    let (models, total) = tokio::task::spawn_blocking(move || {
        let assets = dir_clone.join(".assets");
        let models = if assets.exists() { dir_size(&assets) } else { 0 };
        let total = if dir_clone.exists() { dir_size(&dir_clone) } else { 0 };
        (models, total)
    })
    .await
    .unwrap_or((0, 0));

    FaceFusionStorage {
        installed: managed,
        managed,
        models_bytes: models,
        runtime_bytes: total.saturating_sub(models),
        total_bytes: total,
    }
}

/// Delete the model cache (.assets) without touching the install. Models
/// re-download on the next swap. Returns bytes reclaimed.
pub async fn clean_facefusion_models_internal(app: &AppHandle) -> Result<u64, String> {
    let Some(dir) = managed_dir(app) else {
        return Ok(0);
    };
    let assets = dir.join(".assets");
    if !assets.exists() {
        return Ok(0);
    }
    let freed = {
        let assets = assets.clone();
        tokio::task::spawn_blocking(move || dir_size(&assets))
            .await
            .unwrap_or(0)
    };
    tokio::fs::remove_dir_all(&assets)
        .await
        .map_err(|e| format!("Failed to clear model cache: {}", e))?;
    Ok(freed)
}
