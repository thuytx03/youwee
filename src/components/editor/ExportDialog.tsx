import type { Project } from '@elah/editor';
import { exportVideo } from '@elah/editor';
import { FolderOpen, Loader2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import {
  pickProcessingOutputDirectory,
  revealOutputInFolder,
  saveEditorExport,
} from '@/contexts/editor/editor-client';

/**
 * Output heights offered. The width follows the project's aspect ratio, so these
 * work for both landscape and vertical projects.
 */
const RESOLUTIONS = [480, 720, 1080, 1440, 2160] as const;

/** Bitrate presets in bits/s, paired with a plain-language quality label. */
const QUALITY = [
  { id: 'low', bitrate: 4_000_000 },
  { id: 'medium', bitrate: 8_000_000 },
  { id: 'high', bitrate: 16_000_000 },
] as const;

function sanitizeFilename(name: string): string {
  // Strip path separators and characters Windows rejects, keep it recognisable.
  return name.replace(/[/\\:*?"<>|]/g, '').trim() || 'export';
}

/** Rough size estimate so the user can sanity-check before committing. */
function estimateSizeMb(bitrate: number, durationSec: number): number {
  return ((bitrate + 128_000) * durationSec) / 8 / 1_000_000;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project | null;
  /** Draft name, used as the default filename. */
  defaultName: string;
}

export function ExportDialog({ open, onOpenChange, project, defaultName }: Props) {
  const { t } = useTranslation('pages');
  const toast = useToast();

  const [filename, setFilename] = useState(defaultName);
  const [outputHeight, setOutputHeight] = useState<number>(1080);
  const [quality, setQuality] = useState<(typeof QUALITY)[number]['id']>('medium');
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [frame, setFrame] = useState(0);
  const [totalFrames, setTotalFrames] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'rendering' | 'saving'>('idle');
  const abortRef = useRef<AbortController | null>(null);

  const stage = project?.stage;
  const fps = project?.fps ?? 30;

  // Longest clip end across all tracks = the exported duration.
  const durationSec = useMemo(() => {
    if (!project) return 0;
    let end = 0;
    for (const clips of Object.values(project.clips)) {
      for (const c of clips) end = Math.max(end, c.startFrame + c.durationFrames);
    }
    return end / fps;
  }, [project, fps]);

  // Default the resolution to the project's own height, and only offer sizes
  // that don't upscale beyond it — exporting a 1080p project at 4K just wastes
  // bytes on interpolated pixels.
  useEffect(() => {
    if (!open || !stage) return;
    setOutputHeight(stage.height);
    setFilename(sanitizeFilename(defaultName));
  }, [open, stage, defaultName]);

  const options = useMemo(
    () => RESOLUTIONS.filter((h) => !stage || h <= stage.height),
    [stage],
  );
  const resolutionChoices = options.length > 0 ? options : [stage?.height ?? 1080];

  const bitrate = QUALITY.find((q) => q.id === quality)?.bitrate ?? 8_000_000;
  const outputWidth = stage
    ? Math.round((outputHeight * stage.width) / stage.height / 2) * 2
    : 0;

  const pickDir = async () => {
    const dir = await pickProcessingOutputDirectory();
    if (dir) setOutputDir(dir);
    return dir;
  };

  const handleExport = async () => {
    if (!project || exporting) return;
    const dir = outputDir ?? (await pickDir());
    if (!dir) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setExporting(true);
    setPhase('rendering');
    setFrame(0);
    setTotalFrames(0);

    try {
      const blob = await exportVideo(project, {
        videoCodec: 'avc',
        outputHeight,
        videoBitrate: bitrate,
        signal: controller.signal,
        onProgress: (p) => {
          setFrame(p.frame);
          setTotalFrames(p.totalFrames);
        },
        onAudioIssue: (message, src) =>
          console.warn('[export] audio clip skipped', message, src),
      });

      setPhase('saving');
      const outputPath = `${dir.replace(/[/\\]+$/, '')}/${sanitizeFilename(filename)}.mp4`;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const saved = await saveEditorExport({ bytes, outputPath, inputName: 'timeline' });

      onOpenChange(false);
      toast.success({
        title: t('editor.export.done'),
        message: `${(blob.size / 1_000_000).toFixed(1)} MB`,
        action: {
          label: t('editor.export.openFolder'),
          onClick: () => void revealOutputInFolder(saved),
        },
      });
    } catch (e) {
      if (controller.signal.aborted) {
        toast.info({ title: t('editor.export.cancelled') });
      } else {
        toast.error({ title: t('editor.export.failed'), message: String(e) });
      }
    } finally {
      setExporting(false);
      setPhase('idle');
      abortRef.current = null;
    }
  };

  const percent = totalFrames > 0 ? Math.round((frame / totalFrames) * 100) : 0;
  const row = 'flex items-center justify-between gap-3 py-2';
  const label = 'text-xs text-muted-foreground';

  return (
    <Dialog
      open={open}
      // Closing mid-export would orphan the worker, so require an explicit cancel.
      onOpenChange={(next) => !exporting && onOpenChange(next)}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t('editor.export.title')}</DialogTitle>
        </DialogHeader>

        {exporting ? (
          <div className="py-2">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              {phase === 'saving'
                ? t('editor.export.saving')
                : t('editor.export.rendering', { frame, total: totalFrames || '…' })}
            </div>
            <Progress value={percent} className="mt-3" />
            <div className="mt-1 text-right text-[11px] text-muted-foreground tabular-nums">
              {percent}%
            </div>
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="mt-4 w-full inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm border border-border hover:bg-accent transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" /> {t('editor.export.cancel')}
            </button>
          </div>
        ) : (
          <>
            <div className="divide-y divide-border/60">
              <div className={row}>
                <span className={label}>{t('editor.export.name')}</span>
                <input
                  value={filename}
                  onChange={(e) => setFilename(e.target.value)}
                  className="flex-1 max-w-[240px] rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
                />
              </div>

              <div className={row}>
                <span className={label}>{t('editor.export.resolution')}</span>
                <Select
                  value={String(outputHeight)}
                  onValueChange={(v) => setOutputHeight(Number(v))}
                >
                  <SelectTrigger className="w-[150px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {resolutionChoices.map((h) => (
                      <SelectItem key={h} value={String(h)}>
                        {h}p{stage && h === stage.height ? ` · ${t('editor.export.native')}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className={row}>
                <span className={label}>{t('editor.export.quality')}</span>
                <Select value={quality} onValueChange={(v) => setQuality(v as typeof quality)}>
                  <SelectTrigger className="w-[150px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {QUALITY.map((q) => (
                      <SelectItem key={q.id} value={q.id}>
                        {t(`editor.export.quality_${q.id}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className={row}>
                <span className={label}>{t('editor.export.location')}</span>
                <button
                  type="button"
                  onClick={() => void pickDir()}
                  title={outputDir ?? undefined}
                  className="flex-1 max-w-[240px] inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent transition-colors cursor-pointer"
                >
                  <FolderOpen className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">
                    {outputDir ?? t('editor.export.chooseFolder')}
                  </span>
                </button>
              </div>
            </div>

            {/* Summary — the numbers a user checks before a long render. */}
            <div className="mt-1 rounded-md bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
              {outputWidth > 0 && (
                <div>
                  {outputWidth}×{outputHeight} · {fps} fps · {durationSec.toFixed(1)}s
                </div>
              )}
              <div>
                ≈ {estimateSizeMb(bitrate, durationSec).toFixed(0)} MB{' '}
                {t('editor.export.estimated')}
              </div>
            </div>

            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={!project || durationSec === 0}
              className="mt-3 w-full rounded-md px-3 py-2.5 text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {t('editor.export.start')}
            </button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
