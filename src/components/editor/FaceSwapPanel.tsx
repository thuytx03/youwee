import { type Clip, importUrl, type TimelineEngine, useMediaLibraryStore } from '@elah/editor';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Download, FolderOpen, ImagePlus, Loader2, RefreshCw, Replace, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { onProcessingProgress } from '@/contexts/editor/editor-client';
import { syncAssetScopePaths, toAssetUrl } from '@/lib/asset-access';
import { getAssetPath, regenerateDerivedMedia, rememberAssetPath } from '@/lib/editor-drafts';

interface FaceFusionStatus {
  installed: boolean;
  kind: string | null;
  dir: string | null;
  python: string | null;
  error: string | null;
  /** Provider "auto" resolves to here ("coreml"|"cuda"|"cpu"). */
  auto_provider: string | null;
}

interface SetupProgress {
  stage: string;
  percent: number;
  message: string;
}

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp'];
const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'];

const PROVIDERS = ['auto', 'coreml', 'cuda', 'cpu'] as const;

/**
 * FaceFusion prints its progress-bar label in English ("Processing",
 * "Analysing", …). Map the known ones to a localized string; fall back to the
 * raw label (lower-cased) for anything unmapped so it still reads sensibly.
 */
function localizeStage(raw: string, t: (key: string) => string): string {
  const key = raw.trim().toLowerCase().replace(/\s+/g, '_');
  const known = [
    'downloading',
    'analysing',
    'analyzing',
    'detecting',
    'processing',
    'merging',
    'checking',
  ];
  if (known.includes(key)) {
    return t(`editor.faceSwap.swapStage_${key}`);
  }
  return raw;
}

/** Every clip on the timeline backed by `assetId`, across all tracks. */
function clipsForAsset(engine: TimelineEngine, assetId: string): Clip[] {
  const project = engine.getProject();
  const found: Clip[] = [];
  for (const track of project.tracks) {
    for (const clip of project.clips[track.id] ?? []) {
      if (clip.assetId === assetId) found.push(clip);
    }
  }
  return found;
}

const btn =
  'w-full shrink-0 inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm border border-ed-border text-ed-text hover:bg-ed-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const sectionTitle = 'text-[11px] font-semibold text-ed-text-muted uppercase tracking-wide mt-1';
const inputCls =
  'w-full px-2 py-1.5 text-xs rounded border border-ed-border bg-ed-elevated text-ed-text outline-none focus:border-ed-accent';

/** Stages of the managed install, in order, for a rough overall progress bar. */
const SETUP_STAGES = ['download-uv', 'clone', 'python', 'deps', 'models'];

/**
 * Setup view shown until FaceFusion is available. The primary path is a
 * one-click managed install (app downloads uv + Python + FaceFusion into
 * app_data); pointing at an existing checkout is tucked away as an advanced
 * option for users who already have one.
 */
