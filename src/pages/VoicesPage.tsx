import { open, save } from '@tauri-apps/plugin-dialog';
import { copyFile } from '@tauri-apps/plugin-fs';
import {
  AudioLines,
  Check,
  Download,
  FolderOpen,
  Loader2,
  Mic,
  Play,
  RefreshCw,
  Save,
  Settings2,
  Square,
  Star,
  Trash2,
  UserPlus,
  Volume2,
  Wallet,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ThemePicker } from '@/components/settings/ThemePicker';
import { EmptyStateIllustration } from '@/components/shared/EmptyStateIllustration';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import {
  getDefaultLocalVoice,
  localTtsAddVoice,
  localTtsDeleteGeneration,
  localTtsDeleteVoice,
  localTtsEngineConfig,
  localTtsGenerations,
  localTtsInstall,
  localTtsRecordGeneration,
  localTtsSample,
  localTtsSetEngineConfig,
  localTtsStatus,
  localTtsUninstall,
  localTtsUpdate,
  localTtsVersion,
  localTtsVoices,
  localTtsWarm,
  onLocalTtsSetup,
  revealOutputInFolder,
  setDefaultLocalVoice,
  ttsSynthesize,
  type LocalTtsGeneration,
  type LocalTtsStatus,
  type LocalTtsVersion,
  type LocalTtsVoices,
} from '@/contexts/editor/editor-client';
import { toAssetUrl } from '@/lib/asset-access';

/** Install pipeline stages, in execution order, as emitted by the backend. */
const INSTALL_STAGES = ['download-uv', 'python', 'deps', 'models'] as const;

/**
 * Top-level page for the local (VieNeu) voice engine: a text-to-speech studio
 * on the left, engine/voice management on the right. Voices registered here
 * are app-level assets: the editor's voiceover panel lists them for any
 * project.
 */
