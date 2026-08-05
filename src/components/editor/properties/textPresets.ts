/**
 * Shared subtitle/text style templates and defaults.
 *
 * Lives outside both panels because two surfaces need it: the Subtitle panel
 * uses DEFAULT_SUBTITLE_STYLE when creating clips, and the properties panel
 * offers the presets as one-click templates for the selected clip. Keeping one
 * copy means the "sans" chip and a freshly created subtitle can't drift apart.
 */

/**
 * Track names for the two subtitle tracks. Stable identifiers, not UI strings —
 * they let the properties panel recognise a subtitle track it didn't create,
 * so they are deliberately not translated.
 */
export const ORIGINAL_TRACK_NAME = 'Subtitles (original)'
export const TRANSLATED_TRACK_NAME = 'Subtitles (translated)'
export const SUBTITLE_TRACK_NAMES = [ORIGINAL_TRACK_NAME, TRANSLATED_TRACK_NAME]

/**
 * Name of the generated voiceover track. Stable identifier for the same reason
 * as the subtitle names above: re-running the dub has to find the track from a
 * previous session (where no in-memory ref survives) so it replaces that
 * voiceover instead of stacking a second one beside it.
 */
export const VOICEOVER_TRACK_NAME = 'Voiceover'

export interface FontPreset {
  id: string
  fontFamily: string
  fontWeight: 'normal' | 'bold'
}

/**
 * Font presets for captions. Families are CSS stacks resolved by the renderer's
 * 2D canvas, so they stay inside fonts the OS already has — a webfont would not
 * be loaded at paint time and would silently fall back.
 */
export const FONT_PRESETS: FontPreset[] = [
  { id: 'sans', fontFamily: 'sans-serif', fontWeight: 'normal' },
  { id: 'sansBold', fontFamily: 'sans-serif', fontWeight: 'bold' },
  { id: 'serif', fontFamily: 'serif', fontWeight: 'normal' },
  { id: 'serifBold', fontFamily: 'Georgia, serif', fontWeight: 'bold' },
  { id: 'mono', fontFamily: 'monospace', fontWeight: 'normal' },
  { id: 'impact', fontFamily: 'Impact, Haettenschweiler, sans-serif', fontWeight: 'normal' },
]

export interface BgPreset {
  id: string
  /** null means no backdrop at all. */
  bg: { color: string; opacity: number } | null
  /** Text color paired with this backdrop so captions stay readable. */
  textColor: string
}

/**
 * Caption background presets. Stored as hex + opacity so they round-trip
 * through the same hexToRgba path as the manual color picker.
 */
export const BG_PRESETS: BgPreset[] = [
  { id: 'none', bg: null, textColor: '#ffffff' },
  { id: 'black', bg: { color: '#000000', opacity: 0.6 }, textColor: '#ffffff' },
  { id: 'blackSolid', bg: { color: '#000000', opacity: 1 }, textColor: '#ffffff' },
  { id: 'white', bg: { color: '#ffffff', opacity: 0.85 }, textColor: '#111111' },
  { id: 'yellow', bg: { color: '#facc15', opacity: 0.9 }, textColor: '#111111' },
  { id: 'red', bg: { color: '#dc2626', opacity: 0.85 }, textColor: '#ffffff' },
  { id: 'blue', bg: { color: '#2563eb', opacity: 0.85 }, textColor: '#ffffff' },
  { id: 'green', bg: { color: '#16a34a', opacity: 0.85 }, textColor: '#ffffff' },
]

/**
 * Style a freshly created subtitle clip starts with. The style *controls* live
 * in the properties panel (per selected clip), so these are creation-time
 * defaults only — position is still tracked in the panel because dragging a
 * caption on the preview feeds the chosen position back into it.
 */
export const DEFAULT_SUBTITLE_STYLE = {
  fontSize: 42,
  color: '#ffffff',
  fontFamily: FONT_PRESETS[0].fontFamily,
  fontWeight: FONT_PRESETS[0].fontWeight,
  /** undefined = no backdrop, matching the 'none' background preset. */
  backgroundColor: undefined as string | undefined,
} as const

/**
 * Reference stage the default font size and caption position are tuned for:
 * a 1080-wide vertical frame, which is what the editor opens with.
 */
const REFERENCE_STAGE_WIDTH = 1080

/** Fraction of the frame height a caption sits above the bottom edge. */
const CAPTION_BOTTOM_INSET = 0.14

/**
 * Fit a caption to the *video picture* rather than the whole stage.
 *
 * A clip whose aspect differs from the stage is letterboxed (the renderer
 * contains it — see resolveDrawRect), so a 9:16 video inside a 16:9 stage only
 * covers the middle ~32% of the width. Text, however, is laid out against the
 * stage: it wraps at 90% of stage width and `transform.x/y` are normalized to
 * stage size. Left alone, captions spill across the black bars and drift away
 * from the bottom of the picture whenever the aspect ratio changes.
 *
 * So derive both the size and the position from the contained video rect:
 *  - `fontSize` scales with the picture's width, keeping captions the same
 *    relative size in the frame the viewer actually sees.
 *  - `y` is placed a fixed fraction above the picture's bottom edge, not the
 *    stage's, so the caption hugs the video in every aspect ratio.
 *
 * Pass the video's intrinsic size; with it unknown, the clip fills the stage
 * and the stage itself is the picture.
 */
export function fitCaptionToVideo(
  stage: { width: number; height: number },
  video?: { width?: number; height?: number },
): { fontSize: number; x: number; y: number } {
  let pictureWidth = stage.width
  let pictureHeight = stage.height

  if (video?.width && video?.height) {
    // Same contain math the renderer uses: scale to the limiting axis.
    const scale = Math.min(stage.width / video.width, stage.height / video.height)
    pictureWidth = video.width * scale
    pictureHeight = video.height * scale
  }

  const fontSize = Math.max(
    12,
    Math.round(DEFAULT_SUBTITLE_STYLE.fontSize * (pictureWidth / REFERENCE_STAGE_WIDTH)),
  )

  // Bottom of the picture in normalized stage coords (the letterbox bars split
  // the leftover height evenly, so the picture is vertically centred).
  const pictureBottom = stage.height > 0 ? (stage.height + pictureHeight) / 2 / stage.height : 1
  const insetInStageUnits =
    stage.height > 0 ? CAPTION_BOTTOM_INSET * (pictureHeight / stage.height) : CAPTION_BOTTOM_INSET

  return { fontSize, x: 0.5, y: Math.min(0.98, pictureBottom - insetInStageUnits) }
}