function SetupView({
  status,
  onSaved,
}: {
  status: FaceFusionStatus;
  onSaved: (s: FaceFusionStatus) => void;
}) {
  const { t } = useTranslation('pages');
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Advanced (manual checkout) sub-form.
  const [dir, setDir] = useState(status.dir ?? '');
  const [python, setPython] = useState(status.python ?? '');
  const [savingManual, setSavingManual] = useState(false);

  const install = async () => {
    setInstalling(true);
    setError(null);
    setProgress({ stage: 'download-uv', percent: -1, message: '' });

    const unlisten = await listen<SetupProgress>('facefusion-setup', ({ payload }) => {
      setProgress(payload);
    });
    try {
      const next = await invoke<FaceFusionStatus>('install_facefusion');
      if (next.installed) {
        onSaved(next);
      } else {
        setError(next.error ?? 'Install did not complete');
      }
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      setInstalling(false);
    }
  };

  const browseDir = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === 'string') setDir(picked);
  };

  const saveManual = async () => {
    setSavingManual(true);
    setError(null);
    try {
      const next = await invoke<FaceFusionStatus>('set_facefusion_config_cmd', {
        dir: dir.trim() || null,
        python: python.trim() || null,
      });
      if (next.installed) {
        onSaved(next);
      } else {
        setError(next.error ?? 'Unknown error');
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingManual(false);
    }
  };

  if (installing) {
    const idx = progress ? SETUP_STAGES.indexOf(progress.stage) : 0;
    // Coarse bar: each stage is an equal slice; within a stage we can't know %.
    const overall = idx >= 0 ? Math.round((idx / SETUP_STAGES.length) * 100) : 0;
    return (
      <>
        <div className="text-xs text-ed-text-muted">{t('editor.faceSwap.installing')}</div>
        <div className="shrink-0 h-1.5 rounded bg-ed-elevated overflow-hidden">
          <div
            className="h-full rounded transition-[width]"
            style={{ width: `${Math.max(overall, 4)}%`, background: 'var(--elah-accent)' }}
          />
        </div>
        <div className="text-[11px] text-ed-text-muted">
          {progress ? t(`editor.faceSwap.stage_${progress.stage}`, progress.stage) : ''}
        </div>
        {progress?.message && (
          <div className="text-[10px] font-mono text-ed-text-muted break-all line-clamp-3">
            {progress.message}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <div className="text-xs text-ed-text-muted">{t('editor.faceSwap.setupIntro')}</div>
      <button type="button" className={btn} onClick={() => void install()}>
        <Download className="w-4 h-4" /> {t('editor.faceSwap.install')}
      </button>
      <div className="text-[11px] text-ed-text-muted">{t('editor.faceSwap.installNote')}</div>
      {error && (
        <div className="text-[11px] text-[var(--elah-color-error)] break-words whitespace-pre-wrap">
          {error}
        </div>
      )}

      {/* Advanced: use an existing FaceFusion checkout instead. */}
      <details className="mt-1">
        <summary className="text-[11px] text-ed-text-muted hover:text-ed-text cursor-pointer">
          {t('editor.faceSwap.advanced')}
        </summary>
        <div className="flex flex-col gap-2 mt-2">
          <div className="flex flex-col gap-1 text-xs text-ed-text-muted">
            {t('editor.faceSwap.installDir')}
            <div className="flex gap-1.5">
              <input
                value={dir}
                onChange={(e) => setDir(e.target.value)}
                placeholder="/path/to/facefusion"
                className={inputCls}
              />
              <button
                type="button"
                onClick={() => void browseDir()}
                title={t('editor.faceSwap.browse')}
                className="shrink-0 inline-flex items-center justify-center w-8 rounded border border-ed-border text-ed-text-muted hover:text-ed-text hover:bg-ed-elevated transition-colors"
              >
                <FolderOpen size={14} />
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-1 text-xs text-ed-text-muted">
            {t('editor.faceSwap.pythonPath')}
            <input
              value={python}
              onChange={(e) => setPython(e.target.value)}
              placeholder={t('editor.faceSwap.pythonPlaceholder')}
              className={inputCls}
            />
          </div>
          <button
            type="button"
            className={btn}
            onClick={() => void saveManual()}
            disabled={savingManual || !dir.trim()}
          >
            {savingManual ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            {t('editor.faceSwap.saveAndCheck')}
          </button>
          <button
            type="button"
            className="text-[11px] text-ed-text-muted hover:text-ed-text underline text-left"
            onClick={() => void openUrl('https://docs.facefusion.io/installation')}
          >
            {t('editor.faceSwap.installGuide')}
          </button>
        </div>
      </details>
    </>
  );
}

/**
 * Face swap via a local FaceFusion install: pick a face image + a target video,
 * run headless, and place the result. When the target is a video already on the
 * timeline, its clips are swapped in place (like text removal); otherwise the
 * result lands in the media library for the user to place.
 */
export function FaceSwapPanel({ engine }: { engine: TimelineEngine | null }) {
  const { t } = useTranslation('pages');
  const toast = useToast();

  const [status, setStatus] = useState<FaceFusionStatus | null>(null);
  const [faceImage, setFaceImage] = useState<{ path: string; url: string } | null>(null);
  // assetId is set when the target came from the library, letting a finished
  // swap replace that video's clips on the timeline in place.
  const [target, setTarget] = useState<{ path: string; name: string; assetId?: string } | null>(
    null,
  );
  const [enhance, setEnhance] = useState(false);
  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]>('auto');
  const [running, setRunning] = useState(false);
  const [percent, setPercent] = useState(0);
  const [stage, setStage] = useState('');

  const jobIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  const assets = useMediaLibraryStore((s) => s.assets);
  // Only library videos with a real filesystem path can be a swap target — a
  // blob: import (no path) can't be handed to an external process.
  const videoOptions = Object.values(assets)
    .filter((a) => a.kind === 'video')
    .map((a) => ({ id: a.id, name: a.name, path: getAssetPath(a.id) }))
    .filter((a): a is { id: string; name: string; path: string } => !!a.path);

  useEffect(() => {
    void invoke<FaceFusionStatus>('check_facefusion')
      .then(setStatus)
      .catch((e) =>
        setStatus({
          installed: false,
          kind: null,
          dir: null,
          python: null,
          error: String(e),
          auto_provider: null,
        }),
      );
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  const pickFace = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: 'Image', extensions: IMAGE_EXT }],
    });
    if (typeof picked !== 'string') return;
    try {
      // Grant the parent directory to the asset scope first (as the media
      // importer does): allow_file alone isn't always enough for the asset://
      // protocol to actually serve the image to the webview.
      await syncAssetScopePaths([picked]).catch(() => {});
      const url = await toAssetUrl(picked);
      setFaceImage({ path: picked, url });
    } catch (e) {
      toast.error({ title: t('editor.faceSwap.failed'), message: String(e) });
    }
  };

  const pickTargetFile = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: 'Video', extensions: VIDEO_EXT }],
    });
    if (typeof picked !== 'string') return;
    setTarget({ path: picked, name: picked.split(/[/\\]/).pop() ?? picked });
  };

  const cancel = useCallback(() => {
    const id = jobIdRef.current;
    if (id) void invoke('editor_cancel_ffmpeg', { jobId: id }).catch(() => {});
  }, []);

  const uninstall = async () => {
    if (!window.confirm(t('editor.faceSwap.uninstallConfirm'))) return;
    try {
      const next = await invoke<FaceFusionStatus>('uninstall_facefusion');
      setStatus(next);
      setTarget(null);
    } catch (e) {
      toast.error({ title: t('editor.faceSwap.failed'), message: String(e) });
    }
  };

  const run = async () => {
    if (running || !faceImage || !target) return;
    const jobId = `faceswap-${Date.now()}`;
    jobIdRef.current = jobId;
    setRunning(true);
    setPercent(0);
    setStage('');

    unlistenRef.current = await onProcessingProgress(({ payload }) => {
      if (payload.job_id !== jobId) return;
      setPercent(Math.round(payload.percent));
      if (payload.speed && payload.speed !== 'done') setStage(payload.speed);
    });

    try {
      const outPath = await invoke<string>('editor_face_swap', {
        jobId,
        sourceImage: faceImage.path,
        targetVideo: target.path,
        enhance,
        provider,
      });

      const url = await toAssetUrl(outPath);

      // The swap result is always a NEW library asset — the original video is
      // never overwritten, so it stays available in the Media tab.
      const name = `faceswap_${target.name.replace(/\.[^.]+$/, '')}.mp4`;
      const asset = await importUrl(url, { kind: 'video', name });
      // derived=true: regenerated output, so a missing file on reopen should
      // re-run the swap, not ask the user to locate it.
      rememberAssetPath(asset.id, outPath, true);
      void regenerateDerivedMedia([asset]);

      // If the target is a library video already on the timeline, point those
      // clips at the NEW asset so the result shows immediately — while the
      // original asset and any of its other clips stay untouched.
      const clips = engine && target.assetId ? clipsForAsset(engine, target.assetId) : [];
      if (engine && clips.length > 0) {
        engine.batch(() => {
          for (const clip of clips) {
            // Replace rather than mutate src: VideoLayer caches a decoder per
            // clip id and never re-reads src, so an in-place update would keep
            // playing the original for the rest of the session.
            engine.removeClip(clip.id, clip.trackId);
            engine.addClip({
              type: 'video',
              trackId: clip.trackId,
              startFrame: clip.startFrame,
              durationFrames: clip.durationFrames,
              src: url,
              assetId: asset.id,
              name: clip.name,
              ...(clip.transform ? { transform: clip.transform } : {}),
              ...(clip.volume !== undefined ? { volume: clip.volume } : {}),
              ...(clip.opacity !== undefined ? { opacity: clip.opacity } : {}),
            });
          }
        }, 'Face swap');
        toast.success({ title: t('editor.faceSwap.doneReplaced') });
      } else {
        // Target picked from disk, or not placed on the timeline yet: the user
        // drags the new library asset in themselves.
        toast.success({ title: t('editor.faceSwap.done'), message: name });
      }
    } catch (e) {
      const msg = String(e);
      if (msg.includes('cancelled')) {
        toast.info({ title: t('editor.faceSwap.cancelled') });
      } else {
        toast.error({ title: t('editor.faceSwap.failed'), message: msg });
      }
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
      jobIdRef.current = null;
      setRunning(false);
      setPercent(0);
      setStage('');
    }
  };

  return (
    <div
      className="flex flex-col gap-3 p-3 overflow-y-auto text-ed-text"
      style={{ height: '100%' }}
    >
      <div className="text-sm font-semibold flex items-center gap-2">
        <Replace className="w-4 h-4" /> {t('editor.faceSwap.title')}
      </div>

      {status === null ? (
        <div className="flex items-center gap-2 text-xs text-ed-text-muted">
          <Loader2 className="w-4 h-4 animate-spin" /> {t('editor.faceSwap.checking')}
        </div>
      ) : !status.installed ? (
        <SetupView status={status} onSaved={setStatus} />
      ) : (
        <>
          {/* 1. Face image */}
          <div className={sectionTitle}>{t('editor.faceSwap.faceSection')}</div>
          {faceImage && (
            <div className="relative shrink-0 self-start w-24 h-24">
              {/* crossOrigin: the app runs with COEP require-corp, which blocks
                  a cross-origin asset:// image unless it's fetched in CORS mode.
                  Elah's own image loader sets the same attribute. */}
              <img
                src={faceImage.url}
                alt=""
                crossOrigin="anonymous"
                className="w-24 h-24 rounded-md border border-ed-border object-cover bg-ed-elevated"
                onError={() =>
                  toast.error({
                    title: t('editor.faceSwap.failed'),
                    message: `Không tải được ảnh: ${faceImage.path}`,
                  })
                }
              />
              <button
                type="button"
                onClick={() => setFaceImage(null)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 inline-flex items-center justify-center rounded-full bg-ed-elevated border border-ed-border text-ed-text-muted hover:text-ed-text"
                title={t('editor.faceSwap.clearFace')}
              >
                <X size={11} />
              </button>
            </div>
          )}
          <button type="button" className={btn} onClick={() => void pickFace()} disabled={running}>
            <ImagePlus className="w-4 h-4" />
            {faceImage ? t('editor.faceSwap.changeFace') : t('editor.faceSwap.pickFace')}
          </button>

          {/* 2. Target video */}
          <div className={sectionTitle}>{t('editor.faceSwap.targetSection')}</div>
          {videoOptions.length > 0 && (
            <Select
              value={videoOptions.find((v) => v.path === target?.path)?.path ?? ''}
              onValueChange={(path) => {
                const opt = videoOptions.find((v) => v.path === path);
                if (opt) setTarget({ path: opt.path, name: opt.name, assetId: opt.id });
              }}
              disabled={running}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('editor.faceSwap.pickFromLibrary')} />
              </SelectTrigger>
              <SelectContent>
                {videoOptions.map((v) => (
                  <SelectItem key={v.id} value={v.path}>
                    {v.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <button
            type="button"
            className={btn}
            onClick={() => void pickTargetFile()}
            disabled={running}
          >
            <FolderOpen className="w-4 h-4" /> {t('editor.faceSwap.pickTargetFile')}
          </button>
          {target && (
            <div className="text-[11px] text-ed-text-muted truncate" title={target.path}>
              {t('editor.faceSwap.target')}: {target.name}
            </div>
          )}

          {/* 3. Options */}
          <div className={sectionTitle}>{t('editor.faceSwap.optionsSection')}</div>
          <div className="flex items-start justify-between gap-3">
            <span className="text-xs text-ed-text">
              {t('editor.faceSwap.enhance')}
              <span className="block text-[11px] text-ed-text-muted">
                {t('editor.faceSwap.enhanceHint')}
              </span>
            </span>
            <Switch
              checked={enhance}
              onCheckedChange={setEnhance}
              disabled={running}
              className="mt-0.5 shrink-0"
            />
          </div>
          <div className="flex flex-col gap-1 text-xs text-ed-text-muted">
            {t('editor.faceSwap.provider')}
            <Select
              value={provider}
              onValueChange={(v) => setProvider(v as (typeof PROVIDERS)[number])}
              disabled={running}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {t(`editor.faceSwap.provider_${p}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[11px] text-ed-text-muted">
              {t('editor.faceSwap.providerHint')}
            </span>
            {/* No GPU on this machine: warn that swaps will be slow, so a weak
                (often CPU-only Windows) box doesn't look frozen. Shown when the
                effective provider — the explicit pick, or what "auto" resolves
                to — is CPU. */}
            {(provider === 'cpu' || (provider === 'auto' && status.auto_provider === 'cpu')) && (
              <span className="text-[11px] text-[var(--elah-color-warning,#e0b341)]">
                {t('editor.faceSwap.cpuWarning')}
              </span>
            )}
          </div>

          {/* 4. Run */}
          {running ? (
            <>
              <div className="shrink-0 h-1.5 rounded bg-ed-elevated overflow-hidden">
                <div
                  className="h-full rounded transition-[width]"
                  style={{ width: `${percent}%`, background: 'var(--elah-accent)' }}
                />
              </div>
              <div className="text-[11px] text-ed-text-muted">
                {stage ? `${localizeStage(stage, t)} — ` : ''}
                {percent}%
              </div>
              <button type="button" className={btn} onClick={cancel}>
                <X className="w-4 h-4" /> {t('editor.faceSwap.cancel')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className={btn}
              onClick={() => void run()}
              disabled={!faceImage || !target}
            >
              <Replace className="w-4 h-4" /> {t('editor.faceSwap.run')}
            </button>
          )}
          <div className="text-[11px] text-ed-text-muted">{t('editor.faceSwap.resultHint')}</div>
          <div className="text-[11px] text-ed-text-muted">{t('editor.faceSwap.consentNote')}</div>
          {status.kind === 'managed' && (
            <button
              type="button"
              onClick={() => void uninstall()}
              disabled={running}
              className="mt-1 text-[11px] text-ed-text-muted hover:text-[var(--elah-color-error)] underline text-left disabled:opacity-40"
            >
              {t('editor.faceSwap.uninstall')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
