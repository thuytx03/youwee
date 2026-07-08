'use client'

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTimelineEngine, type Clip } from '@elah/editor'
import { cn } from '@/lib/utils'
import {
  PANEL,
  PanelHeader,
  Field,
  NumberField,
  SliderRow,
  mergeTransform,
} from './propertiesShared'

type Tab = 'transform' | 'style'

export function VideoClipProperties({ clip }: { clip: Clip }) {
  const { t } = useTranslation('pages')
  const TABS: { id: Tab; label: string }[] = [
    { id: 'transform', label: t('editor.ui.transform') },
    { id: 'style', label: t('editor.ui.style') },
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
      </div>
    </div>
  )
}