export function VoicesPage() {
  const { t } = useTranslation('pages');
  const toast = useToast();

  const [status, setStatus] = useState<LocalTtsStatus | null>(null);
  const [voices, setVoices] = useState<LocalTtsVoices | null>(null);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  // Latest setup event: which stage the install is in, stage-local percent
  // (-1 = indeterminate) and the most recent tool output line.
  const [setup, setSetup] = useState<{ stage: string; percent: number; message: string } | null>(
    null,
  );
  const [uninstalling, setUninstalling] = useState(false);
  const [version, setVersion] = useState<LocalTtsVersion | null>(null);
  // 'int8' (fast) vs 'fp32' (closer voice match, ~15% slower) — same 48kHz model.
  const [precision, setPrecision] = useState('int8');
  const [switchingPrecision, setSwitchingPrecision] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [cloneName, setCloneName] = useState('');
  const [cloneBusy, setCloneBusy] = useState(false);
  // Clone pipeline stage: converting the reference audio, then running a test
  // synthesis with it (the slow part — may boot the engine).
  const [cloneStage, setCloneStage] = useState<'' | 'convert' | 'analyze'>('');
  // Which voice id a preview is playing/synthesizing for ('' = none).
  const [previewing, setPreviewing] = useState('');
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  // Preview text is fixed, so a voice's sample never changes within a session:
  // cache voice id -> playable url and replay instantly instead of paying for
  // a fresh synthesis (plus engine start-up) on every click.
  const previewCacheRef = useRef<Map<string, string>>(new Map());

  // ── Text-to-speech studio: type text, pick a voice, get a wav ────────────
  const [ttsText, setTtsText] = useState('');
  const [ttsVoiceId, setTtsVoiceId] = useState('');
  const [ttsBusy, setTtsBusy] = useState(false);
  const [ttsResult, setTtsResult] = useState<{
    path: string;
    url: string;
    durationMs: number;
  } | null>(null);
  // Persisted history of studio-generated audios, newest first.
  const [generations, setGenerations] = useState<LocalTtsGeneration[]>([]);
  const [playingGen, setPlayingGen] = useState('');

  // Bundled profiles read as built-in voices; only user-cloned ones live in
  // the "cloned" section.
  const builtinProfiles = useMemo(
    () => voices?.profiles.filter((p) => p.builtin) ?? [],
    [voices],
  );
  const clonedProfiles = useMemo(
    () => voices?.profiles.filter((p) => !p.builtin) ?? [],
    [voices],
  );

  /** Selectable voices for the studio: built-ins first, then cloned. */
  const voiceOptions = useMemo(
    () =>
      voices
        ? [
            ...(voices.loras ?? []).map((p) => ({ id: `lora:${p.id}`, label: p.label })),
            ...builtinProfiles.map((p) => ({ id: `profile:${p.id}`, label: p.name })),
            ...voices.presets.map((p) => ({ id: `preset:${p.id}`, label: p.label })),
            ...clonedProfiles.map((p) => ({ id: `profile:${p.id}`, label: `👤 ${p.name}` })),
          ]
        : [],
    [voices, builtinProfiles, clonedProfiles],
  );

  // The user's preferred starting voice, changeable via the ★ buttons.
  const [defaultVoice, setDefaultVoice] = useState<string | null>(() => getDefaultLocalVoice());

  // Keep the studio's voice valid as the list loads/changes; prefer the
  // default voice when picking one.
  useEffect(() => {
    if (voiceOptions.length > 0 && !voiceOptions.some((o) => o.id === ttsVoiceId)) {
      const preferred =
        defaultVoice && voiceOptions.some((o) => o.id === defaultVoice)
          ? defaultVoice
          : voiceOptions[0].id;
      setTtsVoiceId(preferred);
    }
  }, [voiceOptions, ttsVoiceId, defaultVoice]);

  const handleSetDefault = useCallback(
    (voiceId: string, label: string) => {
      setDefaultLocalVoice(voiceId);
      setDefaultVoice(voiceId);
      toast.success({ title: t('voices.defaultSet', { name: label }) });
    },
    [t, toast],
  );

  useEffect(() => {
    return () => {
      previewAudioRef.current?.pause();
      previewAudioRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await localTtsStatus().catch(() => null);
      if (cancelled) return;
      setStatus(s);
      if (s?.installed) {
        // History reads a JSON file — instant, independent of the engine.
        localTtsGenerations()
          .then((g) => !cancelled && setGenerations(g))
          .catch(() => {});
        // Local version read only — no network unless the user asks.
        localTtsVersion(false)
          .then((v) => !cancelled && setVersion(v))
          .catch(() => {});
        localTtsEngineConfig()
          .then((c) => !cancelled && setPrecision(c.precision))
          .catch(() => {});
        // Boot the engine now so the first preview click plays immediately
        // instead of waiting on model loading.
        localTtsWarm().catch(() => {});
        setVoicesLoading(true);
        try {
          const v = await localTtsVoices();
          if (!cancelled) setVoices(v);
        } catch {
          // Engine may still be booting; the user can retry via the UI.
        } finally {
          if (!cancelled) setVoicesLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    setSetup(null);
    const unlisten = await onLocalTtsSetup((e) => setSetup(e.payload));
    try {
      const s = await localTtsInstall();
      setStatus(s);
      if (s.installed) {
        toast.success({ title: t('voices.installDone') });
        setVoicesLoading(true);
        try {
          setVoices(await localTtsVoices());
        } finally {
          setVoicesLoading(false);
        }
      }
    } catch (e) {
      toast.error({ title: t('voices.installFailed'), message: String(e) });
    } finally {
      unlisten();
      setInstalling(false);
      setSetup(null);
    }
  }, [t, toast]);

  const handlePrecisionChange = useCallback(
    async (next: string) => {
      if (next === precision) return;
      setSwitchingPrecision(true);
      try {
        const cfg = await localTtsSetEngineConfig(next);
        setPrecision(cfg.precision);
        // The engine reloads with the new precision, so cached samples (and
        // any audio already playing) no longer match what it now produces.
        previewAudioRef.current?.pause();
        previewAudioRef.current = null;
        setPreviewing('');
        previewCacheRef.current.clear();
        // Re-warm in the background so the next preview is still instant.
        localTtsWarm().catch(() => {});
        toast.success({ title: t('voices.precisionChanged') });
      } catch (e) {
        toast.error({ title: t('voices.precisionFailed'), message: String(e) });
      } finally {
        setSwitchingPrecision(false);
      }
    },
    [precision, t, toast],
  );

  const handleCheckUpdate = useCallback(async () => {
    setCheckingUpdate(true);
    try {
      const v = await localTtsVersion(true);
      setVersion(v);
      toast.info({
        title: v.update_available
          ? t('voices.updateAvailable', { version: v.latest })
          : t('voices.upToDate'),
      });
    } catch (e) {
      toast.error({ title: t('voices.checkFailed'), message: String(e) });
    } finally {
      setCheckingUpdate(false);
    }
  }, [t, toast]);

  const handleUpdate = useCallback(async () => {
    if (!window.confirm(t('voices.updateConfirm'))) return;
    setUpdating(true);
    const unlisten = await onLocalTtsSetup((e) => setSetup(e.payload));
    try {
      const v = await localTtsUpdate(version?.latest ?? undefined);
      setVersion(v);
      // The worker was stopped for the upgrade; voices reload on next use and
      // cached samples may no longer reflect the new engine.
      setVoices(null);
      previewCacheRef.current.clear();
      toast.success({ title: t('voices.updateDone', { version: v.installed }) });
      setVoicesLoading(true);
      try {
        setVoices(await localTtsVoices());
      } finally {
        setVoicesLoading(false);
      }
    } catch (e) {
      toast.error({ title: t('voices.updateFailed'), message: String(e) });
    } finally {
      unlisten();
      setUpdating(false);
      setSetup(null);
    }
  }, [version, t, toast]);

  const handleUninstall = useCallback(async () => {
    if (!window.confirm(t('voices.uninstallConfirm'))) return;
    setUninstalling(true);
    try {
      const s = await localTtsUninstall();
      setStatus(s);
      setVoices(null);
      setTtsResult(null);
      toast.success({ title: t('voices.uninstallDone') });
    } catch (e) {
      toast.error({ title: t('voices.uninstallFailed'), message: String(e) });
    } finally {
      setUninstalling(false);
    }
  }, [t, toast]);

  const handleClone = useCallback(async () => {
    const file = await open({
      multiple: false,
      filters: [
        { name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'aac', 'webm', 'mp4'] },
      ],
    });
    if (typeof file !== 'string') return;
    setCloneBusy(true);
    setCloneStage('convert');
    try {
      const profile = await localTtsAddVoice({
        name: cloneName.trim() || t('voices.defaultName'),
        sourcePath: file,
      });
      // Show the new voice immediately — profiles live on disk, no need to
      // wait for the (possibly cold) synthesis worker to list them again.
      setVoices((prev) =>
        prev
          ? { ...prev, profiles: [...prev.profiles, profile] }
          : { presets: [], profiles: [profile] },
      );
      setCloneName('');

      // Prove the clone works right now: synthesize a short sample with the
      // new reference and play it. This is where a bad recording (noise, too
      // short, music) surfaces — far better here than mid-dub later.
      setCloneStage('analyze');
      try {
        const res = await ttsSynthesize({
          provider: 'local',
          voice: `profile:${profile.id}`,
          text: t('voices.previewText'),
          apiKey: '',
        });
        previewAudioRef.current?.pause();
        const src = await toAssetUrl(res.path);
        const audio = new Audio(src);
        previewAudioRef.current = audio;
        setPreviewing(`profile:${profile.id}`);
        audio.onended = () => setPreviewing('');
        audio.onerror = () => setPreviewing('');
        await audio.play();
        toast.success({ title: t('voices.cloneReady', { name: profile.name }) });
      } catch (e) {
        // The profile stays (the failure may be transient); the user can
        // retry with the ▶ button or delete it.
        toast.error({ title: t('voices.cloneTestFailed'), message: String(e) });
      }
    } catch (e) {
      toast.error({ title: t('voices.cloneFailed'), message: String(e) });
    } finally {
      setCloneBusy(false);
      setCloneStage('');
    }
  }, [cloneName, t, toast]);

  const handleDelete = useCallback(
    async (id: string, name: string) => {
      if (!window.confirm(t('voices.deleteConfirm', { name }))) return;
      try {
        await localTtsDeleteVoice(id);
        previewCacheRef.current.delete(`profile:${id}`);
        setVoices((prev) =>
          prev ? { ...prev, profiles: prev.profiles.filter((p) => p.id !== id) } : prev,
        );
      } catch (e) {
        toast.error({ title: t('voices.deleteFailed'), message: String(e) });
      }
    },
    [t, toast],
  );

  const handlePreview = useCallback(
    async (voiceId: string) => {
      // Toggling the playing voice off is the intuitive second click.
      if (previewing === voiceId) {
        previewAudioRef.current?.pause();
        previewAudioRef.current = null;
        setPreviewing('');
        return;
      }
      previewAudioRef.current?.pause();
      previewAudioRef.current = null;
      setPreviewing(voiceId);
      try {
        let src = previewCacheRef.current.get(voiceId);
        if (!src) {
          // Backend serves a disk-cached sample when it has one, so this is
          // instant on every run after the first.
          const path = await localTtsSample(voiceId, t('voices.previewText'));
          src = await toAssetUrl(path);
          previewCacheRef.current.set(voiceId, src);
        }
        const audio = new Audio(src);
        previewAudioRef.current = audio;
        audio.onended = () => setPreviewing('');
        audio.onerror = () => setPreviewing('');
        await audio.play();
      } catch (e) {
        toast.error({ title: t('voices.previewFailed'), message: String(e) });
        setPreviewing('');
      }
    },
    [previewing, t, toast],
  );

  const handleTtsGenerate = useCallback(async () => {
    const text = ttsText.trim();
    if (!text || !ttsVoiceId) return;
    setTtsBusy(true);
    try {
      const res = await ttsSynthesize({
        provider: 'local',
        voice: ttsVoiceId,
        text,
        apiKey: '',
      });
      const url = await toAssetUrl(res.path);
      setTtsResult({ path: res.path, url, durationMs: res.duration_ms });
      // Record in the persistent history (best-effort — the audio itself is
      // already on disk and playable even if the log write fails).
      const voiceLabel = voiceOptions.find((o) => o.id === ttsVoiceId)?.label ?? ttsVoiceId;
      try {
        const entry = await localTtsRecordGeneration({
          text,
          voiceLabel,
          path: res.path,
          durationMs: res.duration_ms,
        });
        setGenerations((prev) => [entry, ...prev]);
      } catch {
        // History is a convenience; never fail the generation over it.
      }
    } catch (e) {
      toast.error({ title: t('voices.ttsFailed'), message: String(e) });
    } finally {
      setTtsBusy(false);
    }
  }, [ttsText, ttsVoiceId, voiceOptions, t, toast]);

  /** Save any generated wav to a user-chosen location. */
  const saveWavAs = useCallback(
    async (srcPath: string) => {
      const dest = await save({
        defaultPath: 'giong-doc.wav',
        filters: [{ name: 'WAV', extensions: ['wav'] }],
      });
      if (!dest) return;
      try {
        await copyFile(srcPath, dest);
        toast.success({ title: t('voices.ttsSaved') });
      } catch (e) {
        toast.error({ title: t('voices.ttsSaveFailed'), message: String(e) });
      }
    },
    [t, toast],
  );

  /** Toggle playback of a history entry (one audio at a time, shared ref). */
  const handlePlayGeneration = useCallback(
    async (gen: LocalTtsGeneration) => {
      if (playingGen === gen.id) {
        previewAudioRef.current?.pause();
        previewAudioRef.current = null;
        setPlayingGen('');
        return;
      }
      previewAudioRef.current?.pause();
      previewAudioRef.current = null;
      setPreviewing('');
      setPlayingGen(gen.id);
      try {
        const src = await toAssetUrl(gen.path);
        const audio = new Audio(src);
        previewAudioRef.current = audio;
        audio.onended = () => setPlayingGen('');
        audio.onerror = () => setPlayingGen('');
        await audio.play();
      } catch (e) {
        toast.error({ title: t('voices.previewFailed'), message: String(e) });
        setPlayingGen('');
      }
    },
    [playingGen, t, toast],
  );

  const handleDeleteGeneration = useCallback(
    async (id: string) => {
      try {
        await localTtsDeleteGeneration(id);
        setGenerations((prev) => prev.filter((g) => g.id !== id));
        if (playingGen === id) {
          previewAudioRef.current?.pause();
          previewAudioRef.current = null;
          setPlayingGen('');
        }
      } catch (e) {
        toast.error({ title: t('voices.genDeleteFailed'), message: String(e) });
      }
    },
    [playingGen, t, toast],
  );

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
  };

  const formatDuration = (ms: number) => {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const previewButton = (voiceId: string) => (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:text-foreground"
      onClick={() => handlePreview(voiceId)}
      disabled={(!!previewing && previewing !== voiceId) || installing || uninstalling}
      title={t('voices.preview')}
    >
      {previewing === voiceId ? (
        <Square className="w-3.5 h-3.5" />
      ) : (
        <Play className="w-3.5 h-3.5" />
      )}
    </Button>
  );

  const defaultButton = (voiceId: string, label: string) => (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:text-foreground"
      onClick={() => handleSetDefault(voiceId, label)}
      title={t('voices.setDefault')}
    >
      <Star
        className={`w-3.5 h-3.5 ${
          defaultVoice === voiceId ? 'fill-amber-400 text-amber-400' : ''
        }`}
      />
    </Button>
  );

  const pageHeader = (
    <>
      <header className="flex-shrink-0 flex items-center justify-between h-12 sm:h-14 px-4 sm:px-6">
        <div className="min-w-0">
          <h1 className="text-base sm:text-lg font-semibold">{t('voices.title')}</h1>
          <p className="hidden sm:block text-xs text-muted-foreground truncate">
            {t('voices.desc')}
          </p>
        </div>
        <ThemePicker />
      </header>
      <div className="mx-4 sm:mx-6 h-px bg-gradient-to-r from-transparent via-border/50 to-transparent" />
    </>
  );

  // ── Not installed: onboarding empty state (same shape as other pages) ────
  if (status === null || !status.installed) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {pageHeader}
        <div className="flex-1 px-4 sm:px-6 pb-4 sm:pb-6 overflow-auto">
          <div className="h-full p-2 sm:p-3">
            <div className="max-w-4xl mx-auto space-y-5">
              <div className="text-center space-y-2">
                <EmptyStateIllustration className="mx-auto" icon={AudioLines} size="sm" />
                <h2 className="text-xl sm:text-2xl font-semibold">{t('voices.emptyTitle')}</h2>
                <p className="text-sm text-muted-foreground">{t('voices.desc')}</p>
                <p className="text-xs text-muted-foreground">
                  {status === null ? '…' : t('voices.engineNotInstalled')}
                </p>
              </div>

              <div className="grid gap-2.5 sm:grid-cols-2">
                {[
                  {
                    icon: <WifiOff className="w-4 h-4" />,
                    label: t('voices.featOffline'),
                  },
                  { icon: <Wallet className="w-4 h-4" />, label: t('voices.featFree') },
                  { icon: <UserPlus className="w-4 h-4" />, label: t('voices.featClone') },
                  { icon: <Mic className="w-4 h-4" />, label: t('voices.featPresets') },
                ].map((f) => (
                  <div
                    key={f.label}
                    className="rounded-xl border border-dashed border-border/70 px-3.5 py-3 text-left"
                  >
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className="text-primary">{f.icon}</span>
                      <span>{f.label}</span>
                    </div>
                  </div>
                ))}
              </div>

              {installing ? (
                <div className="rounded-2xl border border-border/50 bg-card/20 p-4 sm:p-5 space-y-2">
                  <div className="text-sm font-medium mb-1">{t('voices.installingTitle')}</div>
                  {INSTALL_STAGES.map((stage, i) => {
                    const currentIdx = setup
                      ? INSTALL_STAGES.indexOf(setup.stage as (typeof INSTALL_STAGES)[number])
                      : -1;
                    const isDone = setup?.stage === 'done' || (currentIdx >= 0 && i < currentIdx);
                    const isCurrent = setup?.stage === stage;
                    return (
                      <div key={stage} className="flex items-center gap-2.5">
                        <span className="w-4 h-4 flex items-center justify-center shrink-0">
                          {isDone ? (
                            <Check className="w-3.5 h-3.5 text-primary" />
                          ) : isCurrent ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                          ) : (
                            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
                          )}
                        </span>
                        <span
                          className={`text-xs ${
                            isCurrent
                              ? 'text-foreground font-medium'
                              : isDone
                                ? 'text-muted-foreground'
                                : 'text-muted-foreground/50'
                          }`}
                        >
                          {t(`voices.stages.${stage}`)}
                        </span>
                        {isCurrent && setup && setup.percent >= 0 && (
                          <span className="text-xs text-muted-foreground ml-auto shrink-0">
                            {setup.percent}%
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {setup && setup.percent >= 0 ? (
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all duration-300"
                        style={{ width: `${Math.min(100, Math.max(0, setup.percent))}%` }}
                      />
                    </div>
                  ) : (
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div className="h-full w-1/3 bg-primary/60 rounded-full animate-pulse" />
                    </div>
                  )}
                  {setup?.message && (
                    <div className="text-[11px] font-mono text-muted-foreground truncate">
                      {setup.message}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center">
                  <Button onClick={handleInstall} disabled={status === null}>
                    <Download />
                    {t('voices.install')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Installed: two-pane workspace (studio left, voice management right) ──
  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0">
      {pageHeader}

      <div className="flex-1 px-4 sm:px-6 py-4 min-h-0">
        <div className="h-full min-h-0 rounded-2xl border border-border/50 bg-card/20 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col lg:flex-row">
            {/* TTS studio */}
            <div className="flex-1 min-w-0 min-h-0 flex flex-col p-4 sm:p-5 overflow-y-auto">
              <div className="mb-3">
                <div className="text-sm font-medium">{t('voices.ttsTitle')}</div>
                <div className="text-xs text-muted-foreground mt-1">{t('voices.ttsDesc')}</div>
              </div>

              <Textarea
                value={ttsText}
                disabled={ttsBusy}
                onChange={(e) => setTtsText(e.target.value)}
                placeholder={t('voices.ttsPlaceholder')}
                className="flex-1 min-h-[140px] resize-none"
              />
              <div className="text-[11px] text-muted-foreground text-right mt-1 mb-3">
                {ttsText.trim().length.toLocaleString()}
              </div>

              <div className="flex flex-col sm:flex-row gap-2">
                <Select value={ttsVoiceId} onValueChange={setTtsVoiceId} disabled={ttsBusy}>
                  <SelectTrigger className="flex-1 min-w-0 h-9">
                    <SelectValue placeholder={t('voices.ttsVoice')} />
                  </SelectTrigger>
                  <SelectContent>
                    {voiceOptions.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  className="shrink-0 h-9"
                  onClick={handleTtsGenerate}
                  disabled={ttsBusy || !ttsText.trim() || !ttsVoiceId || voicesLoading}
                >
                  {ttsBusy ? <Loader2 className="animate-spin" /> : <Volume2 />}
                  {ttsBusy ? t('voices.ttsGenerating') : t('voices.ttsGenerate')}
                </Button>
              </div>

              {ttsResult && (
                <div className="mt-3 space-y-2 border-t border-border/50 pt-3">
                  <div className="flex items-center gap-2">
                    {/* biome-ignore lint/a11y/useMediaCaption: generated speech, no captions exist */}
                    <audio controls src={ttsResult.url} className="flex-1 min-w-0 h-9" />
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatDuration(ttsResult.durationMs)}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => saveWavAs(ttsResult.path)}>
                      <Save /> {t('voices.ttsSave')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => revealOutputInFolder(ttsResult.path)}
                    >
                      <FolderOpen /> {t('voices.ttsReveal')}
                    </Button>
                  </div>
                </div>
              )}

              {/* Generated-audio history */}
              {generations.length > 0 && (
                <div className="mt-4 border-t border-border/50 pt-3">
                  <div className="text-sm font-medium mb-2">
                    {t('voices.genTitle', { count: generations.length })}
                  </div>
                  <div className="flex flex-col divide-y divide-border/30">
                    {generations.map((g) => (
                      <div key={g.id} className="flex items-center gap-2 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm truncate" title={g.text}>
                            {g.text}
                          </div>
                          <div className="text-[11px] text-muted-foreground truncate">
                            {g.voice_label} · {formatDuration(g.duration_ms)} ·{' '}
                            {formatDate(g.created_at)}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground"
                          onClick={() => handlePlayGeneration(g)}
                          title={t('voices.preview')}
                        >
                          {playingGen === g.id ? (
                            <Square className="w-3.5 h-3.5" />
                          ) : (
                            <Play className="w-3.5 h-3.5" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground"
                          onClick={() => saveWavAs(g.path)}
                          title={t('voices.ttsSave')}
                        >
                          <Save className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => handleDeleteGeneration(g.id)}
                          title={t('voices.genDelete')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Voice management side panel — tabbed so the destructive
                actions on cloned voices can't be hit while browsing the
                built-in list. */}
            <div className="lg:w-[360px] lg:max-w-[45%] min-h-[280px] lg:min-h-0 border-t lg:border-t-0 lg:border-l border-border/50 flex flex-col min-w-0">
              <Tabs
                defaultValue="voices"
                className="flex-1 flex flex-col min-h-0 overflow-hidden"
              >
                <div className="flex-shrink-0 px-4 sm:px-5 pt-4">
                  {/* bg-muted/40 + border: the default solid bg-muted reads as
                      an opaque block on the translucent bg-card/20 panel. */}
                  <TabsList className="grid w-full grid-cols-3 h-auto bg-muted/40 border border-border/50">
                    <TabsTrigger value="voices" className="gap-1.5 py-1.5">
                      <AudioLines className="w-4 h-4" />
                      {t('voices.tabPresets')}
                    </TabsTrigger>
                    <TabsTrigger value="cloned" className="gap-1.5 py-1.5">
                      <UserPlus className="w-4 h-4" />
                      {t('voices.tabCloned')}
                    </TabsTrigger>
                    <TabsTrigger value="engine" className="gap-1.5 py-1.5">
                      <Settings2 className="w-4 h-4" />
                      {t('voices.tabEngine')}
                    </TabsTrigger>
                  </TabsList>
                </div>

                <TabsContent
                  value="engine"
                  className="mt-0 min-h-0 flex-1 overflow-y-auto data-[state=active]:block"
                >
              {/* Engine */}
              <div className="p-4 sm:p-5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t('voices.engine')}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {version?.installed
                        ? `VieNeu-TTS ${version.installed}`
                        : t('voices.engineInstalled')}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleUninstall}
                    disabled={uninstalling || installing || updating}
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                  >
                    {uninstalling ? <Loader2 className="animate-spin" /> : <Trash2 />}
                    {t('voices.uninstall')}
                  </Button>
                </div>

                {/* Quality / speed trade-off — same 48kHz model, two graphs. */}
                <div className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
                  {t('voices.precision')}
                  <Select
                    value={precision}
                    onValueChange={handlePrecisionChange}
                    disabled={switchingPrecision || updating || uninstalling}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="int8">{t('voices.precisionFast')}</SelectItem>
                      <SelectItem value="fp32">{t('voices.precisionQuality')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-[11px]">
                    {switchingPrecision
                      ? t('voices.precisionSwitching')
                      : precision === 'fp32'
                        ? t('voices.precisionQualityHint')
                        : t('voices.precisionFastHint')}
                  </span>
                </div>

                {/* Version / update */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCheckUpdate}
                    disabled={checkingUpdate || updating || uninstalling}
                    className="text-muted-foreground"
                  >
                    {checkingUpdate ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <RefreshCw />
                    )}
                    {t('voices.checkUpdate')}
                  </Button>
                  {version?.update_available && (
                    <Button size="sm" onClick={handleUpdate} disabled={updating}>
                      {updating ? <Loader2 className="animate-spin" /> : <Download />}
                      {updating
                        ? t('voices.updating')
                        : t('voices.updateTo', { version: version.latest })}
                    </Button>
                  )}
                </div>
                {version && !version.update_available && version.latest && (
                  <div className="mt-1.5 text-[11px] text-muted-foreground">
                    {t('voices.upToDate')}
                  </div>
                )}
                {updating && setup?.message && (
                  <div className="mt-1.5 text-[11px] font-mono text-muted-foreground truncate">
                    {setup.message}
                  </div>
                )}
              </div>
                </TabsContent>

                <TabsContent
                  value="cloned"
                  className="mt-0 min-h-0 flex-1 overflow-y-auto data-[state=active]:block"
                >
              {/* Cloned voices */}
              <div className="p-4 sm:p-5">
                <div className="text-sm font-medium mb-1">{t('voices.cloned')}</div>
                <div className="text-xs text-muted-foreground mb-3">{t('voices.clonedDesc')}</div>

                <div className="flex gap-2 mb-3">
                  <Input
                    value={cloneName}
                    disabled={cloneBusy}
                    onChange={(e) => setCloneName(e.target.value)}
                    placeholder={t('voices.namePlaceholder')}
                    className="flex-1 min-w-0 h-9"
                  />
                  <Button
                    size="sm"
                    className="shrink-0 h-9"
                    onClick={handleClone}
                    disabled={cloneBusy || installing || uninstalling}
                  >
                    {cloneBusy ? <Loader2 className="animate-spin" /> : <UserPlus />}
                    {cloneBusy ? t('voices.cloning') : t('voices.addVoice')}
                  </Button>
                </div>

                {/* Clone pipeline progress: convert → analyze/test-speak. */}
                {cloneBusy && (
                  <div className="mb-3 space-y-1.5 rounded-lg border border-border/50 bg-card/20 p-2.5">
                    {(
                      [
                        ['convert', t('voices.cloneStageConvert')],
                        ['analyze', t('voices.cloneStageAnalyze')],
                      ] as const
                    ).map(([stage, label]) => {
                      const isDone = stage === 'convert' && cloneStage === 'analyze';
                      const isCurrent = cloneStage === stage;
                      return (
                        <div key={stage} className="flex items-center gap-2.5">
                          <span className="w-4 h-4 flex items-center justify-center shrink-0">
                            {isDone ? (
                              <Check className="w-3.5 h-3.5 text-primary" />
                            ) : isCurrent ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                            ) : (
                              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
                            )}
                          </span>
                          <span
                            className={`text-xs ${
                              isCurrent
                                ? 'text-foreground font-medium'
                                : isDone
                                  ? 'text-muted-foreground'
                                  : 'text-muted-foreground/50'
                            }`}
                          >
                            {label}
                          </span>
                        </div>
                      );
                    })}
                    {cloneStage === 'analyze' && (
                      <div className="text-[11px] text-muted-foreground pl-6">
                        {t('voices.cloneStageAnalyzeHint')}
                      </div>
                    )}
                  </div>
                )}

                {clonedProfiles.length > 0 ? (
                  <div className="flex flex-col divide-y divide-border/50">
                    {clonedProfiles.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 py-2">
                        <span className="text-sm min-w-0 flex-1 truncate">👤 {p.name}</span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {formatDate(p.created_at)}
                        </span>
                        {defaultButton(`profile:${p.id}`, p.name)}
                        {previewButton(`profile:${p.id}`)}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => handleDelete(p.id, p.name)}
                          title={t('voices.delete')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground italic">{t('voices.noCloned')}</div>
                )}
              </div>
                </TabsContent>

                <TabsContent
                  value="voices"
                  className="mt-0 min-h-0 flex-1 overflow-y-auto data-[state=active]:block"
                >
              {/* Preset voices */}
              <div className="p-4 sm:p-5">
                <div className="text-sm font-medium mb-1">{t('voices.presets')}</div>
                <div className="text-xs text-muted-foreground mb-3">{t('voices.presetsDesc')}</div>
                {voicesLoading ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('voices.starting')}
                  </div>
                ) : builtinProfiles.length > 0 || (voices && voices.presets.length > 0) ? (
                  <div className="flex flex-col divide-y divide-border/30">
                    {/* Fine-tuned LoRA voices: best fidelity, slower engine. */}
                    {(voices?.loras ?? []).map((p) => (
                      <div key={p.id} className="flex items-center gap-2 py-1.5">
                        <span className="text-sm min-w-0 flex-1 truncate" title={p.label}>
                          ✨ {p.label}
                        </span>
                        {defaultButton(`lora:${p.id}`, p.label)}
                        {previewButton(`lora:${p.id}`)}
                      </div>
                    ))}
                    {/* Bundled reference voices ship with the app; no delete. */}
                    {builtinProfiles.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 py-1.5">
                        <span className="text-sm min-w-0 flex-1 truncate" title={p.name}>
                          {p.name}
                        </span>
                        {defaultButton(`profile:${p.id}`, p.name)}
                        {previewButton(`profile:${p.id}`)}
                      </div>
                    ))}
                    {voices?.presets.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 py-1.5">
                        <span className="text-sm min-w-0 flex-1 truncate" title={p.label}>
                          {p.label}
                        </span>
                        {defaultButton(`preset:${p.id}`, p.id)}
                        {previewButton(`preset:${p.id}`)}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground italic">
                    {t('voices.noPresets')}
                  </div>
                )}
              </div>
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
