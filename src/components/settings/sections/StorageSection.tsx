import { invoke } from '@tauri-apps/api/core';
import { AudioLines, HardDrive, Loader2, RefreshCw, Replace, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/components/ui/toast';
import { SettingsCard, SettingsSection } from '../SettingsSection';

interface FaceFusionStorage {
  installed: boolean;
  managed: boolean;
  models_bytes: number;
  runtime_bytes: number;
  total_bytes: number;
}

interface LocalTtsStorage {
  installed: boolean;
  models_bytes: number;
  voices_bytes: number;
  runtime_bytes: number;
  total_bytes: number;
}

/** Bytes → "1.2 GB" / "340 MB" / "0 B", one decimal from MB up. */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${i >= 2 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

interface StorageSectionProps {
  highlightId?: string | null;
}

export function StorageSection(_props: StorageSectionProps) {
  const { t } = useTranslation('settings');
  const toast = useToast();

  const [storage, setStorage] = useState<FaceFusionStorage | null>(null);
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);

  const [ttsStorage, setTtsStorage] = useState<LocalTtsStorage | null>(null);
  const [ttsCleaning, setTtsCleaning] = useState(false);
  const [ttsUninstalling, setTtsUninstalling] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await invoke<FaceFusionStorage>('facefusion_storage');
      setStorage(s);
    } catch (e) {
      console.error('Failed to read FaceFusion storage:', e);
      setStorage(null);
    }
    try {
      const v = await invoke<LocalTtsStorage>('editor_local_tts_storage');
      setTtsStorage(v);
    } catch (e) {
      console.error('Failed to read local TTS storage:', e);
      setTtsStorage(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCleanModels = useCallback(async () => {
    if (!window.confirm(t('storage.faceSwap.cleanConfirm'))) return;
    setCleaning(true);
    try {
      const freed = await invoke<number>('clean_facefusion_models');
      toast.success({
        title: t('storage.faceSwap.cleanDone'),
        message: t('storage.faceSwap.freed', { size: formatBytes(freed) }),
      });
      await refresh();
    } catch (e) {
      toast.error({ title: t('storage.faceSwap.cleanFailed'), message: String(e) });
    } finally {
      setCleaning(false);
    }
  }, [t, toast, refresh]);

  const handleUninstall = useCallback(async () => {
    if (!window.confirm(t('storage.faceSwap.uninstallConfirm'))) return;
    setUninstalling(true);
    try {
      await invoke('uninstall_facefusion');
      toast.success({ title: t('storage.faceSwap.uninstallDone') });
      await refresh();
    } catch (e) {
      toast.error({ title: t('storage.faceSwap.uninstallFailed'), message: String(e) });
    } finally {
      setUninstalling(false);
    }
  }, [t, toast, refresh]);

  const handleTtsCleanModels = useCallback(async () => {
    if (!window.confirm(t('storage.voices.cleanConfirm'))) return;
    setTtsCleaning(true);
    try {
      const freed = await invoke<number>('editor_local_tts_clean_models');
      toast.success({
        title: t('storage.voices.cleanDone'),
        message: t('storage.faceSwap.freed', { size: formatBytes(freed) }),
      });
      await refresh();
    } catch (e) {
      toast.error({ title: t('storage.voices.cleanFailed'), message: String(e) });
    } finally {
      setTtsCleaning(false);
    }
  }, [t, toast, refresh]);

  const handleTtsUninstall = useCallback(async () => {
    if (!window.confirm(t('storage.voices.uninstallConfirm'))) return;
    setTtsUninstalling(true);
    try {
      await invoke('editor_local_tts_uninstall');
      toast.success({ title: t('storage.voices.uninstallDone') });
      await refresh();
    } catch (e) {
      toast.error({ title: t('storage.voices.uninstallFailed'), message: String(e) });
    } finally {
      setTtsUninstalling(false);
    }
  }, [t, toast, refresh]);

  const busy = cleaning || uninstalling;
  const ttsBusy = ttsCleaning || ttsUninstalling;

  return (
    <div className="space-y-8">
      <SettingsSection
        title={t('storage.title')}
        description={t('storage.description')}
        icon={<HardDrive className="w-5 h-5 text-white" />}
        iconClassName="bg-gradient-to-br from-teal-500 to-emerald-600 shadow-teal-500/20"
      >
        <SettingsCard>
          <div className="p-4 sm:p-5">
            {/* Tool header */}
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-muted">
                <Replace className="h-5 w-5 text-foreground/80" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{t('storage.faceSwap.name')}</div>
                <div className="text-sm text-muted-foreground">
                  {loading
                    ? t('storage.loading')
                    : storage?.installed
                      ? t('storage.faceSwap.installedTotal', {
                          size: formatBytes(storage.total_bytes),
                        })
                      : t('storage.faceSwap.notInstalled')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={loading || busy}
                title={t('storage.refresh')}
                className="flex-shrink-0 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {storage?.installed && (
              <>
                {/* Breakdown: models vs runtime */}
                <div className="mt-4 space-y-2">
                  <StorageBar
                    label={t('storage.faceSwap.models')}
                    hint={t('storage.faceSwap.modelsHint')}
                    bytes={storage.models_bytes}
                    total={storage.total_bytes}
                    tone="models"
                    format={formatBytes}
                  />
                  <StorageBar
                    label={t('storage.faceSwap.runtime')}
                    hint={t('storage.faceSwap.runtimeHint')}
                    bytes={storage.runtime_bytes}
                    total={storage.total_bytes}
                    tone="runtime"
                    format={formatBytes}
                  />
                </div>

                {/* Actions */}
                <div className="mt-5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCleanModels()}
                    disabled={busy || storage.models_bytes === 0}
                    className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {cleaning ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    {t('storage.faceSwap.cleanModels')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleUninstall()}
                    disabled={busy}
                    className="inline-flex items-center gap-2 rounded-lg border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {uninstalling ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    {t('storage.faceSwap.uninstall')}
                  </button>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  {t('storage.faceSwap.cleanNote')}
                </p>
              </>
            )}

            {!loading && !storage?.installed && (
              <p className="mt-4 text-sm text-muted-foreground">
                {t('storage.faceSwap.installHint')}
              </p>
            )}
          </div>
        </SettingsCard>

        <SettingsCard>
          <div className="p-4 sm:p-5">
            {/* Tool header */}
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-muted">
                <AudioLines className="h-5 w-5 text-foreground/80" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{t('storage.voices.name')}</div>
                <div className="text-sm text-muted-foreground">
                  {loading
                    ? t('storage.loading')
                    : ttsStorage?.installed
                      ? t('storage.faceSwap.installedTotal', {
                          size: formatBytes(ttsStorage.total_bytes),
                        })
                      : t('storage.faceSwap.notInstalled')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={loading || ttsBusy}
                title={t('storage.refresh')}
                className="flex-shrink-0 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {ttsStorage?.installed && (
              <>
                {/* Breakdown: models / cloned voices / runtime */}
                <div className="mt-4 space-y-2">
                  <StorageBar
                    label={t('storage.voices.models')}
                    hint={t('storage.voices.modelsHint')}
                    bytes={ttsStorage.models_bytes}
                    total={ttsStorage.total_bytes}
                    tone="models"
                    format={formatBytes}
                  />
                  <StorageBar
                    label={t('storage.voices.cloned')}
                    hint={t('storage.voices.clonedHint')}
                    bytes={ttsStorage.voices_bytes}
                    total={ttsStorage.total_bytes}
                    tone="models"
                    format={formatBytes}
                  />
                  <StorageBar
                    label={t('storage.faceSwap.runtime')}
                    hint={t('storage.faceSwap.runtimeHint')}
                    bytes={ttsStorage.runtime_bytes}
                    total={ttsStorage.total_bytes}
                    tone="runtime"
                    format={formatBytes}
                  />
                </div>

                {/* Actions */}
                <div className="mt-5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleTtsCleanModels()}
                    disabled={ttsBusy || ttsStorage.models_bytes === 0}
                    className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {ttsCleaning ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    {t('storage.faceSwap.cleanModels')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleTtsUninstall()}
                    disabled={ttsBusy}
                    className="inline-flex items-center gap-2 rounded-lg border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {ttsUninstalling ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    {t('storage.faceSwap.uninstall')}
                  </button>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">{t('storage.voices.cleanNote')}</p>
              </>
            )}

            {!loading && !ttsStorage?.installed && (
              <p className="mt-4 text-sm text-muted-foreground">
                {t('storage.voices.installHint')}
              </p>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

/** One labelled usage bar (models / runtime) with its share of the total. */
function StorageBar({
  label,
  hint,
  bytes,
  total,
  tone,
  format,
}: {
  label: string;
  hint: string;
  bytes: number;
  total: number;
  tone: 'models' | 'runtime';
  format: (b: number) => string;
}) {
  const pct = total > 0 ? Math.round((bytes / total) * 100) : 0;
  const barColor = tone === 'models' ? 'bg-teal-500' : 'bg-muted-foreground/50';
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">{format(bytes)}</span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}
