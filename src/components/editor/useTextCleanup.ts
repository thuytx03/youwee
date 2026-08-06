import {
  useMediaLibraryStore,
  useTracksStore,
  type Clip,
  type TimelineEngine,
} from '@elah/editor';
import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/components/ui/toast';
import { onProcessingProgress } from '@/contexts/editor/editor-client';
import { toAssetUrl } from '@/lib/asset-access';
import {
  getAssetPath,
  regenerateDerivedMedia,
  rememberAssetPath,
} from '@/lib/editor-drafts';
import { cleanupBlockedReason, stageRegionToSource } from './textRegionGeometry';
import { useTextRegionStore } from './textRegionStore';

export interface CleanupState {
  running: boolean;
  percent: number;
  run: () => Promise<void>;
  cancel: () => void;
  /**
   * Why the tool can't be used on this clip, if anything. Values double as i18n
   * key suffixes (`editor.cleanup.blocked_<reason>`), so they use underscores.
   */
  blocked: 'rotated' | 'no_path' | 'no_size' | null;
}

/**
 * Drive the burned-in-text removal for one clip.
 *
 * The interesting part is the swap at the end: the renderer caches a decoder per
 * clip **id**, not per src (VideoLayer keys `_providers` by `item.id` and only
 * disposes on prewarm eviction), so mutating `clip.src` in place would keep
 * playing the old file for the rest of the session. Replacing the clip with a new
 * one — new id, same placement — gives the render graph a cache miss and it
 * decodes the cleaned file.
 */
export function useTextCleanup(clip: Clip, engine: TimelineEngine | null): CleanupState {
  const { t } = useTranslation('pages');
  const toast = useToast();
  const stage = useTracksStore((s) => s.stage);
  const regions = useTextRegionStore((s) => s.regions);
  const mode = useTextRegionStore((s) => s.mode);
  const reset = useTextRegionStore((s) => s.reset);

  const [running, setRunning] = useState(false);
  const [percent, setPercent] = useState(0);
  const jobIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  const asset = clip.assetId
    ? useMediaLibraryStore.getState().getAsset(clip.assetId)
    : undefined;
  const sourcePath = getAssetPath(clip.assetId);

  const blocked: CleanupState['blocked'] = cleanupBlockedReason(clip)
    ? 'rotated'
    : !asset?.width || !asset?.height
      ? 'no_size'
      : !sourcePath
        ? 'no_path'
        : null;

  const cancel = useCallback(() => {
    const id = jobIdRef.current;
    if (id) void invoke('editor_cancel_ffmpeg', { jobId: id }).catch(() => {});
  }, []);

  const run = useCallback(async () => {
    if (!engine || running) return;
    if (blocked) {
      toast.error({ title: t(`editor.cleanup.blocked_${blocked}`) });
      return;
    }
    if (regions.length === 0) {
      toast.info({ title: t('editor.cleanup.noRegions') });
      return;
    }

    const content = { width: asset!.width!, height: asset!.height! };
    const mapped = regions.map((r) => ({ r, out: stageRegionToSource(r, clip, stage, content) }));
    const sourceRegions = mapped
      .map((m) => m.out)
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (sourceRegions.length === 0) {
      // Every box landed outside the picture (on the letterbox bars). Log the
      // inputs: a silent geometry mismatch here is very hard to diagnose from
      // the message alone.
      console.warn('[cleanup] no usable regions', {
        stage,
        content,
        transform: clip.transform,
        regions: mapped,
      });
      toast.error({ title: t('editor.cleanup.regionsOutside') });
      return;
    }

    const jobId = `cleanup-${Date.now()}`;
    jobIdRef.current = jobId;
    setRunning(true);
    setPercent(0);

    unlistenRef.current = await onProcessingProgress(({ payload }) => {
      if (payload.job_id === jobId) setPercent(Math.round(payload.percent));
    });

    try {
      const cleanedPath = await invoke<string>('editor_remove_text_region', {
        jobId,
        inputPath: sourcePath!,
        regions: sourceRegions,
        mode,
      });

      const src = await toAssetUrl(cleanedPath);
      const assetId = clip.assetId!;

      // Repoint the EXISTING asset instead of registering a second one. The
      // cleaned file is an internal artifact, not media the user imported, so a
      // new library entry would just be clutter — and one per run at that.
      // updateAsset keeps the id, so clip.assetId stays valid everywhere.
      useMediaLibraryStore.getState().updateAsset(assetId, {
        src,
        // Dropped so they regenerate from the cleaned file below; stale ones
        // would keep showing the original's frames in the timeline filmstrip.
        thumbnailUrl: undefined,
        thumbnailStrip: undefined,
      });
      // derived=true: if this file is ever missing on reopen, "locate the file"
      // is the wrong prompt — the user never had it, it must be regenerated.
      rememberAssetPath(assetId, cleanedPath, true);

      // Replace the clip rather than mutating its src: VideoLayer caches a
      // decoder per clip id and never re-reads src, so an in-place update would
      // keep playing the original for the rest of the session.
      engine.batch(() => {
        engine.removeClip(clip.id, clip.trackId);
        engine.addClip({
          type: 'video',
          trackId: clip.trackId,
          startFrame: clip.startFrame,
          durationFrames: clip.durationFrames,
          src,
          assetId,
          name: clip.name,
          ...(clip.transform ? { transform: clip.transform } : {}),
          ...(clip.volume !== undefined ? { volume: clip.volume } : {}),
          ...(clip.opacity !== undefined ? { opacity: clip.opacity } : {}),
        });
      }, 'Remove burned-in text');

      const updated = useMediaLibraryStore.getState().assets[assetId];
      if (updated) void regenerateDerivedMedia([updated]);

      reset();
      toast.success({ title: t('editor.cleanup.done') });
    } catch (e) {
      const msg = String(e);
      if (msg.includes('cancelled')) {
        toast.info({ title: t('editor.cleanup.cancelled') });
      } else {
        toast.error({ title: t('editor.cleanup.failed'), message: msg });
      }
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
      jobIdRef.current = null;
      setRunning(false);
      setPercent(0);
    }
  }, [engine, running, blocked, regions, mode, asset, sourcePath, clip, stage, reset, toast, t]);

  return { running, percent, run, cancel, blocked };
}
