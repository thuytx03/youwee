import { describe, expect, test } from 'bun:test';
import {
  buildItemUniversalSettingsSnapshot,
  createDefaultUniversalSettings,
  resolveUniversalVideoCodec,
  serializeUniversalSettings,
} from '../src/lib/universal-settings';

describe('universal codec settings', () => {
  test('defaults video codec to auto for old settings', () => {
    const settings = createDefaultUniversalSettings({});

    expect(settings.videoCodec).toBe('auto');
  });

  test('normalizes unsupported video codec to auto', () => {
    const settings = createDefaultUniversalSettings({
      videoCodec: 'hevc',
    } as unknown as Parameters<typeof createDefaultUniversalSettings>[0]);

    expect(settings.videoCodec).toBe('auto');
  });

  test('normalizes WebM with H.264 to auto', () => {
    const settings = createDefaultUniversalSettings({
      format: 'webm',
      videoCodec: 'h264',
    });

    expect(settings.videoCodec).toBe('auto');
  });

  test('persists selected video codec', () => {
    const saved = serializeUniversalSettings(
      createDefaultUniversalSettings({
        videoCodec: 'vp9',
      }),
    );

    expect(saved.videoCodec).toBe('vp9');
  });

  test('snapshots selected video codec into queued items', () => {
    const settings = createDefaultUniversalSettings({
      videoCodec: 'av1',
    });

    const snapshot = buildItemUniversalSettingsSnapshot(settings, {
      useAria2: false,
      aria2Args: '',
      ytdlpAdvancedOptionsEnabled: false,
      ytdlpAdvancedOptions: [],
      numberQueueItems: true,
      filenameMetadataEnabled: true,
      filenameMetadataFields: ['uploadDate', 'viewCount'],
      splitEmbeddedChapters: false,
      numberChapterFiles: true,
      autoOrganizeCollections: false,
      pluginWorkflowSnapshots: {},
      postDownloadWorkflowSteps: [],
    });

    expect(snapshot.videoCodec).toBe('av1');
    expect(snapshot.numberQueueItems).toBe(true);
    expect(snapshot.filenameMetadataEnabled).toBe(true);
    expect(snapshot.filenameMetadataFields).toEqual(['uploadDate', 'viewCount']);
  });

  test('resolves old queued items without video codec to auto', () => {
    const settings = createDefaultUniversalSettings({
      videoCodec: 'vp9',
    });

    expect(resolveUniversalVideoCodec(undefined, settings)).toBe('auto');
    expect(resolveUniversalVideoCodec({}, settings)).toBe('auto');
    expect(resolveUniversalVideoCodec({ videoCodec: 'h264' }, settings)).toBe('h264');
  });
});
