/**
 * Draft persistence for the video editor — saving an editing session and
 * reopening it later, CapCut-style.
 *
 * ## Why this is more than JSON.stringify(project)
 *
 * A `Project` is plain JSON-safe state, so the timeline itself round-trips
 * trivially. The media does not. Assets imported through the browser file input
 * get a `blob:` src (`URL.createObjectURL`), which dies with the page — reopen a
 * draft and every clip points at a dead URL. So a draft stores each asset's
 * absolute filesystem path and, on open, re-registers the asset against a fresh
 * `asset://` URL and rewrites the clips' `src` to match.
 *
 * Two facts make that rewrite the right approach rather than a hack:
 *  - The renderer resolves media from `clip.src` only; `assetId` is read purely
 *    by UI chrome (filmstrips, the transform overlay), both of which null-guard.
 *  - `insertAsset` writes BOTH fields on every clip, so `src` is always present.
 *
 * Asset ids are preserved across a reopen anyway, so filmstrips keep working.
 */
import {
  computeWaveform,
  importUrl,
  makeImageThumbnail,
  makeVideoThumbnailStrip,
  useMediaLibraryStore,
  type Clip,
  type MediaAsset,
  type MediaKind,
  type Project,
} from '@elah/editor';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { syncAssetScopePaths, toAssetUrl } from '@/lib/asset-access';

export const DRAFT_SCHEMA_VERSION = 1;

/** Frames sampled for a clip's timeline filmstrip. Matches Elah's import default. */
const THUMBNAIL_STRIP_COUNT = 6;
const THUMBNAIL_MAX_DIM = 320;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What we persist per media asset. `thumbnailUrl`, `thumbnailStrip` and
 * `waveform` are deliberately absent: the first two are megabytes of base64 and
 * the third is a Float32Array (not JSON-safe). All three are regenerated from
 * `src` on open.
 */
export interface DraftMediaEntry {
  /** The original MediaAsset.id, restored verbatim so clip.assetId stays valid. */
  id: string;
  kind: MediaKind;
  name: string;
  /** Absolute path. Null for assets imported before paths were tracked. */
  path: string | null;
  /** The src at save time — the key for rewriting clip.src on reopen. */
  savedSrc: string;
  durationSec: number;
  width?: number;
  height?: number;
  sourceFps?: number;
  hasAudio?: boolean;
  byteSize: number;
  lastModified: number;
  addedAt: number;
}

/** Subtitle panel state worth keeping — transcription is slow and costs API credits. */
export interface SubtitleDubDraft {
  entries: unknown[];
  translatedEntries: unknown[] | null;
  targetCode?: string;
  styleX?: number;
  styleY?: number;
  styleScale?: number;
  styleMoved?: boolean;
}

export interface DraftEnvelope {
  schemaVersion: number;
  project: Project;
  media: DraftMediaEntry[];
  /** Media library insertion order, so the asset panel looks the same. */
  order: string[];
  subtitle?: SubtitleDubDraft;
}

/** Row shape returned by the Rust `editor_list_drafts` command (snake_case). */
export interface EditorDraftSummary {
  id: string;
  name: string;
  schema_version: number;
  fps: number;
  stage_width: number;
  stage_height: number;
  thumbnail_path: string | null;
  duration_frames: number;
  created_at: string;
  updated_at: string;
}

export interface EditorDraft extends EditorDraftSummary {
  project_json: string;
  media_json: string;
  subtitle_json: string | null;
}

export type MissingReason = 'no-path' | 'not-found';

export interface MissingMedia {
  entry: DraftMediaEntry;
  reason: MissingReason;
}

