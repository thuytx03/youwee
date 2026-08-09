import type { Clip, TimelineEngine } from '@elah/editor';
import { useMediaLibraryStore, useTracksStore } from '@elah/editor';
import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import {
  Captions,
  Download,
  Languages,
  Loader2,
  Mic,
  Music,
  SpellCheck,
  Trash2,
  UserPlus,
  Volume2,
  Wand2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AIPromptHintField } from '@/components/shared/AIPromptHintField';
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
import {
  getDefaultLocalVoice,
  localTtsAddVoice,
  localTtsDeleteVoice,
  localTtsInstall,
  localTtsStatus,
  localTtsVoices,
  onLocalTtsSetup,
  transcribeVideoBytes,
  ttsSynthesize,
  type LocalTtsStatus,
  type LocalTtsVoices,
} from '@/contexts/editor/editor-client';
import { toAssetUrl } from '@/lib/asset-access';
import type { SubtitleDubDraft } from '@/lib/editor-drafts';
import { parseSubtitles, type SubtitleEntry } from '@/lib/subtitle-parser';
import {
  proofreadSubtitleTexts,
  TRANSLATE_CANCELLED,
  translateSubtitleTexts,
} from '@/lib/subtitle-translate';
import {
  DEFAULT_TTS_MODEL,
  resolveTargetLanguage,
  TTS_VOICES,
  type TtsProvider,
} from '@/lib/tts-voices';
import { LANGUAGE_OPTIONS } from '@/lib/types';
import {
  DEFAULT_SUBTITLE_STYLE,
  fitCaptionToVideo,
  ORIGINAL_TRACK_NAME,
  SUBTITLE_TRACK_NAMES,
  TRANSLATED_TRACK_NAME,
  VOICEOVER_TRACK_NAME,
} from './properties/textPresets';

const FPS = 30;
/** Duration in ms → frames, floored at 1 (a zero-length clip can't be placed). */
const msToFrame = (ms: number) => Math.max(1, Math.round((ms / 1000) * FPS));
/**
 * Timestamp in ms → frame index. Unlike msToFrame this may return 0: a cue that
 * starts at 0ms belongs on frame 0, and floring it at 1 would offset the whole
 * line by a frame.
 */
const msToFramePos = (ms: number) => Math.max(0, Math.round((ms / 1000) * FPS));

