import { useTracksStore, type TimelineEngine } from '@elah/editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  generateDraftThumbnail,
  saveDraft,
  suggestDraftName,
  type SubtitleDubDraft,
} from '@/lib/editor-drafts';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/** Idle time after the last durable edit before a save fires. */
const DEBOUNCE_MS = 2000;
/** Thumbnails shell out to ffmpeg, so refresh them sparingly. */
const THUMBNAIL_INTERVAL_MS = 30_000;

interface Args {
  engine: TimelineEngine | null;
  /** Row id, or null for a project that has never been saved. */
  draftId: string | null;
  onDraftCreated: (id: string) => void;
  name: string | null;
  /** Subtitle panel state to fold into the draft, read fresh on each save. */
  getSubtitle?: () => SubtitleDubDraft | undefined;
  /** False while a draft is loading — see the load-suppression note below. */
  enabled: boolean;
}

interface Result {
  saveState: SaveState;
  lastSavedAt: number | null;
  saveNow: () => Promise<void>;
}

/**
 * Autosave the editing session to a draft row.
 *
 * ## Why this listens to 'history:change' and not 'change'
 *
 * `previewClip` emits `'change'` on every pointer move during a drag
 * (TimelineEngine.ts:326), so subscribing to it would queue a save per
 * mousemove and rely on the debounce to swallow hundreds of them. Every
 * *durable* mutation — commit, batch, undo, redo, commitInteraction — emits
 * `'history:change'` instead, and `commitInteraction` emits only that. So a
 * drag produces exactly one autosave, structurally rather than by luck.
 */
export function useDraftAutosave({
  engine,
  draftId,
  onDraftCreated,
  name,
  getSubtitle,
  enabled,
}: Args): Result {
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftIdRef = useRef(draftId);
  const nameRef = useRef(name);
  // Payload fingerprint of the last successful save — suppresses no-op writes,
  // e.g. an undo/redo round-trip that lands back on identical state.
  const lastHashRef = useRef<string | null>(null);
  const thumbnailAtRef = useRef(0);
  const savingRef = useRef(false);

  draftIdRef.current = draftId;
  nameRef.current = name;

  const doSave = useCallback(async () => {
    if (!engine || savingRef.current) return;
    const project = engine.getProject();

    // A brand-new project with nothing on the timeline gets no row, so the
    // gallery never fills up with empty drafts the user didn't mean to create.
    const clipCount = Object.values(project.clips).reduce((n, list) => n + list.length, 0);
    if (clipCount === 0 && !draftIdRef.current) return;

    const subtitle = getSubtitle?.();
    const payload = JSON.stringify({ project, subtitle });
    if (payload === lastHashRef.current) return;

    savingRef.current = true;
    setSaveState('saving');
    try {
      // Refresh the thumbnail occasionally, and always for the very first save.
      let thumbnailPath: string | null = null;
      const now = Date.now();
      if (!draftIdRef.current || now - thumbnailAtRef.current > THUMBNAIL_INTERVAL_MS) {
        thumbnailPath = await generateDraftThumbnail(project);
        thumbnailAtRef.current = now;
      }

      const id = await saveDraft({
        id: draftIdRef.current,
        name: nameRef.current || suggestDraftName(project),
        project,
        subtitle,
        durationFrames: useTracksStore.getState().totalFrames,
        thumbnailPath,
      });

      if (!draftIdRef.current) {
        draftIdRef.current = id;
        onDraftCreated(id);
      }
      lastHashRef.current = payload;
      setLastSavedAt(Date.now());
      setSaveState('saved');
    } catch (e) {
      // Never surface this as a toast or throw: a failed autosave must not
      // interrupt editing. The toolbar shows a quiet retry affordance instead.
      console.warn('[drafts] autosave failed', e);
      setSaveState('error');
    } finally {
      savingRef.current = false;
    }
  }, [engine, getSubtitle, onDraftCreated]);

  const saveNow = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await doSave();
  }, [doSave]);

  useEffect(() => {
    if (!engine || !enabled) return;

    const schedule = () => {
      setSaveState('dirty');
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void doSave();
      }, DEBOUNCE_MS);
    };

    engine.on('history:change', schedule);
    return () => {
      engine.off('history:change', schedule);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [engine, enabled, doSave]);

  // Flush on unmount so leaving the editor never drops the last edits. Reads
  // through refs because doSave's identity changes with the engine.
  const saveNowRef = useRef(saveNow);
  saveNowRef.current = saveNow;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => {
    return () => {
      if (enabledRef.current) void saveNowRef.current();
    };
  }, []);

  return { saveState, lastSavedAt, saveNow };
}