export interface RelinkResult {
  restored: number;
  missing: MissingMedia[];
  /** oldSrc -> newSrc. Feed to remapProjectSrcs before loadProject. */
  srcRemap: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Asset path sidecar
// ---------------------------------------------------------------------------

/**
 * assetId -> absolute path, for assets whose path we know.
 *
 * MediaAsset has no path field and the vendored library is not ours to extend,
 * so paths live here. Memory-only by design — mirroring `allowedAssetPaths` in
 * asset-access.ts — and rebuilt from the draft on open via `primeAssetPaths`.
 */
const assetPaths = new Map<string, string>();

export function rememberAssetPath(assetId: string, path: string): void {
  assetPaths.set(assetId, path);
}

export function getAssetPath(assetId: string | undefined): string | undefined {
  return assetId ? assetPaths.get(assetId) : undefined;
}

export function primeAssetPaths(entries: DraftMediaEntry[]): void {
  for (const e of entries) {
    if (e.path) assetPaths.set(e.id, e.path);
  }
}

// ---------------------------------------------------------------------------
// Import (dialog-based, so the path is knowable)
// ---------------------------------------------------------------------------

const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'];

function extensionOf(path: string): string {
  return path.split(/[/\\]/).pop()?.split('.').pop()?.toLowerCase() ?? '';
}

function basenameOf(path: string): string {
  return path.split(/[/\\]/).pop() ?? 'media';
}

function kindFromPath(path: string): MediaKind | null {
  const ext = extensionOf(path);
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (IMAGE_EXT.includes(ext)) return 'image';
  return null;
}

/**
 * Import media through the Tauri dialog so the absolute path is captured.
 *
 * The file input inside the vendored SourcePanel can't do this — a `File` in a
 * Tauri webview carries no usable path — which is why this exists alongside it.
 * Assets imported the other way still work; they just can't survive a reopen.
 */
export async function importMediaFromDialog(): Promise<MediaAsset[]> {
  const picked = await open({
    multiple: true,
    filters: [
      { name: 'Media', extensions: [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT] },
      { name: 'Video', extensions: VIDEO_EXT },
      { name: 'Audio', extensions: AUDIO_EXT },
      { name: 'Image', extensions: IMAGE_EXT },
    ],
  });
  const paths = (Array.isArray(picked) ? picked : picked ? [picked] : []).filter(
    (p): p is string => typeof p === 'string',
  );
  if (paths.length === 0) return [];

  // One batch grant for every parent directory, before any URL is built.
  await syncAssetScopePaths(paths).catch((e) => console.warn('[drafts] scope sync failed', e));

  const imported: MediaAsset[] = [];
  for (const path of paths) {
    const kind = kindFromPath(path);
    if (!kind) continue;
    try {
      const url = await toAssetUrl(path);
      // Passing kind explicitly skips importUrl's extension sniff and HEAD probe.
      const asset = await importUrl(url, { kind, name: basenameOf(path) });
      rememberAssetPath(asset.id, path);
      imported.push(asset);
    } catch (e) {
      console.warn(`[drafts] failed to import ${path}`, e);
    }
  }
  return imported;
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/** Snapshot the media library as draft entries, dropping regenerable fields. */
export function buildMediaManifest(): { media: DraftMediaEntry[]; order: string[] } {
  const { assets, order } = useMediaLibraryStore.getState();
  const media: DraftMediaEntry[] = [];
  for (const id of order) {
    const a = assets[id];
    if (!a) continue;
    media.push({
      id: a.id,
      kind: a.kind,
      name: a.name,
      path: assetPaths.get(a.id) ?? null,
      savedSrc: a.src,
      durationSec: a.durationSec,
      width: a.width,
      height: a.height,
      sourceFps: a.sourceFps,
      hasAudio: a.hasAudio,
      byteSize: a.byteSize,
      lastModified: a.lastModified,
      addedAt: a.addedAt,
    });
  }
  return { media, order };
}

/** Name a new draft after its first video, falling back to a generic label. */
export function suggestDraftName(project: Project): string {
  const { assets } = useMediaLibraryStore.getState();
  for (const track of project.tracks) {
    if (track.kind !== 'video') continue;
    for (const clip of project.clips[track.id] ?? []) {
      const asset = clip.assetId ? assets[clip.assetId] : undefined;
      if (asset?.name) return asset.name.replace(/\.[^.]+$/, '');
    }
  }
  return 'Untitled project';
}

/** Absolute path of the first video on the timeline — the thumbnail source. */
export function firstVideoPath(project: Project): string | undefined {
  for (const track of project.tracks) {
    if (track.kind !== 'video') continue;
    for (const clip of project.clips[track.id] ?? []) {
      if (clip.type !== 'video') continue;
      const path = getAssetPath(clip.assetId);
      if (path) return path;
    }
  }
  return undefined;
}

export async function generateDraftThumbnail(project: Project): Promise<string | null> {
  const path = firstVideoPath(project);
  if (!path) return null;
  try {
    // Existing ffmpeg command: content-addressed, cached, writes under $APPDATA.
    return await invoke<string>('editor_generate_video_thumbnail', { inputPath: path });
  } catch (e) {
    console.warn('[drafts] thumbnail generation failed', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

export function parseDraft(draft: EditorDraft): DraftEnvelope {
  const project = JSON.parse(draft.project_json) as Project;
  const media = JSON.parse(draft.media_json) as DraftMediaEntry[];
  const subtitle = draft.subtitle_json
    ? (JSON.parse(draft.subtitle_json) as SubtitleDubDraft)
    : undefined;
  return {
    schemaVersion: draft.schema_version,
    project,
    media,
    order: media.map((m) => m.id),
    subtitle,
  };
}

/**
 * Re-register a draft's media against this session, preserving asset ids.
 *
 * Deliberately does NOT use importUrl: that mints a fresh id (orphaning every
 * clip's assetId) and re-probes metadata we already saved. Writing the asset
 * straight into the store is both faster and id-stable.
 */
export async function relinkDraftMedia(env: DraftEnvelope): Promise<RelinkResult> {
  primeAssetPaths(env.media);

  const paths = env.media.map((m) => m.path).filter((p): p is string => !!p);
  if (paths.length > 0) {
    // Rust scope state is per-process, so this must run every session.
    await syncAssetScopePaths(paths).catch((e) =>
      console.warn('[drafts] scope sync failed', e),
    );
  }

  const existence = await Promise.all(
    env.media.map(async (entry) => {
      if (!entry.path) return { entry, exists: false, reason: 'no-path' as MissingReason };
      try {
        const exists = await invoke<boolean>('check_file_exists', { filepath: entry.path });
        return { entry, exists, reason: 'not-found' as MissingReason };
      } catch {
        return { entry, exists: false, reason: 'not-found' as MissingReason };
      }
    }),
  );

  const srcRemap = new Map<string, string>();
  const missing: MissingMedia[] = [];
  const restoredAssets: MediaAsset[] = [];
  const { addAsset } = useMediaLibraryStore.getState();

  for (const { entry, exists, reason } of existence) {
    if (!exists || !entry.path) {
      missing.push({ entry, reason });
      continue;
    }
    try {
      const src = await toAssetUrl(entry.path);
      const asset: MediaAsset = {
        id: entry.id,
        kind: entry.kind,
        name: entry.name,
        src,
        durationSec: entry.durationSec,
        width: entry.width,
        height: entry.height,
        sourceFps: entry.sourceFps,
        hasAudio: entry.hasAudio,
        byteSize: entry.byteSize,
        lastModified: entry.lastModified,
        addedAt: entry.addedAt,
      };
      addAsset(asset);
      restoredAssets.push(asset);
      if (entry.savedSrc && entry.savedSrc !== src) srcRemap.set(entry.savedSrc, src);
    } catch (e) {
      console.warn(`[drafts] failed to relink ${entry.path}`, e);
      missing.push({ entry, reason: 'not-found' });
    }
  }

  // Fire-and-forget so the timeline paints immediately and filmstrips fill in.
  void regenerateDerivedMedia(restoredAssets);

  return { restored: restoredAssets.length, missing, srcRemap };
}

/** Rebuild the thumbnails and waveforms that were intentionally not persisted. */
async function regenerateDerivedMedia(assets: MediaAsset[]): Promise<void> {
  const { updateAsset } = useMediaLibraryStore.getState();
  for (const asset of assets) {
    if (asset.kind === 'video') {
      makeVideoThumbnailStrip(asset.src, THUMBNAIL_STRIP_COUNT, THUMBNAIL_MAX_DIM)
        .then((strip) => {
          if (strip.length === 0) return;
          updateAsset(asset.id, {
            thumbnailStrip: strip,
            thumbnailUrl: strip[Math.floor(strip.length / 2)],
          });
        })
        .catch((e) => console.warn('[drafts] thumbnail strip failed', e));
    } else if (asset.kind === 'image') {
      makeImageThumbnail(asset.src, THUMBNAIL_MAX_DIM)
        .then((thumbnailUrl) => updateAsset(asset.id, { thumbnailUrl }))
        .catch((e) => console.warn('[drafts] image thumbnail failed', e));
    }

    if (asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio)) {
      computeWaveform(asset.src)
        .then((waveform) => {
          if (waveform) updateAsset(asset.id, { waveform });
        })
        .catch((e) => console.warn('[drafts] waveform failed', e));
    }
  }
}

/**
 * Return a copy of `project` with every `clip.src` remapped.
 *
 * Runs on the plain object before `loadProject` so the engine's Immer history
 * never sees the intermediate state. Clips with no `src`, or an `src` that isn't
 * in the map (missing media, text/shape clips), pass through untouched.
 */
export function remapProjectSrcs(
  project: Project,
  srcRemap: Map<string, string>,
): Project {
  if (srcRemap.size === 0) return project;

  const clips: Record<string, Clip[]> = {};
  for (const [trackId, trackClips] of Object.entries(project.clips)) {
    clips[trackId] = trackClips.map((clip) => {
      const next = clip.src ? srcRemap.get(clip.src) : undefined;
      return next ? { ...clip, src: next } : clip;
    });
  }
  return { ...project, clips };
}

/**
 * Point a single asset at a new file, for the "locate missing media" flow.
 * Returns the new src so the caller can rewrite the affected clips through the
 * engine (keeping the fix undoable and triggering an autosave).
 */
export async function relocateAsset(
  entry: DraftMediaEntry,
): Promise<{ src: string; path: string } | null> {
  const extensions =
    entry.kind === 'video' ? VIDEO_EXT : entry.kind === 'audio' ? AUDIO_EXT : IMAGE_EXT;
  const picked = await open({
    multiple: false,
    filters: [{ name: entry.kind, extensions }],
  });
  if (typeof picked !== 'string') return null;

  await syncAssetScopePaths([picked]).catch(() => {});
  const src = await toAssetUrl(picked);
  useMediaLibraryStore.getState().addAsset({
    id: entry.id,
    kind: entry.kind,
    name: basenameOf(picked),
    src,
    durationSec: entry.durationSec,
    width: entry.width,
    height: entry.height,
    sourceFps: entry.sourceFps,
    hasAudio: entry.hasAudio,
    byteSize: entry.byteSize,
    lastModified: entry.lastModified,
    addedAt: entry.addedAt,
  });
  rememberAssetPath(entry.id, picked);
  void regenerateDerivedMedia([useMediaLibraryStore.getState().assets[entry.id]]);
  return { src, path: picked };
}

// ---------------------------------------------------------------------------
// Tauri command wrappers
// ---------------------------------------------------------------------------

export function listDrafts(limit = 100): Promise<EditorDraftSummary[]> {
  return invoke<EditorDraftSummary[]>('editor_list_drafts', { limit });
}

export function getDraft(id: string): Promise<EditorDraft | null> {
  return invoke<EditorDraft | null>('editor_get_draft', { id });
}

export function renameDraft(id: string, name: string): Promise<void> {
  return invoke<void>('editor_rename_draft', { id, name });
}

export function deleteDraft(id: string): Promise<void> {
  return invoke<void>('editor_delete_draft', { id });
}

export interface SaveDraftArgs {
  id: string | null;
  name: string;
  project: Project;
  subtitle?: SubtitleDubDraft;
  durationFrames: number;
  thumbnailPath?: string | null;
}

/** Returns the draft id (freshly minted when `id` was null). */
export function saveDraft(args: SaveDraftArgs): Promise<string> {
  const { media, order } = buildMediaManifest();
  const envelope: Omit<DraftEnvelope, 'project' | 'subtitle'> = {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    media,
    order,
  };
  return invoke<string>('editor_save_draft', {
    id: args.id,
    name: args.name,
    schemaVersion: DRAFT_SCHEMA_VERSION,
    fps: args.project.fps,
    stageWidth: args.project.stage.width,
    stageHeight: args.project.stage.height,
    projectJson: JSON.stringify(args.project),
    mediaJson: JSON.stringify(envelope.media),
    subtitleJson: args.subtitle ? JSON.stringify(args.subtitle) : null,
    thumbnailPath: args.thumbnailPath ?? null,
    durationFrames: args.durationFrames,
  });
}