function formatTimecode(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

interface Props {
  engine: TimelineEngine | null;
  /**
   * Subtitle state restored from a saved draft. Read once, to seed initial
   * state — this panel stays mounted for the whole session, so it owns the
   * state from then on.
   */
  initialDraft?: SubtitleDubDraft;
  /**
   * Report the persistable slice upward so the draft autosave can include it.
   * Transient fields (busy, progress, prompts) are deliberately excluded.
   */
  onDraftChange?: (draft: SubtitleDubDraft) => void;
}

export function SubtitleDubPanel({ engine, initialDraft, onDraftChange }: Props) {
  const { t, i18n } = useTranslation('pages');
  const toast = useToast();
  const ai = useAI();

  // Original-language entries (from Whisper or an uploaded file) and, once
  // translated, a separate set of translated entries — kept side by side so
  // the user can add either one to the timeline independently.
  // Seeded from the draft so reopening a project doesn't force a re-transcribe
  // (Whisper is slow and costs API credits).
  const [entries, setEntries] = useState<SubtitleEntry[]>(
    () => (initialDraft?.entries as SubtitleEntry[] | undefined) ?? [],
  );
  const [translatedEntries, setTranslatedEntries] = useState<SubtitleEntry[] | null>(
    () => (initialDraft?.translatedEntries as SubtitleEntry[] | null | undefined) ?? null,
  );
  const [busy, setBusy] = useState<string>(''); // '', 'transcribe', 'proofread', 'translate', 'dub'
  const [progress, setProgress] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  // Free-form extra prompt instructions for the two AI passes. Session-only
  // (deliberately not part of the autosaved draft) — they steer wording for
  // domain-specific material without replacing the built-in prompt rules.
  const [proofreadHint, setProofreadHint] = useState('');
  const [translateHint, setTranslateHint] = useState('');

  // Original and translated subtitles live on separate tracks so adding one
  // never wipes out the other — the user can have both on the timeline at once.
  const originalTrackId = useRef<string | null>(null);
  const translatedTrackId = useRef<string | null>(null);

  /**
   * Whether a track holds subtitles. The refs above are only populated by
   * handleAddSubtitles, so checking them alone fails for tracks this mount
   * didn't create (after a remount, or on a project reopened from disk).
   * Falling back to the tracks' stable names covers both cases.
   */
  const isSubtitleTrack = (trackId: string): boolean => {
    if (trackId === originalTrackId.current || trackId === translatedTrackId.current) return true;
    const track = engine?.getProject().tracks.find((tr) => tr.id === trackId);
    return !!track && track.kind === 'elements' && SUBTITLE_TRACK_NAMES.includes(track.name);
  };
  // Reused across dub runs so re-generating (after editing subtitles or
  // switching voice) replaces the previous voiceover instead of stacking a
  // new "Voiceover" track each time.
  const dubTrackId = useRef<string | null>(null);
  // Position new subtitles start at. Still stateful because dragging a caption
  // on the preview and choosing "apply to all" feeds the position back here, so
  // subtitles re-added afterwards land where the user put them.
  const [styleX, setStyleX] = useState(initialDraft?.styleX ?? 0.5);
  const [styleY, setStyleY] = useState(initialDraft?.styleY ?? 0.86);
  const [styleScale, setStyleScale] = useState(initialDraft?.styleScale ?? 1);
  // Until the user has positioned a caption by hand, placement is derived from
  // the video picture (which moves with the aspect ratio). After that their
  // choice is authoritative and must not be recomputed out from under them.
  const [styleMoved, setStyleMoved] = useState(initialDraft?.styleMoved ?? false);

  // Default translation target = active app language.
  const defaultTarget = useMemo(
    () => resolveTargetLanguage(i18n.resolvedLanguage || i18n.language || 'en'),
    [i18n.resolvedLanguage, i18n.language],
  );
  const [targetCode, setTargetCode] = useState(initialDraft?.targetCode ?? defaultTarget.code);
  const targetName = LANGUAGE_OPTIONS.find((o) => o.code === targetCode)?.name ?? 'English';

  // Publish the persistable slice upward whenever it changes; the draft
  // autosave reads it on its own schedule. Transient fields (busy, progress,
  // applyPrompt) are excluded — they'd be meaningless after a reopen.
  useEffect(() => {
    onDraftChange?.({
      entries,
      translatedEntries,
      targetCode,
      styleX,
      styleY,
      styleScale,
      styleMoved,
    });
  }, [
    onDraftChange,
    entries,
    translatedEntries,
    targetCode,
    styleX,
    styleY,
    styleScale,
    styleMoved,
  ]);

  // Voice engine: the configured cloud provider, or the app-managed local
  // VieNeu engine (Vietnamese-focused, free, offline, with voice cloning).
  const cloudProvider: TtsProvider = ai.config.provider === 'openai' ? 'openai' : 'gemini';
  const [engineChoice, setEngineChoice] = useState<'cloud' | 'local'>('cloud');
  const ttsProvider: TtsProvider = engineChoice === 'local' ? 'local' : cloudProvider;
  const [voice, setVoice] = useState(TTS_VOICES[cloudProvider][0].id);
  const ttsModel = DEFAULT_TTS_MODEL[ttsProvider];

  // Local engine state, loaded lazily when the user switches to it.
  const [localStatus, setLocalStatus] = useState<LocalTtsStatus | null>(null);
  const [localInstalling, setLocalInstalling] = useState(false);
  const [localSetupMsg, setLocalSetupMsg] = useState('');
  const [localVoices, setLocalVoices] = useState<LocalTtsVoices | null>(null);
  const [localVoicesLoading, setLocalVoicesLoading] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneName, setCloneName] = useState('');
  const [cloneBusy, setCloneBusy] = useState(false);

  // Voice options for the active engine. Local voices are dynamic: the SDK's
  // preset voices plus the user's cloned profiles.
  const localVoiceOptions = useMemo(
    () =>
      localVoices
        ? [
            // Fine-tuned LoRA voices (slow engine — fine for short dubs).
            ...(localVoices.loras ?? []).map((p) => ({ id: `lora:${p.id}`, label: `✨ ${p.label}` })),
            // Bundled voices ship with the app — listed as built-ins, no 👤.
            ...localVoices.profiles
              .filter((p) => p.builtin)
              .map((p) => ({ id: `profile:${p.id}`, label: p.name })),
            ...localVoices.presets.map((p) => ({ id: `preset:${p.id}`, label: p.label })),
            ...localVoices.profiles
              .filter((p) => !p.builtin)
              .map((p) => ({ id: `profile:${p.id}`, label: `👤 ${p.name}` })),
          ]
        : [],
    [localVoices],
  );
  const voiceOptions = ttsProvider === 'local' ? localVoiceOptions : TTS_VOICES[ttsProvider];

  const refreshLocalVoices = async () => {
    setLocalVoicesLoading(true);
    try {
      setLocalVoices(await localTtsVoices());
    } catch (e) {
      toast.error({ title: t('editor.subtitleDub.localVoicesFailed'), message: String(e) });
    } finally {
      setLocalVoicesLoading(false);
    }
  };

  // Entering local mode: check the install, and if present fetch voices.
  // The first voices call also boots the synthesis worker (loads the model),
  // so localVoicesLoading doubles as the "engine starting…" indicator.
  useEffect(() => {
    if (engineChoice !== 'local') return;
    let cancelled = false;
    (async () => {
      const status = await localTtsStatus().catch(() => null);
      if (cancelled) return;
      setLocalStatus(status);
      if (!status?.installed || localVoices) return;
      setLocalVoicesLoading(true);
      try {
        const v = await localTtsVoices();
        if (!cancelled) setLocalVoices(v);
      } catch (e) {
        if (!cancelled)
          toast.error({ title: t('editor.subtitleDub.localVoicesFailed'), message: String(e) });
      } finally {
        if (!cancelled) setLocalVoicesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Refetch only on engine switch; voices refresh explicitly after mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineChoice]);

  // Keep the selected voice valid for the active engine's option list. For
  // the local engine, start from the user's default voice (set on the Voices
  // page) rather than whatever happens to be first.
  useEffect(() => {
    if (voiceOptions.length > 0 && !voiceOptions.some((o) => o.id === voice)) {
      const def = ttsProvider === 'local' ? getDefaultLocalVoice() : null;
      setVoice(def && voiceOptions.some((o) => o.id === def) ? def : voiceOptions[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceOptions]);

  const handleLocalInstall = async () => {
    setLocalInstalling(true);
    setLocalSetupMsg('');
    const unlisten = await onLocalTtsSetup((e) => setLocalSetupMsg(e.payload.message));
    try {
      const status = await localTtsInstall();
      setLocalStatus(status);
      if (status.installed) {
        toast.success({ title: t('editor.subtitleDub.localInstalled') });
        await refreshLocalVoices();
      }
    } catch (e) {
      toast.error({ title: t('editor.subtitleDub.localInstallFailed'), message: String(e) });
    } finally {
      unlisten();
      setLocalInstalling(false);
      setLocalSetupMsg('');
    }
  };

  const handleCloneVoice = async () => {
    const file = await open({
      multiple: false,
      filters: [
        { name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'aac', 'webm', 'mp4'] },
      ],
    });
    if (typeof file !== 'string') return;
    setCloneBusy(true);
    try {
      const profile = await localTtsAddVoice({
        name: cloneName.trim() || t('editor.subtitleDub.cloneDefaultName'),
        sourcePath: file,
      });
      // Show the new voice immediately — profiles live on disk, no need to
      // wait for the (possibly cold) synthesis worker to list them again.
      setLocalVoices((prev) =>
        prev
          ? { ...prev, profiles: [...prev.profiles, profile] }
          : { presets: [], profiles: [profile] },
      );
      setVoice(`profile:${profile.id}`);
      setCloneName('');
      setCloneOpen(false);
      toast.success({ title: t('editor.subtitleDub.cloneAdded', { name: profile.name }) });
    } catch (e) {
      toast.error({ title: t('editor.subtitleDub.cloneFailed'), message: String(e) });
    } finally {
      setCloneBusy(false);
    }
  };

  const handleDeleteVoice = async (id: string) => {
    try {
      await localTtsDeleteVoice(id);
      setLocalVoices((prev) =>
        prev ? { ...prev, profiles: prev.profiles.filter((p) => p.id !== id) } : prev,
      );
    } catch (e) {
      toast.error({ title: t('editor.subtitleDub.cloneFailed'), message: String(e) });
    }
  };
  // Voice sample playback: a plain <audio> element, kept in a ref so switching
  // voices can stop the previous sample instead of layering them.
  const [previewingVoice, setPreviewingVoice] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    return () => {
      previewAudioRef.current?.pause();
      previewAudioRef.current = null;
    };
  }, []);

  // Dragging/resizing a subtitle clip directly on the Preview is the primary
  // way to reposition it now. Elah fires 'clip:updated' on EVERY drag tick
  // (not just on mouse release), so we debounce: only once no further update
  // arrives for a short pause do we treat the drag as settled and ask whether
  // to apply that position to every other subtitle clip ON THE SAME TRACK —
  // original and translated subtitles are positioned independently, so a
  // drag on one must never carry over to the other.
  const [applyPrompt, setApplyPrompt] = useState<{
    transform: NonNullable<Clip['transform']>;
    trackId: string;
    others: { id: string; trackId: string }[];
  } | null>(null);
  const dragSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Applying the prompt itself calls updateClip on every other clip, which
  // fires 'clip:updated' right back at us — guard against re-opening the
  // prompt from our own writes, otherwise it loops forever.
  const applyingRef = useRef(false);
  // Last position seen per clip id. The prompt must only follow an actual move,
  // and 'clip:updated' carries no before-value, so we track it ourselves.
  const lastTransformRef = useRef<Map<string, { x: number; y: number; scale: number }>>(new Map());
  useEffect(() => {
    if (!engine) return;
    const onUpdated = (clip: Clip) => {
      if (applyingRef.current) return;
      if (clip.type !== 'text' || !isSubtitleTrack(clip.trackId)) return;
      const tf = clip.transform;
      if (!tf) return;

      // Only a real position change may prompt. Every style edit in the
      // properties panel also emits 'clip:updated' on these very clips, and
      // testing "transform exists" would fire the dialog on all of them.
      const prev = lastTransformRef.current.get(clip.id);
      const cur = { x: tf.x, y: tf.y, scale: tf.scale };
      lastTransformRef.current.set(clip.id, cur);
      // No baseline yet (first update after load/creation) is never a move.
      if (!prev) return;
      const EPS = 1e-4;
      const moved =
        Math.abs(prev.x - cur.x) > EPS ||
        Math.abs(prev.y - cur.y) > EPS ||
        Math.abs(prev.scale - cur.scale) > EPS;
      if (!moved) return;

      const trackId = clip.trackId;
      if (dragSettleTimer.current) clearTimeout(dragSettleTimer.current);
      dragSettleTimer.current = setTimeout(() => {
        const others = engine
          .getClipsOnTrack(trackId)
          .filter((c) => c.type === 'text' && c.id !== clip.id)
          .map((c) => ({ id: c.id, trackId }));
        if (others.length === 0) return;
        setApplyPrompt({ transform: tf, trackId, others });
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
    const { others, transform: tf } = applyPrompt;
    applyingRef.current = true;
    engine.batch(() => {
      for (const { id, trackId } of others) {
        // Position only. Propagating fontSize/color here used to overwrite every
        // caption's styling as a side effect of dragging one of them; bulk
        // styling is now an explicit action in the properties panel.
        engine.updateClip(id, trackId, { transform: { ...tf, rotation: 0 } });
      }
    }, 'Apply subtitle position to all');
    // engine.updateClip() emits 'clip:updated' synchronously, so the guard
    // can be released right after the batch call completes.
    applyingRef.current = false;
    // Those writes were suppressed by the guard above, so record the positions
    // we just set. Without this the siblings keep a stale baseline and the next
    // drag of any of them would look like a move from the old position.
    for (const { id } of others) {
      lastTransformRef.current.set(id, { x: tf.x, y: tf.y, scale: tf.scale });
    }
    setStyleX(tf.x);
    setStyleY(tf.y);
    setStyleScale(tf.scale);
    // The user has now chosen a position explicitly; stop deriving it.
    setStyleMoved(true);
    setApplyPrompt(null);
  };

  const hasOriginalOnTimeline = !!originalTrackId.current;
  const hasTranslatedOnTimeline = !!translatedTrackId.current;

  const ttsApiKey =
    ai.config.provider === 'openai' ? (ai.config.api_key ?? '') : (ai.config.api_key ?? '');
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
      toast.error({
        title: t('editor.subtitleDub.noVideo'),
        message: t('editor.subtitleDub.noVideoMsg'),
      });
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
      toast.success({
        title: t('editor.subtitleDub.subtitlesReady', { count: parsed.entries.length }),
      });
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
      toast.success({
        title: t('editor.subtitleDub.subtitlesReady', { count: parsed.entries.length }),
      });
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
      toast.error({
        title: t('editor.subtitleDub.needAI'),
        message: t('editor.subtitleDub.needAIMsg'),
      });
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
          extraInstructions: proofreadHint,
          onProgress: (done, total) =>
            setProgress(t('editor.subtitleDub.proofreading', { done, total })),
        },
      );
      setEntries((prev) => prev.map((e, i) => ({ ...e, text: corrected[i] ?? e.text })));
      toast.success({ title: t('editor.subtitleDub.proofreadDone') });
    } catch (e) {
      if (String(e).includes(TRANSLATE_CANCELLED))
        toast.info({ title: t('editor.subtitleDub.cancelled') });
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
      toast.error({
        title: t('editor.subtitleDub.needAI'),
        message: t('editor.subtitleDub.needAIMsg'),
      });
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
          extraInstructions: translateHint,
          onProgress: (done, total) =>
            setProgress(t('editor.subtitleDub.translating', { done, total })),
        },
      );
      setTranslatedEntries(entries.map((e, i) => ({ ...e, text: translated[i] ?? e.text })));
      toast.success({ title: t('editor.subtitleDub.translateDone') });
    } catch (e) {
      if (String(e).includes(TRANSLATE_CANCELLED))
        toast.info({ title: t('editor.subtitleDub.cancelled') });
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
    setTranslatedEntries((prev) =>
      prev ? prev.map((e) => (e.id === id ? { ...e, text } : e)) : prev,
    );

  /**
   * Intrinsic size of the video the captions belong to. Read from the asset
   * behind the first video clip on the timeline (that's what the preview is
   * showing); undefined when there is none, in which case the caller treats the
   * stage as the picture.
   */
  const videoContentSize = (): { width?: number; height?: number } | undefined => {
    if (!engine) return undefined;
    const project = engine.getProject();
    const assets = useMediaLibraryStore.getState().assets;
    for (const track of project.tracks) {
      if (track.kind !== 'video') continue;
      for (const c of project.clips[track.id] ?? []) {
        if (c.type !== 'video' || !c.assetId) continue;
        const asset = assets[c.assetId];
        if (asset?.width && asset?.height) return { width: asset.width, height: asset.height };
      }
    }
    return undefined;
  };

  /**
   * Re-fit captions already on the timeline when the aspect ratio changes.
   *
   * Switching 9:16 → 16:9 keeps every clip's absolute fontSize while the video
   * shrinks into a letterbox, so captions sized for the old frame overflow the
   * new picture. Rescale by the change in picture width and re-seat them above
   * the picture's bottom edge.
   *
   * Only fires on an actual stage change (not on mount) and skips clips the user
   * has repositioned, so it never fights a manual placement.
   */
  const stage = useTracksStore((s) => s.stage);
  const lastStageRef = useRef<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!engine) return;
    const prev = lastStageRef.current;
    lastStageRef.current = stage;
    if (!prev || (prev.width === stage.width && prev.height === stage.height)) return;

    const video = videoContentSize();
    const before = fitCaptionToVideo(prev, video);
    const after = fitCaptionToVideo(stage, video);
    const ratio = before.fontSize > 0 ? after.fontSize / before.fontSize : 1;
    if (ratio === 1 && before.y === after.y) return;

    const trackIds = engine
      .getProject()
      .tracks.filter((tr) => tr.kind === 'elements' && SUBTITLE_TRACK_NAMES.includes(tr.name))
      .map((tr) => tr.id);
    if (trackIds.length === 0) return;

    applyingRef.current = true;
    engine.batch(() => {
      for (const trackId of trackIds) {
        for (const c of engine.getClipsOnTrack(trackId)) {
          if (c.type !== 'text') continue;
          const tf = c.transform;
          engine.updateClip(c.id, trackId, {
            fontSize: Math.max(12, Math.round((c.fontSize ?? after.fontSize) * ratio)),
            ...(c.backgroundPadding !== undefined
              ? { backgroundPadding: Math.max(0, Math.round(c.backgroundPadding * ratio)) }
              : {}),
            // Re-seat vertically unless the user moved this caption themselves.
            ...(styleMoved
              ? {}
              : {
                  transform: {
                    x: tf?.x ?? 0.5,
                    y: after.y,
                    scale: tf?.scale ?? 1,
                    rotation: tf?.rotation ?? 0,
                    anchor: tf?.anchor ?? { x: 0.5, y: 0.5 },
                  },
                }),
          });
        }
      }
    }, 'Refit subtitles to aspect ratio');
    applyingRef.current = false;
    // videoContentSize/styleMoved are read fresh on each stage change; adding
    // them as deps would re-run this on unrelated renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, stage]);

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
    // Size and place captions against the video picture, not the stage: a clip
    // whose aspect differs from the stage is letterboxed, and text laid out
    // against the stage would spill over the black bars (see fitCaptionToVideo).
    const fit = fitCaptionToVideo(engine.getProject().stage, videoContentSize());

    let added = 0;
    engine.batch(() => {
      const sorted = [...source].sort((a, b) => a.startTime - b.startTime);
      for (let i = 0; i < sorted.length; i++) {
        const e = sorted[i];
        const startF = msToFramePos(e.startTime);
        // Cap the end at the next cue's start (minus 1 frame) to avoid overlap.
        const nextStartF = i + 1 < sorted.length ? msToFramePos(sorted[i + 1].startTime) : Infinity;
        let endF = msToFramePos(e.endTime);
        if (endF >= nextStartF) endF = nextStartF - 1;
        const durationFrames = Math.max(endF - startF, 1);
        if (durationFrames < 1) continue;
        try {
          engine.addClip({
            type: 'text',
            trackId: trackId as string,
            startFrame: startF,
            durationFrames,
            // Creation-time look. The style controls themselves live in the
            // properties panel (select a caption), so this is just the starting
            // point — including "Apply to all subtitles" there to restyle a set.
            text: {
              content: e.text,
              textAlign: 'center',
              fontSize: fit.fontSize,
              color: DEFAULT_SUBTITLE_STYLE.color,
              fontFamily: DEFAULT_SUBTITLE_STYLE.fontFamily,
              fontWeight: DEFAULT_SUBTITLE_STYLE.fontWeight,
              ...(DEFAULT_SUBTITLE_STYLE.backgroundColor
                ? { backgroundColor: DEFAULT_SUBTITLE_STYLE.backgroundColor }
                : {}),
            },
            // Sit just above the bottom of the video picture. Once the user has
            // dragged a caption and applied that position to all, styleY holds
            // their choice and wins over the computed placement.
            transform: {
              x: styleX,
              y: styleMoved ? styleY : fit.y,
              scale: styleScale,
              rotation: 0,
              anchor: { x: 0.5, y: 0.5 },
            },
          });
          added += 1;
        } catch {
          // Skip clips that still can't be placed (e.g. zero-length cues).
        }
      }
    }, 'Add subtitles');
    toast.success({ title: t('editor.subtitleDub.subtitlesAdded', { count: added }) });
  };

  // ── 4. Voiceover: TTS per line, place on a dedicated audio track (keep original).
  // Voice the translated text when available (the point of dubbing is to speak
  // the target language), falling back to the original if not yet translated.
  const dubSource = translatedEntries ?? entries;

  /**
   * Speak a short sample in the selected voice.
   *
   * Dubbing a whole transcript is slow and costs API credits per line, so being
   * able to hear a voice first is the difference between one run and several.
   * Samples the user's own first subtitle line when there is one — hearing the
   * actual script matters more than a canned sentence — and falls back to a
   * fixed phrase otherwise.
   */
  const handlePreviewVoice = async () => {
    if (ttsProvider === 'local') {
      if (!localStatus?.installed) {
        toast.error({ title: t('editor.subtitleDub.localNotReady') });
        return;
      }
    } else if (!ttsApiKey) {
      toast.error({
        title: t('editor.subtitleDub.needAI'),
        message: t('editor.subtitleDub.needAIMsg'),
      });
      return;
    }
    // Stop a sample that's already playing so clicking around doesn't overlap.
    previewAudioRef.current?.pause();
    previewAudioRef.current = null;

    setPreviewingVoice(true);
    try {
      const sample =
        dubSource
          .find((e) => e.text.trim())
          ?.text.trim()
          .slice(0, 180) || t('editor.subtitleDub.previewSampleText');
      const res = await ttsSynthesize({
        provider: ttsProvider,
        voice,
        text: sample,
        apiKey: ttsApiKey,
        model: ttsModel,
      });
      const src = await toAssetUrl(res.path);
      const audio = new Audio(src);
      previewAudioRef.current = audio;
      audio.onended = () => setPreviewingVoice(false);
      audio.onerror = () => setPreviewingVoice(false);
      await audio.play();
    } catch (e) {
      toast.error({ title: t('editor.subtitleDub.previewFailed'), message: String(e) });
      setPreviewingVoice(false);
    }
  };
  const handleDub = async () => {
    if (!engine || dubSource.length === 0) return;
    if (ttsProvider === 'local') {
      if (!localStatus?.installed) {
        toast.error({ title: t('editor.subtitleDub.localNotReady') });
        return;
      }
    } else if (!ttsApiKey) {
      toast.error({
        title: t('editor.subtitleDub.needAI'),
        message: t('editor.subtitleDub.needAIMsg'),
      });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy('dub');
    // Dedicated voiceover track so the original audio stays untouched. Reuse it
    // across runs (e.g. after editing subtitles or switching voice) instead of
    // stacking a new "Voiceover" track each time.
    //
    // The ref alone is not enough to find it: it's only ever set by this
    // function, so a remount or a project reopened from a draft starts at null
    // while the track is still sitting on the timeline — which produced two
    // "Voiceover" tracks playing over each other. Fall back to the track's
    // stable name, exactly as isSubtitleTrack does for the caption tracks.
    let trackId = dubTrackId.current;
    if (!trackId || !engine.getProject().tracks.some((tr) => tr.id === trackId)) {
      trackId =
        engine
          .getProject()
          .tracks.find((tr) => tr.kind === 'audio' && tr.name === VOICEOVER_TRACK_NAME)?.id ?? null;
    }
    if (trackId) {
      for (const c of engine.getClipsOnTrack(trackId)) {
        if (c.type === 'audio') engine.removeClip(c.id, trackId);
      }
      dubTrackId.current = trackId;
    } else {
      const dubTrack = engine.addTrack('audio', { name: VOICEOVER_TRACK_NAME });
      trackId = dubTrack.id;
      dubTrackId.current = trackId;
    }
    const sorted = [...dubSource].sort((a, b) => a.startTime - b.startTime);
    // Each line is an independent API round-trip placed at its own cue time, so
    // synthesize several at once. Sequential dubbing made a 100-line video take
    // 100 back-to-back round-trips; a small pool keeps ordering irrelevant
    // (clips are positioned by cue, not by arrival) while staying well under
    // provider rate limits.
    const DUB_CONCURRENCY = 4;
    const synthesizeLine = async (i: number) => {
      const e = sorted[i];
      if (!e.text.trim()) return;
      // Speak-fit window = this cue plus the silence before the next one.
      // Sizing to the cue alone (endTime - startTime) throws away the pause
      // that follows it, forcing needless speed-up on lines that had room to
      // breathe; the ceiling is where the next line must start talking.
      const nextStart = i + 1 < sorted.length ? sorted[i + 1].startTime : e.endTime;
      const windowMs = Math.max(nextStart - e.startTime, e.endTime - e.startTime);
      const res = await ttsSynthesize({
        provider: ttsProvider,
        voice,
        text: e.text,
        apiKey: ttsApiKey,
        model: ttsModel,
        windowMs,
        index: i,
      });
      const src = await toAssetUrl(res.path);
      // Every line starts at its own cue time — never nudged later to dodge
      // the previous clip. Chaining starts off "the next free frame" made each
      // overlong line push all the following ones back, and that lateness
      // accumulated, so by mid-video the voice was a whole cue behind the
      // subtitles. A line that still overruns is trimmed below instead, which
      // costs a clipped tail on that one line and keeps everything after it
      // in sync.
      const startF = msToFramePos(e.startTime);
      let durF = msToFrame(res.duration_ms);
      // Elah rejects overlapping clips on a track, so cap the clip at the next
      // cue's start. windowMs above already asked TTS to fit inside this span;
      // this only bites when even MAX_SPEED wasn't enough.
      if (i + 1 < sorted.length) {
        const nextStartF = msToFramePos(sorted[i + 1].startTime);
        if (startF + durF > nextStartF) durF = Math.max(nextStartF - startF, 1);
      }
      try {
        engine.addClip({ type: 'audio', trackId, startFrame: startF, durationFrames: durF, src });
      } catch {
        // Skip a clip that still can't be placed rather than aborting the run.
      }
    };
    try {
      let nextIndex = 0;
      let completed = 0;
      let firstError: unknown = null;
      const worker = async () => {
        while (!controller.signal.aborted && firstError === null) {
          const i = nextIndex++;
          if (i >= sorted.length) return;
          try {
            await synthesizeLine(i);
          } catch (err) {
            // Remember the first failure and let every worker drain; the lines
            // already synthesized stay on the timeline.
            firstError = firstError ?? err;
            return;
          }
          completed += 1;
          setProgress(t('editor.subtitleDub.dubbing', { done: completed, total: sorted.length }));
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(DUB_CONCURRENCY, sorted.length) }, () => worker()),
      );
      if (firstError !== null) throw firstError;
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

  // shrink-0: the panel is a fixed-width flex column that scrolls as a whole,
  // so no control should be squeezed to fit — it should push the panel taller
  // and let the panel scroll instead.
  const btn =
    'w-full shrink-0 inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm border border-ed-border text-ed-text hover:bg-ed-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const sectionTitle = 'text-[11px] font-semibold text-ed-text-muted uppercase tracking-wide mt-1';

  return (
    <div
      className="flex flex-col gap-3 p-3 overflow-y-auto text-ed-text"
      style={{ height: '100%' }}
    >
      <div className="text-sm font-semibold flex items-center gap-2">
        <Captions className="w-4 h-4" /> {t('editor.subtitleDub.title')}
      </div>

      {/* 1. Source subtitles */}
      <div className={sectionTitle}>{t('editor.subtitleDub.sourceSection')}</div>
      <button type="button" className={btn} onClick={handleTranscribe} disabled={!!busy}>
        {busy === 'transcribe' ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Mic className="w-4 h-4" />
        )}
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
      <AIPromptHintField
        value={proofreadHint}
        onChange={setProofreadHint}
        disabled={!!busy}
        placeholder={t('editor.subtitleDub.proofreadHintPlaceholder')}
        className="shrink-0"
        textareaClassName="border-ed-border bg-ed-elevated text-ed-text"
      />
      <button
        type="button"
        className={btn}
        onClick={handleProofread}
        disabled={!!busy || entries.length === 0}
      >
        {busy === 'proofread' ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <SpellCheck className="w-4 h-4" />
        )}
        {t('editor.subtitleDub.proofread')}
      </button>
      <div className="text-[11px] text-ed-text-muted -mt-1">
        {t('editor.subtitleDub.proofreadHint')}
      </div>
      <button
        type="button"
        className={btn}
        onClick={() => handleAddSubtitles(entries, originalTrackId, ORIGINAL_TRACK_NAME)}
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
      <AIPromptHintField
        value={translateHint}
        onChange={setTranslateHint}
        disabled={!!busy}
        placeholder={t('editor.subtitleDub.translateHintPlaceholder')}
        className="shrink-0"
        textareaClassName="border-ed-border bg-ed-elevated text-ed-text"
      />
      <button
        type="button"
        className={btn}
        onClick={handleTranslate}
        disabled={!!busy || entries.length === 0}
      >
        {busy === 'translate' ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Languages className="w-4 h-4" />
        )}
        {t('editor.subtitleDub.translate')}
      </button>
      {translatedEntries && (
        <SubtitleEntryList
          entries={translatedEntries}
          onChangeText={updateTranslatedEntryText}
          disabled={!!busy}
        />
      )}
      <button
        type="button"
        className={btn}
        onClick={() =>
          translatedEntries &&
          handleAddSubtitles(translatedEntries, translatedTrackId, TRANSLATED_TRACK_NAME)
        }
        disabled={!!busy || !translatedEntries || translatedEntries.length === 0}
      >
        <Wand2 className="w-4 h-4" />
        {hasTranslatedOnTimeline
          ? t('editor.subtitleDub.updateTimelineTranslated')
          : t('editor.subtitleDub.addToTimelineTranslated')}
      </button>

      {/* Positioning lives in the properties panel (select a caption on the
          timeline), but the drag gesture has no other discoverability. */}
      <div className="text-[11px] text-ed-text-muted -mt-1">
        {t('editor.subtitleDub.dragToPositionHint')}
      </div>

      {/* 4. Voiceover */}
      <div className={sectionTitle}>{t('editor.subtitleDub.dubSection')}</div>
      <div className="flex flex-col gap-1 text-xs text-ed-text-muted">
        {t('editor.subtitleDub.engine')}
        <Select
          value={engineChoice}
          onValueChange={(v) => setEngineChoice(v as 'cloud' | 'local')}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="cloud">
              {t('editor.subtitleDub.engineCloud', {
                provider: cloudProvider === 'openai' ? 'OpenAI' : 'Gemini',
              })}
            </SelectItem>
            <SelectItem value="local">{t('editor.subtitleDub.engineLocal')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Local engine: one-time install (uv env + voice models). */}
      {engineChoice === 'local' && localStatus && !localStatus.installed && (
        <>
          <div className="text-[11px] text-ed-text-muted">
            {t('editor.subtitleDub.localInstallHint')}
          </div>
          <button
            type="button"
            className={btn}
            onClick={handleLocalInstall}
            disabled={localInstalling || !!busy}
          >
            {localInstalling ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            {localInstalling
              ? t('editor.subtitleDub.localInstalling')
              : t('editor.subtitleDub.localInstall')}
          </button>
          {localInstalling && localSetupMsg && (
            <div className="text-[11px] text-ed-text-muted truncate">{localSetupMsg}</div>
          )}
        </>
      )}

      {(engineChoice === 'cloud' || localStatus?.installed) && (
        <div className="flex flex-col gap-1 text-xs text-ed-text-muted">
          {t('editor.subtitleDub.voice')}
          <Select
            value={voice}
            onValueChange={(v) => {
              // Cut off a sample of the old voice, or it keeps playing after the
              // selection has already moved on.
              previewAudioRef.current?.pause();
              previewAudioRef.current = null;
              setPreviewingVoice(false);
              setVoice(v);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {voiceOptions.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {ttsProvider === 'local' && localVoicesLoading && (
            <div className="text-[11px] text-ed-text-muted">
              {t('editor.subtitleDub.localVoicesLoading')}
            </div>
          )}
        </div>
      )}

      {/* Voice cloning: register a 3-10s reference recording as a reusable voice. */}
      {engineChoice === 'local' && localStatus?.installed && (
        <>
          {!cloneOpen ? (
            <button
              type="button"
              className={btn}
              onClick={() => setCloneOpen(true)}
              disabled={!!busy || cloneBusy}
            >
              <UserPlus className="w-4 h-4" /> {t('editor.subtitleDub.cloneVoice')}
            </button>
          ) : (
            <div className="flex flex-col gap-1.5 shrink-0 rounded-md border border-ed-border p-2">
              <div className="text-[11px] text-ed-text-muted">
                {t('editor.subtitleDub.cloneVoiceHint')}
              </div>
              <input
                type="text"
                value={cloneName}
                disabled={cloneBusy}
                onChange={(e) => setCloneName(e.target.value)}
                placeholder={t('editor.subtitleDub.cloneVoiceName')}
                className="w-full bg-ed-elevated text-xs text-ed-text border border-ed-border rounded px-2 py-1.5 focus:border-ed-accent focus:outline-none"
              />
              <button type="button" className={btn} onClick={handleCloneVoice} disabled={cloneBusy}>
                {cloneBusy ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <UserPlus className="w-4 h-4" />
                )}
                {t('editor.subtitleDub.cloneVoicePick')}
              </button>
              <button
                type="button"
                className="text-[11px] underline text-ed-text-muted self-start"
                onClick={() => setCloneOpen(false)}
                disabled={cloneBusy}
              >
                {t('editor.subtitleDub.cancel')}
              </button>
            </div>
          )}
          {localVoices && localVoices.profiles.some((p) => !p.builtin) && (
            <div className="flex flex-col gap-1 shrink-0">
              {localVoices.profiles
                .filter((p) => !p.builtin)
                .map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-2 text-xs text-ed-text-muted px-1"
                >
                  <span className="truncate">👤 {p.name}</span>
                  <button
                    type="button"
                    title={t('editor.subtitleDub.deleteVoice')}
                    onClick={() => handleDeleteVoice(p.id)}
                    disabled={!!busy || cloneBusy}
                    className="shrink-0 hover:text-ed-text transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {/* Voice profiles are app-level assets; full management (preview every
          voice, uninstall the engine) lives on the dedicated Voices page. */}
      {engineChoice === 'local' && (
        <button
          type="button"
          className="text-[11px] underline text-ed-text-muted self-start -mt-1"
          onClick={() =>
            window.dispatchEvent(new CustomEvent('youwee:navigate', { detail: { page: 'voices' } }))
          }
        >
          {t('editor.subtitleDub.manageVoices')}
        </button>
      )}

      {/* Hearing a voice before dubbing the whole transcript: one API call here
          instead of discovering the wrong voice after N lines have been spent. */}
      <button
        type="button"
        className={btn}
        onClick={handlePreviewVoice}
        disabled={!!busy || previewingVoice}
      >
        {previewingVoice ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Volume2 className="w-4 h-4" />
        )}
        {previewingVoice
          ? t('editor.subtitleDub.previewing')
          : t('editor.subtitleDub.previewVoice')}
      </button>
      <button
        type="button"
        className={btn}
        onClick={handleDub}
        disabled={!!busy || dubSource.length === 0}
      >
        {busy === 'dub' ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Music className="w-4 h-4" />
        )}
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
            <AlertDialogDescription>
              {t('editor.subtitleDub.applyPositionPromptDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('editor.subtitleDub.justThisLine')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmApplyToAll}>
              {t('editor.subtitleDub.applyToAll')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
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
    // shrink-0 is load-bearing: this list sits in the panel's flex column, and
    // without it flexbox shrinks the list far below max-h-56 (down to a single
    // clipped row) whenever the buttons above and below fill the column. The
    // panel itself scrolls, so the list never needs to give up height.
    <div
      ref={scrollRef}
      className="flex flex-col gap-1.5 max-h-56 shrink-0 overflow-y-auto rounded-md border border-ed-border p-2 bg-ed-bg"
    >
      {entries.map((e) => (
        <div key={e.id} className="flex gap-2 items-center">
          <span className="font-mono text-[10px] text-ed-text-muted shrink-0 whitespace-nowrap">
            {formatTimecode(e.startTime)}
          </span>
          <input
            type="text"
            value={e.text}
            disabled={disabled}
            onChange={(ev) => onChangeText(e.id, ev.target.value)}
            className="flex-1 min-w-0 bg-transparent text-xs text-ed-text border border-transparent rounded px-1.5 py-1 hover:border-ed-border focus:border-ed-accent focus:outline-none disabled:opacity-60"
          />
        </div>
      ))}
    </div>
  );
}
