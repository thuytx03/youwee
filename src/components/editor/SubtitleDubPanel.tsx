import type { Clip, TimelineEngine } from '@elah/editor';
import { useMediaLibraryStore, useSelectionStore } from '@elah/editor';
import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { Captions, Languages, Loader2, Mic, Music, SpellCheck, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { useAI } from '@/contexts/AIContext';
import { ttsSynthesize, transcribeVideoBytes } from '@/contexts/editor/editor-client';
import { toAssetUrl } from '@/lib/asset-access';
import { cn } from '@/lib/utils';
import { parseSubtitles, type SubtitleEntry } from '@/lib/subtitle-parser';
import {
  proofreadSubtitleTexts,
  TRANSLATE_CANCELLED,
  translateSubtitleTexts,
} from '@/lib/subtitle-translate';
import { LANGUAGE_OPTIONS } from '@/lib/types';
import {
  DEFAULT_TTS_MODEL,
  resolveTargetLanguage,
  TTS_VOICES,
  type TtsProvider,
} from '@/lib/tts-voices';

const FPS = 30;
const msToFrame = (ms: number) => Math.max(1, Math.round((ms / 1000) * FPS));

function formatTimecode(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Combine a hex color + 0..1 opacity into an rgba() string for Clip.backgroundColor.
function hexToRgba(hex: string, opacity: number): string {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

// Inverse of hexToRgba — reads back a clip's backgroundColor so the per-line
// editor can show the same color/opacity that's actually painted.
function rgbaToHexOpacity(rgba: string | undefined): { hex: string; opacity: number } {
  const m = rgba?.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/);
  if (!m) return { hex: '#000000', opacity: 0.6 };
  const toHex = (n: string) => Number(n).toString(16).padStart(2, '0');
  return { hex: `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`, opacity: m[4] !== undefined ? Number(m[4]) : 1 };
}

interface Props {
  engine: TimelineEngine | null;
}

export function SubtitleDubPanel({ engine }: Props) {
  const { t, i18n } = useTranslation('pages');
  const toast = useToast();
  const ai = useAI();

  // Original-language entries (from Whisper or an uploaded file) and, once
  // translated, a separate set of translated entries — kept side by side so
  // the user can add either one to the timeline independently.
  const [entries, setEntries] = useState<SubtitleEntry[]>([]);
  const [translatedEntries, setTranslatedEntries] = useState<SubtitleEntry[] | null>(null);
  const [busy, setBusy] = useState<string>(''); // '', 'transcribe', 'proofread', 'translate', 'dub'
  const [progress, setProgress] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  // Original and translated subtitles live on separate tracks so adding one
  // never wipes out the other — the user can have both on the timeline at once.
  const originalTrackId = useRef<string | null>(null);
  const translatedTrackId = useRef<string | null>(null);
  const isSubtitleTrack = (trackId: string) =>
    trackId === originalTrackId.current || trackId === translatedTrackId.current;
  // Reused across dub runs so re-generating (after editing subtitles or
  // switching voice) replaces the previous voiceover instead of stacking a
  // new "Voiceover" track each time.
  const dubTrackId = useRef<string | null>(null);
  // Selected clips on the timeline (Elah selection store) — used to detect
  // "exactly one subtitle clip selected", which switches on tier 2 (per-line edit).
  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds);

  // Tier 1 — shared style, applied to every subtitle clip.
  const [styleX, setStyleX] = useState(0.5);
  const [styleY, setStyleY] = useState(0.86);
  const [styleScale, setStyleScale] = useState(1);
  const [styleFontSize, setStyleFontSize] = useState(42);
  const [styleColor, setStyleColor] = useState('#ffffff');
  // Caption background — off by default; hex + opacity are combined into an
  // rgba() string when applied (Clip.backgroundColor).
  const [styleBgEnabled, setStyleBgEnabled] = useState(false);
  const [styleBgColor, setStyleBgColor] = useState('#000000');
  const [styleBgOpacity, setStyleBgOpacity] = useState(0.6);
  const styleBackgroundColor = styleBgEnabled ? hexToRgba(styleBgColor, styleBgOpacity) : undefined;

  // Default translation target = active app language.
  const defaultTarget = useMemo(
    () => resolveTargetLanguage(i18n.resolvedLanguage || i18n.language || 'en'),
    [i18n.resolvedLanguage, i18n.language],
  );
  const [targetCode, setTargetCode] = useState(defaultTarget.code);
  const targetName = LANGUAGE_OPTIONS.find((o) => o.code === targetCode)?.name ?? 'English';

  const ttsProvider: TtsProvider = ai.config.provider === 'openai' ? 'openai' : 'gemini';
  const [voice, setVoice] = useState(TTS_VOICES[ttsProvider][0].id);

  // Tier 2 — exactly one subtitle clip selected on the timeline → per-line edit.
  // Dragging/resizing the clip on the Preview updates it in the engine without
  // changing the selection, so we also re-read on every 'clip:updated' event
  // (via this counter) to keep the sliders in sync with the live position.
  const [clipVersion, setClipVersion] = useState(0);
  useEffect(() => {
    if (!engine) return;
    const onUpdated = (clip: Clip) => {
      if (selectedClipIds.has(clip.id)) setClipVersion((v) => v + 1);
    };
    engine.on('clip:updated', onUpdated);
    return () => engine.off('clip:updated', onUpdated);
  }, [engine, selectedClipIds]);
  const selectedSubtitleClip = useMemo(() => {
    if (!engine || selectedClipIds.size !== 1) return null;
    const id = selectedClipIds.values().next().value as string;
    const found = engine.findClip(id);
    if (!found || found.clip.type !== 'text') return null;
    if (!isSubtitleTrack(found.trackId)) return null;
    return found;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, selectedClipIds, clipVersion]);

  // Dragging/resizing a subtitle clip directly on the Preview is the primary
  // way to reposition it now. Elah fires 'clip:updated' on EVERY drag tick
  // (not just on mouse release), so we debounce: only once no further update
  // arrives for a short pause do we treat the drag as settled and ask whether
  // to apply that position to every other subtitle clip ON THE SAME TRACK —
  // original and translated subtitles are positioned independently, so a
  // drag on one must never carry over to the other.
  const [applyPrompt, setApplyPrompt] = useState<{
    transform: NonNullable<Clip['transform']>;
    fontSize?: number;
    color?: string;
    trackId: string;
    others: { id: string; trackId: string }[];
  } | null>(null);
  const dragSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Applying the prompt itself calls updateClip on every other clip, which
  // fires 'clip:updated' right back at us — guard against re-opening the
  // prompt from our own writes, otherwise it loops forever.
  const applyingRef = useRef(false);
  useEffect(() => {
    if (!engine) return;
    const onUpdated = (clip: Clip) => {
      if (applyingRef.current) return;
      if (clip.type !== 'text' || !isSubtitleTrack(clip.trackId)) return;
      const tf = clip.transform;
      if (!tf) return;
      const trackId = clip.trackId;
      if (dragSettleTimer.current) clearTimeout(dragSettleTimer.current);
      dragSettleTimer.current = setTimeout(() => {
        const others = engine
          .getClipsOnTrack(trackId)
          .filter((c) => c.type === 'text' && c.id !== clip.id)
          .map((c) => ({ id: c.id, trackId }));
        if (others.length === 0) return;
        setApplyPrompt({ transform: tf, fontSize: clip.fontSize, color: clip.color, trackId, others });
      }, 500);
    };
    engine.on('clip:updated', onUpdated);
    return () => {
      engine.off('clip:updated', onUpdated);
      if (dragSettleTimer.current) clearTimeout(dragSettleTimer.current);
    };
  }, [engine]);

  const confirmApplyToAll = () => {
    if (!engine || !applyPrompt) return;
    const { others, transform: tf, fontSize, color } = applyPrompt;
    applyingRef.current = true;
    engine.batch(() => {
      for (const { id, trackId } of others) {
        engine.updateClip(id, trackId, { transform: { ...tf, rotation: 0 }, fontSize, color });
      }
    }, 'Apply subtitle position to all');
    // engine.updateClip() emits 'clip:updated' synchronously, so the guard
    // can be released right after the batch call completes.
    applyingRef.current = false;
    setStyleX(tf.x);
    setStyleY(tf.y);
    setStyleScale(tf.scale);
    setApplyPrompt(null);
  };

  const hasOriginalOnTimeline = !!originalTrackId.current;
  const hasTranslatedOnTimeline = !!translatedTrackId.current;

  const ttsApiKey =
    ai.config.provider === 'openai'
      ? ai.config.api_key ?? ''
      : ai.config.api_key ?? '';
  const whisperKey =
    ai.config.whisper_api_key || (ai.config.provider === 'openai' ? ai.config.api_key : '') || '';

  // ── 1. Get source subtitles: Whisper from the video already in the editor,
  // or upload SRT/VTT. Elah assets are blob URLs, so fetch bytes and send them.
  const handleTranscribe = async () => {
    if (!whisperKey) {
      toast.error({
        title: t('editor.subtitleDub.needWhisperKey'),
        message: t('editor.subtitleDub.needWhisperKeyMsg'),
      });
      return;
    }
    // Pick the most recent video asset from the media library.
    const { assets, order } = useMediaLibraryStore.getState();
    const videoAsset = [...order]
      .reverse()
      .map((id) => assets[id])
      .find((a) => a?.kind === 'video');
    if (!videoAsset) {
      toast.error({ title: t('editor.subtitleDub.noVideo'), message: t('editor.subtitleDub.noVideoMsg') });
      return;
    }
    setBusy('transcribe');
    setProgress(t('editor.subtitleDub.transcribing'));
    try {
      const resp = await fetch(videoAsset.src);
      const buf = new Uint8Array(await resp.arrayBuffer());
      const srt = await transcribeVideoBytes({
        bytes: buf,
        filename: videoAsset.name || 'video.mp4',
        apiKey: whisperKey,
        whisperEndpointUrl: ai.config.whisper_endpoint_url || undefined,
        whisperModel: ai.config.whisper_model || 'whisper-1',
      });
      const parsed = parseSubtitles(srt);
      setEntries(parsed.entries);
      setTranslatedEntries(null);
      toast.success({ title: t('editor.subtitleDub.subtitlesReady', { count: parsed.entries.length }) });
    } catch (e) {
      toast.error({ title: t('editor.subtitleDub.transcribeFailed'), message: String(e) });
    } finally {
      setBusy('');
      setProgress('');
    }
  };

  const handleUpload = async () => {
    const file = await open({
      multiple: false,
      filters: [{ name: 'Subtitle', extensions: ['srt', 'vtt', 'ass'] }],
    });
    if (typeof file !== 'string') return;
    try {
      const content = await readTextFile(file);
      const parsed = parseSubtitles(content);
      setEntries(parsed.entries);
      setTranslatedEntries(null);
      toast.success({ title: t('editor.subtitleDub.subtitlesReady', { count: parsed.entries.length }) });
    } catch (e) {
      toast.error({ title: t('editor.subtitleDub.uploadFailed'), message: String(e) });
    }
  };

  // ── 1b. Proofread the raw transcript: Whisper mishears/typos often slip
  // through and, left uncorrected, propagate into both the translation and
  // the TTS voiceover (wrong words get spoken). Fixes the text in place,
  // keeping the same entries/timestamps.
  const handleProofread = async () => {
    if (entries.length === 0) return;
    if (!ai.config.enabled || !ai.config.api_key) {
      toast.error({ title: t('editor.subtitleDub.needAI'), message: t('editor.subtitleDub.needAIMsg') });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy('proofread');
    try {
      const corrected = await proofreadSubtitleTexts(
        entries.map((e) => e.text),
        {
          signal: controller.signal,
          onProgress: (done, total) =>
            setProgress(t('editor.subtitleDub.proofreading', { done, total })),
        },
      );
      setEntries((prev) => prev.map((e, i) => ({ ...e, text: corrected[i] ?? e.text })));
      toast.success({ title: t('editor.subtitleDub.proofreadDone') });
    } catch (e) {
      if (String(e).includes(TRANSLATE_CANCELLED)) toast.info({ title: t('editor.subtitleDub.cancelled') });
      else toast.error({ title: t('editor.subtitleDub.proofreadFailed'), message: String(e) });
    } finally {
      setBusy('');
      setProgress('');
      abortRef.current = null;
    }
  };

  // ── 2. Translate to target language.
  const handleTranslate = async () => {
    if (entries.length === 0) return;
    if (!ai.config.enabled || !ai.config.api_key) {
      toast.error({ title: t('editor.subtitleDub.needAI'), message: t('editor.subtitleDub.needAIMsg') });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy('translate');
    try {
      const translated = await translateSubtitleTexts(
        entries.map((e) => e.text),
        targetName,
        {
          signal: controller.signal,
          onProgress: (done, total) =>
            setProgress(t('editor.subtitleDub.translating', { done, total })),
        },
      );
      setTranslatedEntries(entries.map((e, i) => ({ ...e, text: translated[i] ?? e.text })));
      toast.success({ title: t('editor.subtitleDub.translateDone') });
    } catch (e) {
      if (String(e).includes(TRANSLATE_CANCELLED)) toast.info({ title: t('editor.subtitleDub.cancelled') });
      else toast.error({ title: t('editor.subtitleDub.translateFailed'), message: String(e) });
    } finally {
      setBusy('');
      setProgress('');
      abortRef.current = null;
    }
  };

  // Manual edits from the preview lists — let the user review/fix a line
  // before adding it to the timeline or generating a voiceover from it.
  const updateEntryText = (id: string, text: string) =>
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, text } : e)));
  const updateTranslatedEntryText = (id: string, text: string) =>
    setTranslatedEntries((prev) => (prev ? prev.map((e) => (e.id === id ? { ...e, text } : e)) : prev));

  // ── 3. Add/update subtitle text clips on a dedicated elements track (timed).
  // Original and translated subtitles each get their own track (via
  // trackIdRef) so adding/updating one never touches the other. Elah rejects
  // overlapping clips on a track, so we (a) reuse or create the track, (b)
  // shrink each clip so it ends just before the next cue starts, and (c) skip
  // any clip that still can't be placed instead of aborting the batch.
  // Re-running (e.g. after re-translating) replaces that track's own clips so
  // it always mirrors the chosen entries + shared style.
  const handleAddSubtitles = (
    source: SubtitleEntry[],
    trackIdRef: { current: string | null },
    trackName: string,
  ) => {
    if (!engine || source.length === 0) return;
    let trackId = trackIdRef.current;
    if (trackId) {
      // Replace this track's existing clips rather than stacking duplicates.
      for (const c of engine.getClipsOnTrack(trackId)) {
        if (c.type === 'text') engine.removeClip(c.id, trackId);
      }
    } else {
      const track = engine.addTrack('elements', { name: trackName });
      trackId = track.id;
      trackIdRef.current = trackId;
    }
    let added = 0;
    engine.batch(() => {
      const sorted = [...source].sort((a, b) => a.startTime - b.startTime);
      for (let i = 0; i < sorted.length; i++) {
        const e = sorted[i];
        const startF = msToFrame(e.startTime);
        // Cap the end at the next cue's start (minus 1 frame) to avoid overlap.
        const nextStartF = i + 1 < sorted.length ? msToFrame(sorted[i + 1].startTime) : Infinity;
        let endF = msToFrame(e.endTime);
        if (endF >= nextStartF) endF = nextStartF - 1;
        const durationFrames = Math.max(endF - startF, 1);
        if (durationFrames < 1) continue;
        try {
          engine.addClip({
            type: 'text',
            trackId: trackId as string,
            startFrame: startF,
            durationFrames,
            text: {
              content: e.text,
              fontSize: styleFontSize,
              color: styleColor,
              textAlign: 'center',
              ...(styleBackgroundColor ? { backgroundColor: styleBackgroundColor } : {}),
            },
            // Position subtitles at the current style position (y is 0..1 of
            // stage height, 0.5 = center) so they read like real captions.
            transform: { x: styleX, y: styleY, scale: styleScale, rotation: 0, anchor: { x: 0.5, y: 0.5 } },
          });
          added += 1;
        } catch {
          // Skip clips that still can't be placed (e.g. zero-length cues).
        }
      }
    }, 'Add subtitles');
    toast.success({ title: t('editor.subtitleDub.subtitlesAdded', { count: added }) });
  };

  // Apply the shared style to every subtitle clip currently on the timeline,
  // across both the original and translated tracks (rotation reset to 0 so
  // any clip nudged by hand snaps back in line).
  const applyStyleToAll = (
    over: Partial<{ x: number; y: number; scale: number; fontSize: number; color: string; backgroundColor?: string }> = {},
  ) => {
    if (!engine) return;
    const x = over.x ?? styleX;
    const y = over.y ?? styleY;
    const scale = over.scale ?? styleScale;
    const fontSize = over.fontSize ?? styleFontSize;
    const color = over.color ?? styleColor;
    const backgroundColor = 'backgroundColor' in over ? over.backgroundColor : styleBackgroundColor;
    engine.batch(() => {
      for (const trackId of [originalTrackId.current, translatedTrackId.current]) {
        if (!trackId) continue;
        for (const c of engine.getClipsOnTrack(trackId)) {
          if (c.type !== 'text') continue;
          engine.updateClip(c.id, trackId, {
            transform: { x, y, scale, rotation: 0, anchor: { x: 0.5, y: 0.5 } },
            fontSize,
            color,
            backgroundColor,
          });
        }
      }
    }, 'Update subtitle style');
  };

  const setScale = (scale: number) => {
    setStyleScale(scale);
    applyStyleToAll({ scale });
  };
  const setFontSize = (fontSize: number) => {
    setStyleFontSize(fontSize);
    applyStyleToAll({ fontSize });
  };
  const setColor = (color: string) => {
    setStyleColor(color);
    applyStyleToAll({ color });
  };

  // Background — hex + opacity are only meaningful while enabled; disabling
  // clears it (applyStyleToAll writes `undefined` explicitly either way).
  const setBgEnabled = (enabled: boolean) => {
    setStyleBgEnabled(enabled);
    applyStyleToAll({ backgroundColor: enabled ? hexToRgba(styleBgColor, styleBgOpacity) : undefined });
  };
  const setBgColor = (hex: string) => {
    setStyleBgColor(hex);
    if (styleBgEnabled) applyStyleToAll({ backgroundColor: hexToRgba(hex, styleBgOpacity) });
  };
  const setBgOpacity = (opacity: number) => {
    setStyleBgOpacity(opacity);
    if (styleBgEnabled) applyStyleToAll({ backgroundColor: hexToRgba(styleBgColor, opacity) });
  };

  // Tier 2 — edit only the single selected subtitle clip, independent of the
  // shared style above.
  const updateSelectedClip = (patch: Partial<Clip>) => {
    if (!engine || !selectedSubtitleClip) return;
    engine.updateClip(selectedSubtitleClip.clip.id, selectedSubtitleClip.trackId, patch);
  };
  const selTf = selectedSubtitleClip?.clip.transform;
  const selX = selTf?.x ?? 0.5;
  const selY = selTf?.y ?? 0.86;
  const selScale = selTf?.scale ?? 1;
  const selFontSize = selectedSubtitleClip?.clip.fontSize ?? 42;
  const selColor = selectedSubtitleClip?.clip.color ?? '#ffffff';
  const setSelScale = (scale: number) =>
    updateSelectedClip({ transform: { x: selX, y: selY, scale, rotation: 0, anchor: { x: 0.5, y: 0.5 } } });
  const setSelFontSize = (fontSize: number) => updateSelectedClip({ fontSize });
  const setSelColor = (color: string) => updateSelectedClip({ color });
  const selBgEnabled = !!selectedSubtitleClip?.clip.backgroundColor;
  const { hex: selBgColor, opacity: selBgOpacity } = rgbaToHexOpacity(
    selectedSubtitleClip?.clip.backgroundColor,
  );
  const setSelBgEnabled = (enabled: boolean) =>
    updateSelectedClip({ backgroundColor: enabled ? hexToRgba(selBgColor, selBgOpacity) : undefined });
  const setSelBgColor = (hex: string) => {
    if (selBgEnabled) updateSelectedClip({ backgroundColor: hexToRgba(hex, selBgOpacity) });
  };
  const setSelBgOpacity = (opacity: number) => {
    if (selBgEnabled) updateSelectedClip({ backgroundColor: hexToRgba(selBgColor, opacity) });
  };

  // ── 4. Voiceover: TTS per line, place on a dedicated audio track (keep original).
  // Voice the translated text when available (the point of dubbing is to speak
  // the target language), falling back to the original if not yet translated.
  const dubSource = translatedEntries ?? entries;
  const handleDub = async () => {
    if (!engine || dubSource.length === 0) return;
    if (!ttsApiKey) {
      toast.error({ title: t('editor.subtitleDub.needAI'), message: t('editor.subtitleDub.needAIMsg') });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy('dub');
    // Dedicated voiceover track so the original audio stays untouched. Reuse
    // it across runs (e.g. after editing subtitles or switching voice)
    // instead of stacking a new "Voiceover" track each time.
    let trackId = dubTrackId.current;
    if (trackId) {
      for (const c of engine.getClipsOnTrack(trackId)) {
        if (c.type === 'audio') engine.removeClip(c.id, trackId);
      }
    } else {
      const dubTrack = engine.addTrack('audio', { name: 'Voiceover' });
      trackId = dubTrack.id;
      dubTrackId.current = trackId;
    }
    const model = DEFAULT_TTS_MODEL[ttsProvider];
    const sorted = [...dubSource].sort((a, b) => a.startTime - b.startTime);
    // Track the next free frame so back-to-back clips never overlap (A+: if a
    // clip runs long, the next one is pushed later instead of colliding).
    let nextFreeFrame = 0;
    try {
      for (let i = 0; i < sorted.length; i++) {
        if (controller.signal.aborted) break;
        const e = sorted[i];
        if (!e.text.trim()) continue;
        setProgress(t('editor.subtitleDub.dubbing', { done: i + 1, total: sorted.length }));
        const res = await ttsSynthesize({
          provider: ttsProvider,
          voice,
          text: e.text,
          apiKey: ttsApiKey,
          model,
          windowMs: e.endTime - e.startTime,
          index: i,
        });
        const src = await toAssetUrl(res.path);
        const startF = Math.max(msToFrame(e.startTime), nextFreeFrame);
        const durF = Math.max(msToFrame(res.duration_ms), 1);
        try {
          engine.addClip({ type: 'audio', trackId, startFrame: startF, durationFrames: durF, src });
          nextFreeFrame = startF + durF;
        } catch {
          // Skip a clip that still can't be placed rather than aborting the run.
        }
      }
      if (!controller.signal.aborted) toast.success({ title: t('editor.subtitleDub.dubDone') });
    } catch (err) {
      toast.error({ title: t('editor.subtitleDub.dubFailed'), message: String(err) });
    } finally {
      setBusy('');
      setProgress('');
      abortRef.current = null;
    }
  };

  const cancel = () => abortRef.current?.abort();

  const btn =
    'w-full inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm border border-ed-border text-ed-text hover:bg-ed-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const sectionTitle = 'text-[11px] font-semibold text-ed-text-muted uppercase tracking-wide mt-1';

  return (
    <div className="flex flex-col gap-3 p-3 overflow-y-auto text-ed-text" style={{ height: '100%' }}>
      <div className="text-sm font-semibold flex items-center gap-2">
        <Captions className="w-4 h-4" /> {t('editor.subtitleDub.title')}
      </div>

      {/* 1. Source subtitles */}
      <div className={sectionTitle}>{t('editor.subtitleDub.sourceSection')}</div>
      <button type="button" className={btn} onClick={handleTranscribe} disabled={!!busy}>
        {busy === 'transcribe' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mic className="w-4 h-4" />}
        {t('editor.subtitleDub.fromVideo')}
      </button>
      <button type="button" className={btn} onClick={handleUpload} disabled={!!busy}>
        <Captions className="w-4 h-4" /> {t('editor.subtitleDub.fromFile')}
      </button>
      {entries.length > 0 && (
        <div className="text-xs text-ed-text-muted">
          {t('editor.subtitleDub.lineCount', { count: entries.length })}
        </div>
      )}
      <SubtitleEntryList entries={entries} onChangeText={updateEntryText} disabled={!!busy} />
      <button type="button" className={btn} onClick={handleProofread} disabled={!!busy || entries.length === 0}>
        {busy === 'proofread' ? <Loader2 className="w-4 h-4 animate-spin" /> : <SpellCheck className="w-4 h-4" />}
        {t('editor.subtitleDub.proofread')}
      </button>
      <div className="text-[11px] text-ed-text-muted -mt-1">{t('editor.subtitleDub.proofreadHint')}</div>
      <button
        type="button"
        className={btn}
        onClick={() => handleAddSubtitles(entries, originalTrackId, 'Subtitles (original)')}
        disabled={!!busy || entries.length === 0}
      >
        <Wand2 className="w-4 h-4" />
        {hasOriginalOnTimeline
          ? t('editor.subtitleDub.updateTimelineOriginal')
          : t('editor.subtitleDub.addToTimelineOriginal')}
      </button>

      {/* 2. Translate */}
      <div className={sectionTitle}>{t('editor.subtitleDub.translateSection')}</div>
      <div className="flex flex-col gap-1 text-xs text-ed-text-muted">
        {t('editor.subtitleDub.targetLang')}
        <Select value={targetCode} onValueChange={setTargetCode}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGE_OPTIONS.map((o) => (
              <SelectItem key={o.code} value={o.code}>
                {o.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <button type="button" className={btn} onClick={handleTranslate} disabled={!!busy || entries.length === 0}>
        {busy === 'translate' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Languages className="w-4 h-4" />}
        {t('editor.subtitleDub.translate')}
      </button>
      {translatedEntries && (
        <SubtitleEntryList entries={translatedEntries} onChangeText={updateTranslatedEntryText} disabled={!!busy} />
      )}
      <button
        type="button"
        className={btn}
        onClick={() =>
          translatedEntries &&
          handleAddSubtitles(translatedEntries, translatedTrackId, 'Subtitles (translated)')
        }
        disabled={!!busy || !translatedEntries || translatedEntries.length === 0}
      >
        <Wand2 className="w-4 h-4" />
        {hasTranslatedOnTimeline
          ? t('editor.subtitleDub.updateTimelineTranslated')
          : t('editor.subtitleDub.addToTimelineTranslated')}
      </button>

      {/* 3. Style shared by all subtitles */}
      <div className={sectionTitle}>{t('editor.subtitleDub.styleSection')}</div>
      <div className="text-[11px] text-ed-text-muted -mt-1">{t('editor.subtitleDub.dragToPositionHint')}</div>
      <Slider label={t('editor.subtitleDub.scale')} value={styleScale} min={0.2} max={3} step={0.05}
        display={`${Math.round(styleScale * 100)}%`} onChange={setScale} />
      <Slider label={t('editor.subtitleDub.fontSize')} value={styleFontSize} min={12} max={120} step={1}
        display={`${styleFontSize}`} onChange={(v) => setFontSize(Math.round(v))} />
      <label className="flex items-center justify-between gap-2 text-xs text-ed-text-muted">
        {t('editor.subtitleDub.color')}
        <input type="color" value={styleColor} onChange={(ev) => setColor(ev.target.value)}
          className="w-10 h-7 rounded border border-ed-border bg-transparent cursor-pointer" />
      </label>
      <div className="text-[11px] text-ed-text-muted -mb-1">{t('editor.subtitleDub.background')}</div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setBgEnabled(false)}
          className={cn(
            'flex-1 rounded-md px-2 py-1.5 text-xs border transition-colors',
            !styleBgEnabled ? 'border-ed-accent text-ed-text' : 'border-ed-border text-ed-text-muted hover:bg-ed-elevated',
          )}
        >
          {t('editor.subtitleDub.bgNone')}
        </button>
        <button
          type="button"
          onClick={() => setBgEnabled(true)}
          className={cn(
            'flex-1 rounded-md px-2 py-1.5 text-xs border transition-colors',
            styleBgEnabled ? 'border-ed-accent text-ed-text' : 'border-ed-border text-ed-text-muted hover:bg-ed-elevated',
          )}
        >
          {t('editor.subtitleDub.bgSolid')}
        </button>
      </div>
      {styleBgEnabled && (
        <>
          <label className="flex items-center justify-between gap-2 text-xs text-ed-text-muted">
            {t('editor.subtitleDub.bgColor')}
            <input type="color" value={styleBgColor} onChange={(ev) => setBgColor(ev.target.value)}
              className="w-10 h-7 rounded border border-ed-border bg-transparent cursor-pointer" />
          </label>
          <Slider label={t('editor.subtitleDub.bgOpacity')} value={styleBgOpacity} min={0} max={1} step={0.05}
            display={`${Math.round(styleBgOpacity * 100)}%`} onChange={setBgOpacity} />
        </>
      )}

      {/* 3b. Tier 2 — appears only while exactly one subtitle clip is selected. */}
      {selectedSubtitleClip && (
        <>
          <div className={sectionTitle}>{t('editor.subtitleDub.editSelectedSection')}</div>
          <div className="text-[11px] text-ed-text-muted -mt-1 truncate">
            {t('editor.subtitleDub.editingLine', {
              text: selectedSubtitleClip.clip.content?.slice(0, 40) || '',
            })}
          </div>
          <Slider label={t('editor.subtitleDub.scale')} value={selScale} min={0.2} max={3} step={0.05}
            display={`${Math.round(selScale * 100)}%`} onChange={setSelScale} />
          <Slider label={t('editor.subtitleDub.fontSize')} value={selFontSize} min={12} max={120} step={1}
            display={`${selFontSize}`} onChange={(v) => setSelFontSize(Math.round(v))} />
          <label className="flex items-center justify-between gap-2 text-xs text-ed-text-muted">
            {t('editor.subtitleDub.color')}
            <input type="color" value={selColor} onChange={(ev) => setSelColor(ev.target.value)}
              className="w-10 h-7 rounded border border-ed-border bg-transparent cursor-pointer" />
          </label>
          <div className="text-[11px] text-ed-text-muted -mb-1">{t('editor.subtitleDub.background')}</div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setSelBgEnabled(false)}
              className={cn(
                'flex-1 rounded-md px-2 py-1.5 text-xs border transition-colors',
                !selBgEnabled ? 'border-ed-accent text-ed-text' : 'border-ed-border text-ed-text-muted hover:bg-ed-elevated',
              )}
            >
              {t('editor.subtitleDub.bgNone')}
            </button>
            <button
              type="button"
              onClick={() => setSelBgEnabled(true)}
              className={cn(
                'flex-1 rounded-md px-2 py-1.5 text-xs border transition-colors',
                selBgEnabled ? 'border-ed-accent text-ed-text' : 'border-ed-border text-ed-text-muted hover:bg-ed-elevated',
              )}
            >
              {t('editor.subtitleDub.bgSolid')}
            </button>
          </div>
          {selBgEnabled && (
            <>
              <label className="flex items-center justify-between gap-2 text-xs text-ed-text-muted">
                {t('editor.subtitleDub.bgColor')}
                <input type="color" value={selBgColor} onChange={(ev) => setSelBgColor(ev.target.value)}
                  className="w-10 h-7 rounded border border-ed-border bg-transparent cursor-pointer" />
              </label>
              <Slider label={t('editor.subtitleDub.bgOpacity')} value={selBgOpacity} min={0} max={1} step={0.05}
                display={`${Math.round(selBgOpacity * 100)}%`} onChange={setSelBgOpacity} />
            </>
          )}
        </>
      )}

      {/* 4. Voiceover */}
      <div className={sectionTitle}>{t('editor.subtitleDub.dubSection')}</div>
      <div className="text-xs text-ed-text-muted">
        {t('editor.subtitleDub.provider')}: {ttsProvider === 'openai' ? 'OpenAI' : 'Gemini'}
      </div>
      <div className="flex flex-col gap-1 text-xs text-ed-text-muted">
        {t('editor.subtitleDub.voice')}
        <Select value={voice} onValueChange={setVoice}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TTS_VOICES[ttsProvider].map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <button type="button" className={btn} onClick={handleDub} disabled={!!busy || dubSource.length === 0}>
        {busy === 'dub' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Music className="w-4 h-4" />}
        {t('editor.subtitleDub.generateVoiceover')}
      </button>
      <div className="text-[11px] text-ed-text-muted">{t('editor.subtitleDub.dubHint')}</div>

      {/* Progress / cancel */}
      {busy && (
        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-ed-text-muted">
          <span className="truncate">{progress}</span>
          {(busy === 'proofread' || busy === 'translate' || busy === 'dub') && (
            <button type="button" className="underline shrink-0" onClick={cancel}>
              {t('editor.subtitleDub.cancel')}
            </button>
          )}
        </div>
      )}

      <AlertDialog open={!!applyPrompt} onOpenChange={(open) => !open && setApplyPrompt(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('editor.subtitleDub.applyPositionPrompt')}</AlertDialogTitle>
            <AlertDialogDescription>{t('editor.subtitleDub.applyPositionPromptDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('editor.subtitleDub.justThisLine')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmApplyToAll}>{t('editor.subtitleDub.applyToAll')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Slider({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-ed-text-muted">
      <span className="flex justify-between">
        {label}
        <span className="font-mono tabular-nums text-ed-text">{display}</span>
      </span>
      <input
        type="range"
        className="elah-range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

// Scrollable, directly-editable preview of a subtitle entry list — used for
// both the original transcript and the translated one so the user can review
// (and fix) lines before adding them to the timeline or generating a voiceover.
function SubtitleEntryList({
  entries,
  onChangeText,
  disabled,
}: {
  entries: SubtitleEntry[];
  onChangeText: (id: string, text: string) => void;
  disabled?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasDisabled = useRef(disabled);
  useEffect(() => {
    // Scroll back to the top once a background pass (proofread/translate)
    // finishes — otherwise the list stays wherever the user had scrolled to,
    // which can look like the preview went blank if that was mid-list.
    if (wasDisabled.current && !disabled && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
    wasDisabled.current = disabled;
  }, [disabled]);

  if (entries.length === 0) return null;
  return (
    <div ref={scrollRef} className="flex flex-col gap-1.5 max-h-56 overflow-y-auto rounded-md border border-ed-border p-2 bg-ed-bg">
      {entries.map((e) => (
        <div key={e.id} className="flex gap-2 items-start">
          <span className="font-mono text-[10px] text-ed-text-muted pt-1.5 shrink-0 whitespace-nowrap">
            {formatTimecode(e.startTime)}
          </span>
          <textarea
            value={e.text}
            disabled={disabled}
            onChange={(ev) => onChangeText(e.id, ev.target.value)}
            rows={10}
            className="flex-1 resize-none bg-transparent text-xs text-ed-text border border-transparent rounded px-1.5 py-1 hover:border-ed-border focus:border-ed-accent focus:outline-none disabled:opacity-60"
          />
        </div>
      ))}
    </div>
  );
}
