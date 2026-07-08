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
import { Maximize2, Pause, Play, Square } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { EditorToolbar } from './EditorToolbar';
import { ClipProperties } from './properties/ClipProperties';
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
const TransportBar = memo(function TransportBar({ timelineRef }: { timelineRef: React.RefObject<TimelineRef | null> }) {
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const togglePlayPause = usePlaybackStore((s) => s.togglePlayPause);
  const totalFrames = useTracksStore((s) => s.totalFrames);
  const currentTimeRef = useRef<HTMLSpanElement>(null);
  const totalTimeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    return usePlaybackStore.subscribe((state) => {
      if (currentTimeRef.current) currentTimeRef.current.textContent = framesToTimecode(state.currentFrame, FPS);
    });
  }, []);
  useEffect(() => {
    if (totalTimeRef.current) totalTimeRef.current.textContent = framesToTimecode(Math.max(totalFrames, 1), FPS);
  }, [totalFrames]);

  const handleStop = () => {
    usePlaybackStore.getState().pause();
    usePlaybackStore.getState().setCurrentFrame(0);
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
      <div className="flex items-center gap-1.5 justify-end">
        <button type="button" title="Vừa khung" onClick={() => timelineRef.current?.fitToWindow()} className={ghostIcon}>
          <Maximize2 size={14} />
        </button>
      </div>
    </div>
  );
});

export function VideoEditorStudio() {
  const timelineRef = useRef<TimelineRef>(null);
  const [engine, setEngine] = useState<TimelineRef['engine'] | null>(null);
  const [playback, setPlayback] = useState<TimelineRef['playback'] | null>(null);

  useElahDialogI18n();

  // Elah dialogs portal to <body>; give them the theme vars there too.
  useEffect(() => {
    document.body.classList.add('elah-root');
    return () => document.body.classList.remove('elah-root');
  }, []);

  const captureRef = (node: TimelineRef | null) => {
    if (node && node.engine !== engine) {
      setEngine(node.engine);
      setPlayback(node.playback);
    }
  };

  return (
    <div className="elah-root flex flex-col h-full min-h-0 bg-ed-bg text-ed-text">
      <EditorProvider fps={FPS} defaultTrackHeight={36} initialTracks={INITIAL_TRACKS} stage={{ width: 1920, height: 1080 }}>
        <EditorToolbar engine={engine} playback={playback} />
        <div className="flex flex-1 min-h-0">
          {/* SourcePanel already provides its own Media / Elements tabs, so it
              replaces the separate icon rail + ElementsPanel (which duplicated it). */}
          <div
            style={{ width: 260, flexShrink: 0, minHeight: 0, overflow: 'hidden' }}
            className="border-r border-ed-border bg-ed-panel flex flex-col"
          >
            <SourcePanel defaultLane="media" style={{ flex: 1, minHeight: 0 }} />
          </div>
          <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-black">
            <AspectControl />
            <div className="flex-1 min-h-0 relative bg-black py-6">
              <Preview demuxerFactory={demuxerFactory} style={{ width: '100%', height: '100%' }} />
            </div>
            <TransportBar timelineRef={timelineRef} />
          </div>
          <ClipProperties />
        </div>
        <TimelineControls timelineRef={timelineRef} />
        <Timeline ref={captureRef} fps={FPS} style={{ height: 240, flexShrink: 0, minWidth: 0 }} />
      </EditorProvider>
    </div>
  );
}
