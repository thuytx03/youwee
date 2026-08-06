'use client'

import { useTimelineEngine, type Clip } from '@elah/editor'
import { Eraser, Loader2, MousePointerSquareDashed, Trash2, X } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import {
  useTextRegionStore,
  type CleanupMode,
} from '../textRegionStore'
import { useTextCleanup } from '../useTextCleanup'
import { Field } from './propertiesShared'

const MODES: CleanupMode[] = ['delogo', 'blur', 'fill']

/**
 * "Remove burned-in text" — mark rectangles over hardcoded subtitles and
 * re-encode the source without them.
 *
 * Only meaningful for video clips: the whole point is rewriting source pixels,
 * and an image clip has no timeline of frames to process.
 */
export function CleanupTab({ clip }: { clip: Clip }) {
  const { t } = useTranslation('pages')
  const engine = useTimelineEngine()

  const active = useTextRegionStore((s) => s.active)
  const regions = useTextRegionStore((s) => s.regions)
  const mode = useTextRegionStore((s) => s.mode)
  const setActive = useTextRegionStore((s) => s.setActive)
  const setMode = useTextRegionStore((s) => s.setMode)
  const removeRegion = useTextRegionStore((s) => s.removeRegion)
  const reset = useTextRegionStore((s) => s.reset)

  const { running, percent, run, cancel, blocked } = useTextCleanup(clip, engine)

  // Leaving the tab (or selecting a different clip) must drop draw mode, or the
  // overlay keeps swallowing pointer events over the preview.
  useEffect(() => {
    return () => setActive(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Regions are drawn against one clip's placement; switching clips invalidates
  // them, which setActive handles by clearing when the id changes.
  useEffect(() => {
    setActive(false, clip.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id])

  if (blocked === 'rotated') {
    return (
      <div className="text-xs text-ed-text-muted">{t('editor.cleanup.blocked_rotated')}</div>
    )
  }

  return (
    <>
      <div className="text-[11px] text-ed-text-muted mb-3">{t('editor.cleanup.intro')}</div>

      <button
        type="button"
        onClick={() => setActive(!active, clip.id)}
        disabled={running}
        className={cn(
          'mb-3 w-full inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs border transition-colors cursor-pointer disabled:opacity-40',
          active
            ? 'bg-ed-accent-soft text-ed-accent-hover border-ed-accent'
            : 'border-ed-border text-ed-text hover:bg-ed-elevated',
        )}
      >
        <MousePointerSquareDashed className="w-3.5 h-3.5" />
        {active ? t('editor.cleanup.drawingOn') : t('editor.cleanup.drawRegion')}
      </button>

      {active && (
        <div className="text-[11px] text-ed-text-muted mb-3">{t('editor.cleanup.drawHint')}</div>
      )}

      <Field label={t('editor.cleanup.regions', { count: regions.length })}>
        {regions.length === 0 ? (
          <div className="text-[11px] text-ed-text-muted">{t('editor.cleanup.noRegions')}</div>
        ) : (
          <div className="flex flex-col gap-1">
            {regions.map((r, i) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-2 rounded border border-ed-border px-2 py-1"
              >
                <span className="text-[11px] font-mono text-ed-text-muted">
                  #{i + 1} · {Math.round(r.w)}×{Math.round(r.h)}
                </span>
                <button
                  type="button"
                  onClick={() => removeRegion(r.id)}
                  disabled={running}
                  className="text-ed-text-muted hover:text-ed-text cursor-pointer disabled:opacity-40"
                  title={t('editor.cleanup.removeRegion')}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={reset}
              disabled={running}
              className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-ed-text-muted hover:text-ed-text cursor-pointer disabled:opacity-40"
            >
              <Trash2 size={11} /> {t('editor.cleanup.clearAll')}
            </button>
          </div>
        )}
      </Field>

      <Field label={t('editor.cleanup.mode')}>
        <div className="flex gap-1.5">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              disabled={running}
              className={cn(
                'flex-1 rounded-md px-1.5 py-1.5 text-[11px] border transition-colors cursor-pointer disabled:opacity-40',
                mode === m
                  ? 'bg-ed-accent-soft text-ed-accent-hover border-ed-accent'
                  : 'bg-ed-bg text-ed-text-muted border-ed-border hover:text-ed-text',
              )}
            >
              {t(`editor.cleanup.mode_${m}`)}
            </button>
          ))}
        </div>
      </Field>
      <div className="text-[11px] text-ed-text-muted -mt-1 mb-3">
        {t(`editor.cleanup.modeHint_${mode}`)}
      </div>

      {/* 'rotated' already returned above, so anything left is a media problem. */}
      {blocked && (
        <div className="text-[11px] text-[var(--elah-color-error)] mb-2">
          {t(`editor.cleanup.blocked_${blocked}`)}
        </div>
      )}

      {running ? (
        <>
          <div className="flex items-center gap-2 text-xs text-ed-text">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {t('editor.cleanup.running')}
          </div>
          <Progress value={percent} className="mt-2" />
          <div className="mt-1 text-right text-[10px] text-ed-text-muted tabular-nums">
            {percent}%
          </div>
          <button
            type="button"
            onClick={cancel}
            className="mt-2 w-full rounded-md px-3 py-2 text-xs border border-ed-border text-ed-text hover:bg-ed-elevated transition-colors cursor-pointer"
          >
            {t('editor.cleanup.cancel')}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void run()}
          disabled={regions.length === 0 || !!blocked}
          className="w-full inline-flex items-center justify-center gap-2 rounded-md px-3 py-2.5 text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          <Eraser className="w-3.5 h-3.5" /> {t('editor.cleanup.run')}
        </button>
      )}

      <div className="mt-2 text-[11px] text-ed-text-muted">{t('editor.cleanup.timeHint')}</div>
    </>
  )
}
