import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
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

// Persist an Elah-exported MP4 (raw bytes from the WebCodecs export worker) to
// disk and record it in editor_jobs. Returns the written file path.
export async function saveEditorExport(input: {
  bytes: Uint8Array;
  outputPath: string;
  inputName?: string;
}): Promise<string> {
  return invoke<string>('editor_save_export', {
    bytes: Array.from(input.bytes),
    outputPath: input.outputPath,
    inputName: input.inputName ?? null,
  });
}

// Generate subtitles (SRT with timestamps) from a video already loaded in the
// editor. Elah media assets are blob URLs (no file path), so we send the raw
// video bytes to the backend, which extracts audio and runs Whisper.
export async function transcribeVideoBytes(input: {
  bytes: Uint8Array;
  filename: string;
  apiKey: string;
  language?: string;
  whisperEndpointUrl?: string;
  whisperModel?: string;
}): Promise<string> {
  return invoke<string>('editor_transcribe_bytes', {
    bytes: Array.from(input.bytes),
    filename: input.filename,
    apiKey: input.apiKey,
    language: input.language ?? null,
    whisperEndpointUrl: input.whisperEndpointUrl ?? null,
    whisperModel: input.whisperModel ?? 'whisper-1',
  });
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
