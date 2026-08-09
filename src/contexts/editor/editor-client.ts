import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { appDataDir, join } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import { BaseDirectory, mkdir, readFile, remove, writeFile } from '@tauri-apps/plugin-fs';
import { openFileLocation } from '@/lib/open-file-location';
import type {
  FFmpegCommandResult,
  ProcessingJob,
  ProcessingPreset,
  ProcessingProgress,
  ProcessingTaskType,
  VideoMetadata,
} from '@/lib/types';

export interface ProcessingAttachmentInfoResult {
  path: string;
  filename: string;
  kind: 'image' | 'video' | 'subtitle' | 'other';
  width?: number;
  height?: number;
  size: number;
  format: string;
}

export function onProcessingProgress(
  handler: (event: { payload: ProcessingProgress }) => void,
): Promise<UnlistenFn> {
  return listen<ProcessingProgress>('editor-progress', handler);
}

export async function readBinaryFile(path: string): Promise<Uint8Array> {
  return readFile(path);
}

export async function pickVideoFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [
      {
        name: 'Video',
        extensions: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'flv', 'm4v', 'ts', 'mts'],
      },
    ],
  });
  return typeof selected === 'string' ? selected : null;
}

export async function pickProcessingOutputDirectory(defaultPath?: string): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    defaultPath,
  });
  return typeof selected === 'string' ? selected : null;
}

export async function getVideoMetadata(path: string): Promise<VideoMetadata> {
  return invoke<VideoMetadata>('editor_get_video_metadata', { path });
}

export async function generateVideoPreview(
  inputPath: string,
  videoCodec: string,
  containerFormat: string,
) {
  return invoke<string>('editor_generate_video_preview', { inputPath, videoCodec, containerFormat });
}

export async function generateAudioPreview(inputPath: string) {
  return invoke<string>('editor_generate_audio_preview', { inputPath });
}

export async function generateVideoThumbnail(inputPath: string) {
  return invoke<string>('editor_generate_video_thumbnail', { inputPath });
}

export async function getProcessingAttachmentInfo(
  path: string,
): Promise<ProcessingAttachmentInfoResult> {
  return invoke<ProcessingAttachmentInfoResult>('editor_get_attachment_info', { path });
}

export async function generateProcessingCommand(input: {
  inputPath: string;
  userPrompt: string;
  timelineStart: number | null;
  timelineEnd: number | null;
  metadata: VideoMetadata;
  attachments: Array<{
    path: string;
    filename: string;
    kind: string;
    width: number | null;
    height: number | null;
    size: number;
    format: string;
  }> | null;
  outputDir: string | null;
}): Promise<FFmpegCommandResult> {
  return invoke<FFmpegCommandResult>('editor_generate_command', input);
}

export async function saveProcessingJob(input: {
  id: string;
  inputPath: string;
  outputPath: string;
  taskType: string;
  userPrompt: string | null;
  ffmpegCommand: string;
}): Promise<void> {
  await invoke('editor_save_job', input);
}

export async function executeFfmpegCommand(input: {
  jobId: string;
  commandArgs: string[];
  inputPath: string;
  outputPath: string;
}): Promise<void> {
  await invoke('editor_execute_ffmpeg_command', input);
}

export async function updateProcessingJob(input: {
  id: string;
  status: string;
  progress: number;
  errorMessage: string | null;
}): Promise<void> {
  await invoke('editor_update_job', input);
}

export async function getProcessingHistory(limit = 50): Promise<ProcessingJob[]> {
  return invoke<ProcessingJob[]>('editor_get_history', { limit });
}

export async function generateQuickActionCommand(input: {
  inputPath: string | null;
  taskType: ProcessingTaskType;
  options: Record<string, unknown>;
  timelineStart: number | null;
  timelineEnd: number | null;
  metadata: VideoMetadata;
  outputDir: string | null;
}): Promise<FFmpegCommandResult> {
  return invoke<FFmpegCommandResult>('editor_generate_quick_action_command', input);
}

export async function cancelFfmpeg(jobId: string): Promise<void> {
  await invoke('editor_cancel_ffmpeg', { jobId });
}

export async function revealOutputInFolder(path: string): Promise<void> {
  await openFileLocation(path);
}

// Editor blobs (exports, videos for transcription) are handed to the backend
// as files, not invoke args: plugin-fs writeFile ships a Uint8Array over the
// IPC binary channel, while putting bytes in invoke args JSON-serializes every
// byte as a number — which froze the UI for seconds on large videos. Files go
// under a tmp/ dir inside AppData (covered by the fs:allow-app-write-recursive
// capability); the caller removes them once the backend is done.
const TMP_SUBDIR = 'tmp';

async function writeTempBlob(name: string, bytes: Uint8Array): Promise<string> {
  await mkdir(TMP_SUBDIR, { baseDir: BaseDirectory.AppData, recursive: true });
  const rel = `${TMP_SUBDIR}/${name}`;
  await writeFile(rel, bytes, { baseDir: BaseDirectory.AppData });
  return join(await appDataDir(), rel);
}

