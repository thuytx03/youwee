'use client'

import { useTracksStore, useTimelineEngine, type Clip } from '@elah/editor'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/components/ui/toast'
import { SUBTITLE_TRACK_NAMES } from './textPresets'

/** Style fields propagated to sibling subtitles. Position is deliberately absent. */
const STYLE_FIELDS = [
  'fontSize',
  'color',
  'fontFamily',
  'fontWeight',
  'textAlign',
  'backgroundColor',
  'backgroundPadding',
  'opacity',
] as const

/**
 * "Make every subtitle look like this one."
 *
 * Renders nothing unless the selected clip sits on a subtitle track, so regular
 * text overlays never see it. Writes style only — never `transform` — because a
 * bulk restyle must not yank captions out of the position the user placed them
 * in. (The mirror image lives in SubtitleDubPanel: dragging a caption offers to
 * propagate position only, never style.)
 */
export function ApplyToAllSubtitles({ clip }: { clip: Clip }) {
  const { t } = useTranslation('pages')
  const engine = useTimelineEngine()
  const toast = useToast()
  const tracks = useTracksStore((s) => s.tracks)

  const subtitleTrackIds = tracks
    .filter((tr) => tr.kind === 'elements' && SUBTITLE_TRACK_NAMES.includes(tr.name))
    .map((tr) => tr.id)

  // Not a subtitle clip → this action is meaningless here.
  if (!subtitleTrackIds.includes(clip.trackId)) return null

  const apply = () => {
    const patch: Partial<Clip> = {}
    for (const key of STYLE_FIELDS) {
      // Assigning undefined is intentional for backgroundColor: it clears the
      // backdrop on siblings that have one when the source clip has none.
      ;(patch as Record<string, unknown>)[key] = clip[key]
    }

    let count = 0
    engine.batch(() => {
      for (const trackId of subtitleTrackIds) {
        for (const c of engine.getClipsOnTrack(trackId)) {
          if (c.type !== 'text' || c.id === clip.id) continue
          engine.updateClip(c.id, trackId, patch)
          count += 1
        }
      }
    }, 'Apply subtitle style to all')

    toast.success({ title: t('editor.ui.appliedStyleToAll', { count }) })
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={apply}
        className="w-full rounded-md px-3 py-2 text-xs border border-ed-border text-ed-text hover:bg-ed-elevated transition-colors cursor-pointer"
      >
        {t('editor.ui.applyStyleToAllSubtitles')}
      </button>
      <div className="text-[11px] text-ed-text-muted mt-1.5">
        {t('editor.ui.applyStyleToAllSubtitlesHint')}
      </div>
    </div>
  )
}
