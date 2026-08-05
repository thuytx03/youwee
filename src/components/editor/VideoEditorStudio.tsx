// Full Elah-based video editor, laid out like the Elah "production" playground
// (SourcePanel · Preview+Transport · ClipProperties / Timeline).
// Adapted for a desktop Tauri app: local media only (no Pixabay/Agentic stock),
// export saves to disk + records editor_jobs via EditorToolbar.
import '@elah/editor/styles/tokens.css';
import '@elah/editor/styles.css';
import './elah-theme-bridge.css';
import {
  EditorProvider,
  type InitialTrackConfig,
  Preview,
  SourcePanel,
  Timeline,
  type TimelineRef,
  createDefaultDemuxerFactory,
  framesToTimecode,
  useTimelineEngine,
  useTracksStore,
  usePlaybackStore,
} from '@elah/editor';
import { AlertTriangle, ChevronLeft, FolderOpen, Loader2, Pause, Play, Save, Square } from 'lucide-react';
import { Captions, Clapperboard } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/components/ui/toast';
import {
  importMediaFromDialog,
  parseDraft,
  relinkDraftMedia,
  relocateAsset,
  remapProjectSrcs,
  type EditorDraft,
  type MissingMedia,
  type SubtitleDubDraft,
} from '@/lib/editor-drafts';
import { cn } from '@/lib/utils';
import { useDraftAutosave, type SaveState } from './useDraftAutosave';
import { EditorToolbar } from './EditorToolbar';
import { ClipProperties } from './properties/ClipProperties';
import { SubtitleDubPanel } from './SubtitleDubPanel';
import { TimelineControls } from './TimelineControls';
import { useElahDialogI18n } from './useElahDialogI18n';

const FPS = 30;
const demuxerFactory = createDefaultDemuxerFactory();

// One video track (the model allows a single video lane), a few element (text)
// lanes for overlays, and two audio lanes — mirrors the playground seed.
const INITIAL_TRACKS: InitialTrackConfig[] = [
  { kind: 'video', name: 'Video' },
  { kind: 'elements', name: 'Elements' },
  { kind: 'elements', name: 'Elements 2' },
  { kind: 'audio', name: 'Audio' },
  { kind: 'audio', name: 'Audio 2' },
];

// ── Aspect-ratio control (16:9 / 9:16 / 1:1) — floats above the preview.
const ASPECTS = [
  { label: '16:9', w: 1920, h: 1080, gw: 14, gh: 8 },
  { label: '9:16', w: 1080, h: 1920, gw: 8, gh: 14 },
  { label: '1:1', w: 1080, h: 1080, gw: 11, gh: 11 },
] as const;

const AspectControl = memo(function AspectControl() {
  const engine = useTimelineEngine();
  const stage = useTracksStore((s) => s.stage);
  const isActive = (w: number, h: number) => Math.abs(stage.width / stage.height - w / h) < 0.001;

  return (
    <div className="flex items-center justify-center py-2 shrink-0">
      <div className="flex items-center gap-1">
        {ASPECTS.map((a) => {
          const active = isActive(a.w, a.h);
          return (
            <button
              key={a.label}
              type="button"
              onClick={() => engine.setStage(a.w, a.h)}
              title={`Tỉ lệ ${a.label}`}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs cursor-pointer transition-colors',
                active ? 'bg-ed-elevated text-ed-text' : 'text-ed-text-muted hover:text-ed-text',
              )}
              style={active ? { boxShadow: 'inset 0 0 0 1px var(--elah-accent)' } : undefined}
            >
              <span style={{ width: a.gw, height: a.gh, borderRadius: 2, background: 'currentColor' }} />
              {a.label}
            </button>
          );
        })}
      </div>
    </div>
  );
});

