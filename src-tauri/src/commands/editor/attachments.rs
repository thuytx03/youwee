use super::*;

fn detect_attachment_kind(ext: &str) -> &'static str {
    let image_exts = [
        "png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "tiff", "tif",
    ];
    let video_exts = [
        "mp4", "mkv", "webm", "avi", "mov", "wmv", "flv", "m4v", "ts", "mts",
    ];
    let subtitle_exts = ["srt", "ass", "ssa", "vtt", "sub"];

    if image_exts.contains(&ext) {
        "image"
    } else if video_exts.contains(&ext) {
        "video"
    } else if subtitle_exts.contains(&ext) {
        "subtitle"
    } else {
        "other"
    }
}

/// Get attachment metadata for editor chat (image/video/subtitle)
#[tauri::command]
pub async fn editor_get_attachment_info(path: String) -> Result<EditorAttachment, String> {
    let file_path = std::path::Path::new(&path);

    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    let metadata =
        std::fs::metadata(&path).map_err(|e| format!("Failed to read file metadata: {}", e))?;

    let filename = file_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let ext = file_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let kind = detect_attachment_kind(&ext).to_string();
    let mut width = None;
    let mut height = None;
    let mut format = if ext.is_empty() {
        "unknown".to_string()
    } else {
        ext
    };

    if kind == "image" {
        if let Ok(reader) = image::ImageReader::open(&path).and_then(|r| r.with_guessed_format()) {
            if let Some(detected) = reader.format() {
                format = format!("{:?}", detected).to_lowercase();
            }
            if let Ok((w, h)) = reader.into_dimensions() {
                width = Some(w);
                height = Some(h);
            }
        }
    }

    Ok(EditorAttachment {
        path,
        filename,
        kind,
        width,
        height,
        size: metadata.len(),
        format,
    })
}

/// Get image metadata (dimensions, format, size)
#[tauri::command]
pub async fn editor_get_image_metadata(path: String) -> Result<EditorImageInfo, String> {
    let file_path = std::path::Path::new(&path);

    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    let file_size = std::fs::metadata(&path)
        .map_err(|e| format!("Failed to read file metadata: {}", e))?
        .len();

    let filename = file_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let reader = image::ImageReader::open(&path)
        .map_err(|e| format!("Failed to open image: {}", e))?
        .with_guessed_format()
        .map_err(|e| format!("Failed to detect image format: {}", e))?;

    let format = reader
        .format()
        .map(|f| format!("{:?}", f).to_lowercase())
        .unwrap_or_else(|| {
            file_path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_else(|| "unknown".to_string())
        });

    let (width, height) = reader
        .into_dimensions()
        .map_err(|e| format!("Failed to read image dimensions: {}", e))?;

    Ok(EditorImageInfo {
        path,
        filename,
        width,
        height,
        size: file_size,
        format,
    })
}
