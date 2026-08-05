use super::*;

/// Columns shared by the summary query. Kept as one const so the SELECT list and
/// the row-index mapping below can't drift apart.
const SUMMARY_COLUMNS: &str = "id, name, schema_version, fps, stage_width, stage_height, \
     thumbnail_path, duration_frames, created_at, updated_at";

#[tauri::command]
pub async fn editor_list_drafts(
    _app: AppHandle,
    limit: i32,
) -> Result<Vec<EditorDraftSummary>, String> {
    let conn = get_db()?;

    let sql = format!(
        "SELECT {} FROM editor_drafts ORDER BY updated_at DESC LIMIT ?1",
        SUMMARY_COLUMNS
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let drafts = stmt
        .query_map(params![limit], |row| {
            Ok(EditorDraftSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                schema_version: row.get(2)?,
                fps: row.get(3)?,
                stage_width: row.get(4)?,
                stage_height: row.get(5)?,
                thumbnail_path: row.get(6)?,
                duration_frames: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|e| format!("Query failed: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(drafts)
}

#[tauri::command]
pub async fn editor_get_draft(
    _app: AppHandle,
    id: String,
) -> Result<Option<EditorDraft>, String> {
    let conn = get_db()?;

    let mut stmt = conn
        .prepare(
            "SELECT id, name, schema_version, fps, stage_width, stage_height,
             project_json, media_json, subtitle_json, thumbnail_path,
             duration_frames, created_at, updated_at
             FROM editor_drafts WHERE id = ?1",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let mut rows = stmt
        .query_map(params![id], |row| {
            Ok(EditorDraft {
                id: row.get(0)?,
                name: row.get(1)?,
                schema_version: row.get(2)?,
                fps: row.get(3)?,
                stage_width: row.get(4)?,
                stage_height: row.get(5)?,
                project_json: row.get(6)?,
                media_json: row.get(7)?,
                subtitle_json: row.get(8)?,
                thumbnail_path: row.get(9)?,
                duration_frames: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        })
        .map_err(|e| format!("Query failed: {}", e))?;

    match rows.next() {
        Some(Ok(draft)) => Ok(Some(draft)),
        Some(Err(e)) => Err(format!("Failed to read draft: {}", e)),
        None => Ok(None),
    }
}

/// Upsert a draft. Pass `id: None` to create one; the new uuid is returned so the
/// caller can keep autosaving to the same row.
///
/// Unlike `editor_save_export`'s best-effort DB write, this reports failures:
/// the autosave hook needs to know a save did not land so it can retry and show
/// a quiet indicator. Deciding not to nag the user is the UI layer's job.
#[tauri::command]
pub async fn editor_save_draft(
    _app: AppHandle,
    id: Option<String>,
    name: String,
    schema_version: i32,
    fps: i32,
    stage_width: i32,
    stage_height: i32,
    project_json: String,
    media_json: String,
    subtitle_json: Option<String>,
    thumbnail_path: Option<String>,
    duration_frames: i64,
) -> Result<String, String> {
    let conn = get_db()?;
    let now = chrono::Utc::now().to_rfc3339();
    let draft_id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // created_at is preserved on conflict; only updated_at moves.
    conn.execute(
        "INSERT INTO editor_drafts (
            id, name, schema_version, fps, stage_width, stage_height,
            project_json, media_json, subtitle_json, thumbnail_path,
            duration_frames, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            schema_version = excluded.schema_version,
            fps = excluded.fps,
            stage_width = excluded.stage_width,
            stage_height = excluded.stage_height,
            project_json = excluded.project_json,
            media_json = excluded.media_json,
            subtitle_json = excluded.subtitle_json,
            thumbnail_path = COALESCE(excluded.thumbnail_path, editor_drafts.thumbnail_path),
            duration_frames = excluded.duration_frames,
            updated_at = excluded.updated_at",
        params![
            draft_id,
            name,
            schema_version,
            fps,
            stage_width,
            stage_height,
            project_json,
            media_json,
            subtitle_json,
            thumbnail_path,
            duration_frames,
            now,
            now
        ],
    )
    .map_err(|e| format!("Failed to save draft: {}", e))?;

    Ok(draft_id)
}

#[tauri::command]
pub async fn editor_rename_draft(
    _app: AppHandle,
    id: String,
    name: String,
) -> Result<(), String> {
    let conn = get_db()?;
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE editor_drafts SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, now, id],
    )
    .map_err(|e| format!("Failed to rename draft: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn editor_delete_draft(_app: AppHandle, id: String) -> Result<(), String> {
    let conn = get_db()?;

    // Read the thumbnail path first so the cached JPEG can be removed with the
    // row. Thumbnails are content-addressed (thumb_{hash}.jpg) and may be shared
    // with another draft using the same source video, so a failed unlink is not
    // an error worth surfacing.
    let thumbnail: Option<String> = conn
        .query_row(
            "SELECT thumbnail_path FROM editor_drafts WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .ok()
        .flatten();

    conn.execute("DELETE FROM editor_drafts WHERE id = ?1", params![id])
        .map_err(|e| format!("Failed to delete draft: {}", e))?;

    if let Some(path) = thumbnail {
        let still_used: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM editor_drafts WHERE thumbnail_path = ?1",
                params![path],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if still_used == 0 {
            let _ = std::fs::remove_file(&path);
        }
    }

    Ok(())
}