async function removeTempBlob(name: string): Promise<void> {
  try {
    await remove(`${TMP_SUBDIR}/${name}`, { baseDir: BaseDirectory.AppData });
  } catch {
    // Best-effort: editor_cleanup_derived sweeps stale tmp files, and a stray
    // temp file must never turn a successful export/transcription into an error.
  }
}

// Persist an Elah-exported MP4 (raw bytes from the WebCodecs export worker) to
// disk and record it in editor_jobs. Returns the written file path.
export async function saveEditorExport(input: {
  bytes: Uint8Array;
  outputPath: string;
  inputName?: string;
}): Promise<string> {
  const tmpName = `export_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`;
  const tempPath = await writeTempBlob(tmpName, input.bytes);
  try {
    // The backend moves (renames) the temp file into place, so on success
    // there is nothing left to remove.
    return await invoke<string>('editor_save_export', {
      tempPath,
      outputPath: input.outputPath,
      inputName: input.inputName ?? null,
    });
  } catch (err) {
    await removeTempBlob(tmpName);
    throw err;
  }
}

// Generate subtitles (SRT with timestamps) from a video already loaded in the
// editor. Elah media assets are blob URLs (no file path), so we stage the
// video as a temp file and the backend extracts audio and runs Whisper on it.
export async function transcribeVideoBytes(input: {
  bytes: Uint8Array;
  filename: string;
  apiKey: string;
  language?: string;
  whisperEndpointUrl?: string;
  whisperModel?: string;
}): Promise<string> {
  const ext = input.filename.split('.').pop()?.toLowerCase() || 'mp4';
  const tmpName = `stt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const videoPath = await writeTempBlob(tmpName, input.bytes);
  try {
    return await invoke<string>('editor_transcribe_video', {
      videoPath,
      apiKey: input.apiKey,
      language: input.language ?? null,
      whisperEndpointUrl: input.whisperEndpointUrl ?? null,
      whisperModel: input.whisperModel ?? 'whisper-1',
    });
  } finally {
    await removeTempBlob(tmpName);
  }
}

export interface TtsResult {
  path: string;
  duration_ms: number;
  speed: number;
}

// Synthesize one subtitle line to a WAV clip (fitted to windowMs when given).
export async function ttsSynthesize(input: {
  provider: string;
  voice: string;
  text: string;
  apiKey: string;
  model?: string;
  windowMs?: number;
  index?: number;
}): Promise<TtsResult> {
  return invoke<TtsResult>('editor_tts_synthesize', {
    provider: input.provider,
    voice: input.voice,
    text: input.text,
    apiKey: input.apiKey,
    model: input.model ?? null,
    windowMs: input.windowMs ?? null,
    index: input.index ?? null,
  });
}

// ── Local TTS (VieNeu — on-device Vietnamese voices with cloning) ──────────

export interface LocalTtsStatus {
  installed: boolean;
  dir?: string | null;
  error?: string | null;
}

export interface LocalTtsVoiceProfile {
  id: string;
  name: string;
  file: string;
  created_at: string;
  /** Shipped with the app — listed under built-in voices, not deletable. */
  builtin?: boolean;
}

export interface LocalTtsPresetVoice {
  /** Bare voice name the engine accepts, e.g. "Minh Đức". */
  id: string;
  /** Display label, e.g. "Minh Đức — Nam · Bắc · Tin tức". */
  label: string;
}

export interface LocalTtsVoices {
  presets: LocalTtsPresetVoice[];
  profiles: LocalTtsVoiceProfile[];
  /** Fine-tuned LoRA voices — highest fidelity, slower engine. */
  loras?: LocalTtsPresetVoice[];
}

export interface LocalTtsSetupProgress {
  stage: string;
  percent: number;
  message: string;
}

export function onLocalTtsSetup(
  handler: (event: { payload: LocalTtsSetupProgress }) => void,
): Promise<UnlistenFn> {
  return listen<LocalTtsSetupProgress>('vieneu-setup', handler);
}

export async function localTtsStatus(): Promise<LocalTtsStatus> {
  return invoke<LocalTtsStatus>('editor_local_tts_status');
}

export async function localTtsInstall(): Promise<LocalTtsStatus> {
  return invoke<LocalTtsStatus>('editor_local_tts_install');
}

export async function localTtsUninstall(): Promise<LocalTtsStatus> {
  return invoke<LocalTtsStatus>('editor_local_tts_uninstall');
}

export async function localTtsVoices(): Promise<LocalTtsVoices> {
  return invoke<LocalTtsVoices>('editor_local_tts_voices');
}

/** Boot the synthesis worker ahead of the first preview/generation. */
export async function localTtsWarm(): Promise<void> {
  await invoke('editor_local_tts_warm');
}

/**
 * Path to a voice's preview sample, synthesizing it only if it isn't cached
 * on disk yet. Repeat previews (including after an app restart) are instant.
 */
export async function localTtsSample(voice: string, text: string): Promise<string> {
  return invoke<string>('editor_local_tts_sample', { voice, text });
}

export interface LocalTtsEngineConfig {
  /** 'int8' = faster (default), 'fp32' = closer voice match, ~15% slower. */
  precision: string;
}

export async function localTtsEngineConfig(): Promise<LocalTtsEngineConfig> {
  return invoke<LocalTtsEngineConfig>('editor_local_tts_engine_config');
}

export async function localTtsSetEngineConfig(
  precision: string,
): Promise<LocalTtsEngineConfig> {
  return invoke<LocalTtsEngineConfig>('editor_local_tts_set_engine_config', { precision });
}

export async function localTtsAddVoice(input: {
  name: string;
  sourcePath: string;
}): Promise<LocalTtsVoiceProfile> {
  return invoke<LocalTtsVoiceProfile>('editor_local_tts_add_voice', {
    name: input.name,
    sourcePath: input.sourcePath,
  });
}

export async function localTtsDeleteVoice(id: string): Promise<void> {
  await invoke('editor_local_tts_delete_voice', { id });
}

// ── generated-audio history (Voices page TTS studio) ───────────────────────

export interface LocalTtsGeneration {
  id: string;
  text: string;
  voice_label: string;
  path: string;
  duration_ms: number;
  created_at: string;
}

export async function localTtsRecordGeneration(input: {
  text: string;
  voiceLabel: string;
  path: string;
  durationMs: number;
}): Promise<LocalTtsGeneration> {
  return invoke<LocalTtsGeneration>('editor_local_tts_record_generation', {
    text: input.text,
    voiceLabel: input.voiceLabel,
    path: input.path,
    durationMs: input.durationMs,
  });
}

export async function localTtsGenerations(): Promise<LocalTtsGeneration[]> {
  return invoke<LocalTtsGeneration[]>('editor_local_tts_generations');
}

export async function localTtsDeleteGeneration(id: string): Promise<void> {
  await invoke('editor_local_tts_delete_generation', { id });
}

export interface LocalTtsVersion {
  /** Version installed in the managed venv. */
  installed?: string | null;
  /** Version this app build pins for fresh installs. */
  pinned: string;
  /** Newest release on PyPI (only set when a remote check ran). */
  latest?: string | null;
  update_available: boolean;
}

export async function localTtsVersion(checkRemote = false): Promise<LocalTtsVersion> {
  return invoke<LocalTtsVersion>('editor_local_tts_version', { checkRemote });
}

export async function localTtsUpdate(version?: string): Promise<LocalTtsVersion> {
  return invoke<LocalTtsVersion>('editor_local_tts_update', { version: version ?? null });
}

export interface LocalTtsStorage {
  installed: boolean;
  models_bytes: number;
  voices_bytes: number;
  runtime_bytes: number;
  total_bytes: number;
}

export async function localTtsStorage(): Promise<LocalTtsStorage> {
  return invoke<LocalTtsStorage>('editor_local_tts_storage');
}

export async function localTtsCleanModels(): Promise<number> {
  return invoke<number>('editor_local_tts_clean_models');
}

// The user's preferred local voice ("preset:<name>" or "profile:<id>") — the
// one the TTS studio and the editor's voiceover panel start with. A UI
// preference, so plain localStorage is enough.
const DEFAULT_LOCAL_VOICE_KEY = 'youwee.localTtsDefaultVoice';

export function getDefaultLocalVoice(): string | null {
  try {
    return localStorage.getItem(DEFAULT_LOCAL_VOICE_KEY);
  } catch {
    return null;
  }
}

export function setDefaultLocalVoice(voiceId: string): void {
  try {
    localStorage.setItem(DEFAULT_LOCAL_VOICE_KEY, voiceId);
  } catch {
    // Storage unavailable — the preference just won't persist.
  }
}

export async function deleteProcessingJob(id: string): Promise<void> {
  await invoke('editor_delete_job', { id });
}

export async function clearProcessingHistory(): Promise<void> {
  await invoke('editor_clear_history');
}

export async function getProcessingPresets(): Promise<ProcessingPreset[]> {
  return invoke<ProcessingPreset[]>('editor_get_presets');
}

export async function saveProcessingPreset(input: {
  name: string;
  description?: string;
  command: string;
  taskType: string;
}): Promise<void> {
  await invoke('editor_save_preset', input);
}

export async function deleteProcessingPreset(id: string): Promise<void> {
  await invoke('editor_delete_preset', { id });
}

export async function executeFfmpegBatch(input: {
  commandArgs: string[];
  inputPath: string;
}): Promise<void> {
  await invoke('editor_execute_ffmpeg_batch', input);
}