// ── Transport bar (play/pause/stop + timecode) under the preview.
// fps arrives as a prop rather than the module default because a draft can be
// opened at a different frame rate, and timecode must match the engine's.
const TransportBar = memo(function TransportBar({ fps }: { fps: number }) {
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const togglePlayPause = usePlaybackStore((s) => s.togglePlayPause);
  const totalFrames = useTracksStore((s) => s.totalFrames);
  const currentTimeRef = useRef<HTMLSpanElement>(null);
  const totalTimeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    return usePlaybackStore.subscribe((state) => {
      if (currentTimeRef.current) currentTimeRef.current.textContent = framesToTimecode(state.currentFrame, fps);
    });
  }, [fps]);
  useEffect(() => {
    if (totalTimeRef.current) totalTimeRef.current.textContent = framesToTimecode(Math.max(totalFrames, 1), fps);
  }, [totalFrames, fps]);

  const handleStop = () => {
    usePlaybackStore.getState().pause();
  };
  const ghostIcon =
    'inline-flex items-center justify-center w-7 h-7 rounded text-ed-text-muted hover:text-ed-text hover:bg-ed-elevated transition-colors cursor-pointer';

  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center h-11 px-4 bg-ed-bg-2 border-t border-ed-border shrink-0">
      <span className="font-mono text-[11px] tabular-nums whitespace-nowrap">
        <span ref={currentTimeRef} style={{ color: 'var(--elah-accent)' }}>00:00:00:00</span>
        <span className="text-ed-text-muted mx-1.5">|</span>
        <span ref={totalTimeRef} className="text-ed-text-muted">00:00:00:00</span>
      </span>
      <div className="flex items-center gap-3">
        <button type="button" onClick={togglePlayPause} title="Phát / Dừng (Space)"
          className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-white text-black hover:opacity-90 cursor-pointer shrink-0">
          {isPlaying ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="ml-0.5" />}
        </button>
        <button type="button" onClick={handleStop} title="Dừng lại" className={ghostIcon}>
          <Square size={13} fill="currentColor" />
        </button>
      </div>
      <div />
    </div>
  );
});

// ── Draft bar: project name, save indicator, back-to-gallery.
function DraftBar({
  name,
  saveState,
  onRename,
  onSaveNow,
  onExit,
}: {
  name: string | null;
  saveState: SaveState;
  onRename: (name: string) => void;
  onSaveNow: () => void;
  onExit?: () => void;
}) {
  const { t } = useTranslation('pages');
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');

  const label: Record<SaveState, string> = {
    idle: '',
    dirty: t('editor.drafts.unsaved'),
    saving: t('editor.drafts.saving'),
    saved: t('editor.drafts.saved'),
    error: t('editor.drafts.saveFailed'),
  };

  return (
    <div className="flex items-center gap-2 h-9 px-3 bg-ed-bg-2 border-b border-ed-border shrink-0">
      {onExit && (
        <button
          type="button"
          onClick={onExit}
          title={t('editor.drafts.backToProjects')}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-ed-text-muted hover:text-ed-text hover:bg-ed-elevated transition-colors cursor-pointer"
        >
          <ChevronLeft size={14} /> {t('editor.drafts.backToProjects')}
        </button>
      )}
      <div className="w-px h-4 bg-ed-border" />
      {editing ? (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            setEditing(false);
            const next = value.trim();
            // Only a real change commits: renaming to the same string would
            // otherwise mark the draft dirty for nothing.
            if (next && next !== name) onRename(next);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              // Restore the committed name first, so the blur that follows
              // cannot commit the abandoned draft value.
              setValue(name ?? '');
              setEditing(false);
            }
          }}
          className="px-1.5 py-0.5 text-xs rounded border border-ed-accent bg-ed-bg text-ed-text outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setValue(name ?? '');
            setEditing(true);
          }}
          className="text-xs text-ed-text hover:underline cursor-pointer"
        >
          {name || t('editor.drafts.untitled')}
        </button>
      )}
      <span
        className={cn(
          'text-[11px]',
          saveState === 'error' ? 'text-[var(--elah-color-error)]' : 'text-ed-text-muted',
        )}
      >
        {label[saveState]}
      </span>
      <div className="flex-1" />
      <button
        type="button"
        onClick={onSaveNow}
        title={t('editor.drafts.saveNow')}
        className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-ed-text-muted hover:text-ed-text hover:bg-ed-elevated transition-colors cursor-pointer"
      >
        {saveState === 'saving' ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Save size={13} />
        )}
        {t('editor.drafts.save')}
      </button>
    </div>
  );
}

