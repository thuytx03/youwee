'use client'

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { transformFromContainRect } from '@elah/core'
import {
  useMediaLibraryStore,
  useTimelineEngine,
  useTracksStore,
  type Clip,
} from '@elah/editor'
import { Maximize2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CleanupTab } from './CleanupTab'
import {
  PANEL,
  PanelHeader,
  Field,
  NumberField,
  SliderRow,
  mergeTransform,
} from './propertiesShared'

type Tab = 'transform' | 'style' | 'cleanup'

export function VideoClipProperties({ clip }: { clip: Clip }) {
  const { t } = useTranslation('pages')
  // Cleanup rewrites source pixels, which only means something for a video —
  // this component also serves image clips (see ClipProperties).
  const isVideo = clip.type === 'video'
  const TABS: { id: Tab; label: string }[] = [
    { id: 'transform', label: t('editor.ui.transform') },
    { id: 'style', label: t('editor.ui.style') },
    ...(isVideo ? [{ id: 'cleanup' as Tab, label: t('editor.cleanup.tab') }] : []),
  ]
  const engine = useTimelineEngine()
  const [local, setLocal] = useState<Partial<Clip>>({})
  const [tab, setTab] = useState<Tab>('transform')

  useEffect(() => { setLocal({}) }, [clip.id])

  const effective = { ...clip, ...local }

  const commit = (updates: Partial<Clip>) => {
    setLocal((prev) => ({ ...prev, ...updates }))
    engine.updateClip(clip.id, clip.trackId, updates)
  }

  const startSec = (clip.startFrame / 30).toFixed(0)
  const endSec = ((clip.startFrame + clip.durationFrames) / 30).toFixed(0)

  const tf = mergeTransform(effective)
  const setTf = (patch: Partial<ReturnType<typeof mergeTransform>>) =>
    setLocal((p) => ({ ...p, transform: { ...mergeTransform(effective), ...patch } }))
  const commitTf = () => commit({ transform: mergeTransform(effective) })

  // Scale + center the clip so it fits entirely inside the stage (letterboxed,
  // never cropped), using the source video's real pixel dimensions.
  const stage = useTracksStore((s) => s.stage)
  const handleFitToFrame = () => {
    const asset = clip.assetId ? useMediaLibraryStore.getState().getAsset(clip.assetId) : undefined
    const contentWidth = asset?.width
    const contentHeight = asset?.height
    if (!contentWidth || !contentHeight) return
    const transform = transformFromContainRect(contentWidth, contentHeight, stage.width, stage.height)
    commit({ transform: { ...transform, rotation: tf.rotation } })
  }

  return (
    <div className={cn(PANEL, 'overflow-hidden')}>
      <PanelHeader
        subtitle={`${clip.name} · 0:${startSec.padStart(2, '0')}–0:${endSec.padStart(2, '0')}`}
      />

      <div className="flex items-center gap-4 px-4 border-b border-ed-border shrink-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              'relative py-2.5 text-xs transition-colors',
              tab === t.id ? 'text-ed-text' : 'text-ed-text-muted hover:text-ed-text',
            )}
          >
            {t.label}
            {tab === t.id && (
              <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-ed-accent rounded-full" />
            )}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto p-4">
        {tab === 'transform' && (
          <>
            <button
              type="button"
              onClick={handleFitToFrame}
              className="mb-3 w-full inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs border border-ed-border text-ed-text hover:bg-ed-elevated transition-colors"
            >
              <Maximize2 className="w-3.5 h-3.5" /> {t('editor.ui.fitToFrame')}
            </button>
            <SliderRow
              label={t('editor.ui.scale')}
              value={tf.scale}
              display={`${Math.round(tf.scale * 100)}%`}
              min={0.05}
              max={4}
              step={0.01}
              onChange={(v) => setTf({ scale: v })}
            />
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('editor.ui.positionX')}>
                <NumberField
                  value={Math.round(tf.x * 100)}
                  step={1}
                  suffix="%"
                  onChange={(v) => setTf({ x: v / 100 })}
                  onCommit={commitTf}
                />
              </Field>
              <Field label={t('editor.ui.positionY')}>
                <NumberField
                  value={Math.round(tf.y * 100)}
                  step={1}
                  suffix="%"
                  onChange={(v) => setTf({ y: v / 100 })}
                  onCommit={commitTf}
                />
              </Field>
            </div>
            <Field label={t('editor.ui.rotate')}>
              <NumberField
                value={Math.round((tf.rotation * 180) / Math.PI)}
                step={1}
                suffix="°"
                onChange={(v) => setTf({ rotation: (v * Math.PI) / 180 })}
                onCommit={commitTf}
              />
            </Field>
          </>
        )}

        {tab === 'style' && (
          <SliderRow
            label={t('editor.ui.opacity')}
            value={effective.opacity ?? 1}
            display={`${Math.round((effective.opacity ?? 1) * 100)}%`}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => commit({ opacity: v })}
          />
        )}

        {tab === 'cleanup' && isVideo && <CleanupTab clip={clip} />}
      </div>
    </div>
  )
}