// ── Banner for media whose file could not be found on open.
function MissingMediaBanner({
  missing,
  engine,
  onResolved,
}: {
  missing: MissingMedia[];
  engine: TimelineRef['engine'] | null;
  onResolved: (assetId: string) => void;
}) {
  const { t } = useTranslation('pages');

  const locate = async (item: MissingMedia) => {
    if (!engine) return;
    const result = await relocateAsset(item.entry);
    if (!result) return;
    // Repoint the clips through the engine so the fix is undoable and trips the
    // autosave, meaning the relink survives the next reopen too.
    const project = engine.getProject();
    engine.batch(() => {
      for (const track of project.tracks) {
        for (const clip of project.clips[track.id] ?? []) {
          if (clip.assetId === item.entry.id || clip.src === item.entry.savedSrc) {
            engine.updateClip(clip.id, track.id, { src: result.src });
          }
        }
      }
    }, 'Relink media');
    onResolved(item.entry.id);
  };

  return (
    <div className="shrink-0 px-3 py-2 bg-[color-mix(in_srgb,var(--elah-color-error)_12%,transparent)] border-b border-ed-border">
      <div className="flex items-center gap-2 text-xs text-ed-text">
        <AlertTriangle size={14} className="text-[var(--elah-color-error)] shrink-0" />
        {t('editor.drafts.missingMedia', { count: missing.length })}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {missing.map((item) => (
          <button
            key={item.entry.id}
            type="button"
            onClick={() => void locate(item)}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-ed-border text-ed-text-muted hover:text-ed-text hover:bg-ed-elevated transition-colors cursor-pointer"
            title={item.entry.path ?? item.entry.name}
          >
            <FolderOpen size={12} /> {item.entry.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface VideoEditorStudioProps {
  /**
   * Draft to restore, or null for a new project. Read once on mount — the parent
   * remounts this component (via `key`) when switching sessions, because
   * EditorProvider builds its engine with empty deps and can't adopt a new fps.
   */
  draft?: EditorDraft | null;
  /** Return to the project gallery. */
  onExit?: () => void;
}

export function VideoEditorStudio({ draft = null, onExit }: VideoEditorStudioProps = {}) {
  const { t } = useTranslation('pages');
  const toast = useToast();
  const timelineRef = useRef<TimelineRef>(null);
  const [engine, setEngine] = useState<TimelineRef['engine'] | null>(null);
  const [playback, setPlayback] = useState<TimelineRef['playback'] | null>(null);
  const [leftTab, setLeftTab] = useState<'media' | 'subtitle'>('media');

  // A draft carries its own frame rate and canvas size; both must be known
  // before EditorProvider constructs the engine, hence parsed here on mount.
  const envelope = useMemo(() => (draft ? parseDraft(draft) : null), [draft]);
  const fps = envelope?.project.fps ?? FPS;
  const stage = envelope?.project.stage ?? { width: 1920, height: 1080 };

  const [draftId, setDraftId] = useState<string | null>(draft?.id ?? null);
  const [draftName, setDraftName] = useState<string | null>(draft?.name ?? null);
  // Autosave stays off until a draft has finished loading: loadProject emits
  // 'history:change' synchronously, which would otherwise trigger a save that
  // overwrites the draft with a half-restored project.
  const [autosaveReady, setAutosaveReady] = useState(!draft);
  const [missingMedia, setMissingMedia] = useState<MissingMedia[]>([]);

  // Held in a ref, not state: the autosave reads it when it fires, and making it
  // a dependency would reschedule the debounce on every keystroke.
  const subtitleDraftRef = useRef<SubtitleDubDraft | undefined>(envelope?.subtitle);
  const handleSubtitleChange = useCallback((d: SubtitleDubDraft) => {
    subtitleDraftRef.current = d;
  }, []);
  const getSubtitle = useCallback(() => subtitleDraftRef.current, []);

  useElahDialogI18n();

  // Elah dialogs portal to <body>; give them the theme vars there too.
  useEffect(() => {
    document.body.classList.add('elah-root');
    return () => document.body.classList.remove('elah-root');
  }, []);

  const captureRef = (node: TimelineRef | null) => {
    timelineRef.current = node;
    if (node && node.engine !== engine) {
      setEngine(node.engine);
      setPlayback(node.playback);
    }
  };

  // Restore a draft once the engine exists (it arrives via the Timeline ref, so
  // it is null on the first render pass).
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!engine || !envelope || loadedRef.current) return;
    loadedRef.current = true;
    let cancelled = false;

    void (async () => {
      try {
        const { missing, srcRemap } = await relinkDraftMedia(envelope);
        if (cancelled) return;
        // Rewrite dead media URLs on the plain object before handing it to the
        // engine, so its history never contains the broken intermediate state.
        engine.loadProject(remapProjectSrcs(envelope.project, srcRemap));
        usePlaybackStore.getState().setCurrentFrame(0);
        setMissingMedia(missing);
      } catch (e) {
        console.warn('[editor] failed to restore draft', e);
        toast.error({ title: t('editor.drafts.openFailed'), message: String(e) });
      } finally {
        if (!cancelled) setAutosaveReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [engine, envelope, toast, t]);

  const { saveState, saveNow } = useDraftAutosave({
    engine,
    draftId,
    onDraftCreated: setDraftId,
    name: draftName,
    getSubtitle,
    enabled: autosaveReady,
  });

  // Passed to SourcePanel as onRequestImport, so its "+ Add" opens the Tauri
  // dialog (which yields real paths) instead of the pathless file input.
  const handleImportMedia = useCallback(async () => {
    try {
      const assets = await importMediaFromDialog();
      // Name an untitled project after its first import, matching CapCut.
      if (assets.length > 0) {
        setDraftName((prev) => prev ?? assets[0].name.replace(/\.[^.]+$/, ''));
      }
    } catch (e) {
      toast.error({ title: t('editor.drafts.importFailed'), message: String(e) });
    }
  }, [toast, t]);

  const handleExit = async () => {
    await saveNow();
    onExit?.();
  };

  return (
    <div className="elah-root flex flex-col h-full min-h-0 bg-ed-bg text-ed-text">
      <EditorProvider fps={fps} defaultTrackHeight={36} initialTracks={INITIAL_TRACKS} stage={stage}>
        <DraftBar
          name={draftName}
          saveState={saveState}
          onRename={setDraftName}
          onSaveNow={() => void saveNow()}
          onExit={onExit ? () => void handleExit() : undefined}
        />
        {missingMedia.length > 0 && (
          <MissingMediaBanner
            missing={missingMedia}
            engine={engine}
            onResolved={(id) => setMissingMedia((prev) => prev.filter((m) => m.entry.id !== id))}
          />
        )}
        <EditorToolbar engine={engine} playback={playback} projectName={draftName} />
        <div className="flex flex-1 min-h-0">
          {/* Left panel: switch between Elah's media/elements SourcePanel and the
              Subtitle + Voiceover panel. */}
          <div
            style={{ width: 280, flexShrink: 0, minHeight: 0, overflow: 'hidden' }}
            className="border-r border-ed-border bg-ed-panel flex flex-col"
          >
            <div className="flex border-b border-ed-border shrink-0">
              <button
                type="button"
                onClick={() => setLeftTab('media')}
                className={cn(
                  'flex-1 inline-flex items-center justify-center gap-1.5 py-2 text-xs transition-colors',
                  leftTab === 'media' ? 'text-ed-text' : 'text-ed-text-muted hover:text-ed-text',
                )}
                style={leftTab === 'media' ? { boxShadow: 'inset 0 -2px 0 var(--elah-accent)' } : undefined}
              >
                <Clapperboard className="w-4 h-4" /> {t('editor.subtitleDub.tabMedia')}
              </button>
              <button
                type="button"
                onClick={() => setLeftTab('subtitle')}
                className={cn(
                  'flex-1 inline-flex items-center justify-center gap-1.5 py-2 text-xs transition-colors',
                  leftTab === 'subtitle' ? 'text-ed-text' : 'text-ed-text-muted hover:text-ed-text',
                )}
                style={leftTab === 'subtitle' ? { boxShadow: 'inset 0 -2px 0 var(--elah-accent)' } : undefined}
              >
                <Captions className="w-4 h-4" /> {t('editor.subtitleDub.tabSubtitle')}
              </button>
            </div>
            <div className={cn('flex-1 min-h-0', leftTab === 'media' ? 'flex flex-col' : 'hidden')}>
              {/* The panel's own "+ Add" is redirected through the Tauri dialog:
                  a File from its <input type=file> carries no filesystem path,
                  and without one a draft can't restore its media on reopen. */}
              {/* activateOnTap: without it the Media/Elements tiles are
                  drag-only, and clicking them does nothing. Drag-drop is
                  unreliable in this webview, so tap is the primary path here. */}
              <SourcePanel
                defaultLane="media"
                activateOnTap
                style={{ flex: 1, minHeight: 0 }}
                onRequestImport={handleImportMedia}
              />
            </div>
            {/* Keep mounted (hidden via CSS) when switching tabs — unmounting
                would wipe the panel's subtitle list, tracked clip ids, etc. */}
            <div className={cn('flex-1 min-h-0', leftTab === 'subtitle' ? 'flex flex-col' : 'hidden')}>
              <SubtitleDubPanel
                engine={engine}
                initialDraft={envelope?.subtitle}
                onDraftChange={handleSubtitleChange}
              />
            </div>
          </div>
          <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-black">
            <AspectControl />
            <div className="flex-1 min-h-0 relative bg-black py-6">
              <Preview demuxerFactory={demuxerFactory} style={{ width: '100%', height: '100%' }} />
            </div>
            <TransportBar fps={fps} />
          </div>
          <ClipProperties />
        </div>
        <TimelineControls timelineRef={timelineRef} />
        <Timeline ref={captureRef} fps={fps} style={{ height: 240, flexShrink: 0, minWidth: 0 }} />
      </EditorProvider>
    </div>
  );
}
