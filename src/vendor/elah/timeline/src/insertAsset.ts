import type {
  Clip,
  ClipType,
  MediaAsset,
  MediaKind,
  TimelineEngine,
  Track,
  TrackKind,
} from '@elah/core'
import { clipsOverlap, secondsToFrames, useMediaLibraryStore, usePlaybackStore } from '@elah/core'
import { useAudioDropDialogStore } from './audioDropDialog.store'
import type { DragElementPayload } from './elementDrag'

/** Default on-timeline length for a freshly inserted synthetic element, in seconds. */
const DEFAULT_TEXT_DURATION_SEC = 3

/**
 * Lanes whose contents a host regenerates wholesale (subtitles, voiceover) and
 * which therefore must not receive hand-added clips — anything placed there
 * would be wiped on the next generate. Matched by name because the track model
 * has no "managed" flag.
 */
const AUTO_LANE_NAME_PATTERN = /^(subtitles|voiceover)\b/i

type MediaClipType = Extract<ClipType, 'video' | 'audio' | 'image'>

export interface InsertAssetOptions {
  desiredStartFrame?: number
  targetTrackId?: string
  /**
   * Mark a track as reserved so automatic lane selection skips it. Use for lanes
   * the host manages itself (a dedicated subtitle track, for example) which
   * should not receive hand-added clips even when they are free at that moment.
   * Ignored when `targetTrackId` names a track explicitly.
   */
  reserveTrack?: (track: Track) => boolean
}

export type InsertAssetFailureReason =
  | 'missing-asset'
  | 'no-track'
  | 'locked'
  | 'incompatible-track'
  | 'cancelled'

export type InsertedKind = MediaKind | 'element'

export type InsertAssetResult =
  | {
      ok: true
      kind: InsertedKind
      trackId: string
      clipIds: string[]
    }
  | {
      ok: false
      kind: InsertedKind
      reason: InsertAssetFailureReason
    }

interface TargetResolution {
  ok: true
  trackId: string
  created: boolean
}

interface TargetRefusal {
  ok: false
  reason: Exclude<InsertAssetFailureReason, 'missing-asset' | 'cancelled'>
}

/**
 * Resolve a drop position so the new clip never overlaps an existing one.
 *
 * - If there's no overlap at desiredStart -> returns unchanged.
 * - If the drop lands in a gap that's too small for the clip -> trims to fill
 *   exactly that gap.
 * - If the drop lands on top of an existing clip -> pushes start to just after
 *   the last overlapping clip, trimming if the next clip immediately follows.
 */
export function resolveDropPosition(
  existingClips: { startFrame: number; durationFrames: number }[],
  desiredStart: number,
  durationFrames: number,
): { startFrame: number; durationFrames: number } {
  const sorted = [...existingClips].sort((a, b) => a.startFrame - b.startFrame)

  const overlapping = sorted.filter((c) =>
    clipsOverlap(c, { startFrame: desiredStart, durationFrames }),
  )

  if (overlapping.length === 0) return { startFrame: desiredStart, durationFrames }

  const firstOverlap = overlapping[0]

  if (desiredStart < firstOverlap.startFrame) {
    const prevEnd = Math.max(
      0,
      ...sorted
        .filter((c) => c.startFrame + c.durationFrames <= desiredStart)
        .map((c) => c.startFrame + c.durationFrames),
    )
    const gapSize = firstOverlap.startFrame - prevEnd
    return { startFrame: prevEnd, durationFrames: Math.min(durationFrames, gapSize) }
  }

  // Walk forward through the whole contiguous run starting at the overlap,
  // extending the end every time another clip starts at-or-before it. Without
  // this, a chain of back-to-back clips (zero gap between them) stops at the
  // first internal boundary and returns a zero-width placement instead of
  // skipping past the whole run to its actual end.
  let lastOverlapEnd = Math.max(...overlapping.map((c) => c.startFrame + c.durationFrames))
  for (const c of sorted) {
    if (c.startFrame <= lastOverlapEnd && c.startFrame + c.durationFrames > lastOverlapEnd) {
      lastOverlapEnd = c.startFrame + c.durationFrames
    }
  }

  const nextClip = sorted.find((c) => c.startFrame >= lastOverlapEnd)
  if (nextClip) {
    const available = nextClip.startFrame - lastOverlapEnd
    return { startFrame: lastOverlapEnd, durationFrames: Math.min(durationFrames, available) }
  }
  return { startFrame: lastOverlapEnd, durationFrames }
}

/**
 * Adjust a cursor-derived drop frame before overlap resolution runs.
 *
 * Pointer drops are pixel-accurate, which is wrong at the two places users
 * actually aim for. At typical zoom a whole second is only a pixel or two wide,
 * so the snap window to the origin is impossible to hit by hand:
 *
 * - Empty track -> frame 0. Dropping onto an empty lane means "start here";
 *   honouring the cursor strands the very first clip behind dead air.
 * - Past the last clip -> abut that clip, so appending never leaves a gap.
 * - Anywhere else (a real gap, or over an existing clip) -> unchanged, leaving
 *   `resolveDropPosition` to push or trim exactly as before.
 *
 * Only pointer drops call this. Playhead-based insertion keeps its own contract
 * of landing precisely on `currentFrame`, empty track or not.
 */
export function resolveDropFrame(
  existingClips: { startFrame: number; durationFrames: number }[],
  desiredStart: number,
  durationFrames: number,
): number {
  if (existingClips.length === 0) return 0

  const overlapping = existingClips.some((c) =>
    clipsOverlap(c, { startFrame: desiredStart, durationFrames }),
  )
  if (overlapping) return desiredStart

  const lastEnd = Math.max(...existingClips.map((c) => c.startFrame + c.durationFrames))
  return desiredStart > lastEnd ? lastEnd : desiredStart
}

/** Map MediaAsset kind to ClipType (identical for video/audio/image). */
function mediaKindToClipType(kind: MediaKind): MediaClipType {
  return kind
}

/** Whether a media asset can be placed on a track of the given kind. */
export function isCompatibleTrackKind(trackKind: TrackKind, mediaKind: MediaKind): boolean {
  if (trackKind === 'audio') return mediaKind === 'audio'
  if (trackKind === 'video') return mediaKind === 'video' || mediaKind === 'image'
  return false
}

function currentDesiredStart(opts: InsertAssetOptions | undefined): number {
  return opts?.desiredStartFrame ?? usePlaybackStore.getState().currentFrame
}

function getProjectTracks(engine: TimelineEngine): Track[] {
  return engine.getProject().tracks
}

function getTrack(engine: TimelineEngine, trackId: string): Track | undefined {
  return getProjectTracks(engine).find((t) => t.id === trackId)
}

function clipsOn(engine: TimelineEngine, trackId: string): Clip[] {
  return engine.getProject().clips[trackId] ?? []
}

function compatibleTracks(engine: TimelineEngine, mediaKind: MediaKind): Track[] {
  return getProjectTracks(engine).filter((t) => isCompatibleTrackKind(t.kind, mediaKind))
}

/**
 * Ensure auto-created audio lanes do not route new clips into a locked lane.
 * If every existing audio lane is locked, insertion refuses instead of silently
 * bypassing the user's lock by creating another lane.
 */
function ensureAudioTrack(engine: TimelineEngine): TargetResolution | TargetRefusal {
  const audioTracks = getProjectTracks(engine).filter((t) => t.kind === 'audio')
  const unlocked = audioTracks.find((t) => !t.locked)
  if (unlocked) return { ok: true, trackId: unlocked.id, created: false }
  if (audioTracks.length > 0) return { ok: false, reason: 'locked' }
  return { ok: true, trackId: engine.addTrack('audio').id, created: true }
}

/**
 * Elements tracks are optional in host apps, so tap insertion can create the
 * first one while still respecting an intentional all-locked elements setup.
 */
function ensureElementsTrack(engine: TimelineEngine): TargetResolution | TargetRefusal {
  const elementTracks = getProjectTracks(engine).filter((t) => t.kind === 'elements')
  const unlocked = elementTracks.find((t) => !t.locked)
  if (unlocked) return { ok: true, trackId: unlocked.id, created: false }
  if (elementTracks.length > 0) return { ok: false, reason: 'locked' }
  return { ok: true, trackId: engine.addTrack('elements').id, created: true }
}

function resolveMediaTarget(
  engine: TimelineEngine,
  mediaKind: MediaKind,
  targetTrackId: string | undefined,
): TargetResolution | TargetRefusal {
  if (targetTrackId) {
    const track = getTrack(engine, targetTrackId)
    if (!track) return { ok: false, reason: 'no-track' }
    if (track.locked) return { ok: false, reason: 'locked' }
    if (!isCompatibleTrackKind(track.kind, mediaKind)) {
      return { ok: false, reason: 'incompatible-track' }
    }
    return { ok: true, trackId: track.id, created: false }
  }

  const unlocked = compatibleTracks(engine, mediaKind).find((t) => !t.locked)
  if (unlocked) return { ok: true, trackId: unlocked.id, created: false }

  if (mediaKind === 'audio') return ensureAudioTrack(engine)

  const existingCompatible = compatibleTracks(engine, mediaKind)
  if (existingCompatible.some((t) => t.locked)) return { ok: false, reason: 'locked' }
  return { ok: false, reason: 'no-track' }
}

function resolveElementTarget(
  engine: TimelineEngine,
  targetTrackId: string | undefined,
): TargetResolution | TargetRefusal {
  if (targetTrackId) {
    const track = getTrack(engine, targetTrackId)
    if (!track) return { ok: false, reason: 'no-track' }
    if (track.locked) return { ok: false, reason: 'locked' }
    if (track.kind !== 'elements') return { ok: false, reason: 'incompatible-track' }
    return { ok: true, trackId: track.id, created: false }
  }

  const unlocked = getProjectTracks(engine).find((t) => t.kind === 'elements' && !t.locked)
  if (unlocked) return { ok: true, trackId: unlocked.id, created: false }
  return ensureElementsTrack(engine)
}

/** Resolve a non-overlapping placement for `desired` on a track. */
function resolveOn(
  engine: TimelineEngine,
  trackId: string,
  desired: number,
  durationFrames: number,
) {
  return resolveDropPosition(clipsOn(engine, trackId), desired, durationFrames)
}

/** Whether a clip of this length would sit free at `desired` on the track. */
function isFreeAt(
  engine: TimelineEngine,
  trackId: string,
  desired: number,
  durationFrames: number,
): boolean {
  return !clipsOn(engine, trackId).some((c) =>
    clipsOverlap(c, { startFrame: desired, durationFrames }),
  )
}

/**
 * Pick the first track of `kind` that is actually free at `desired`, so tapping
 * several elements without moving the playhead stacks them on parallel lanes
 * instead of queueing them one after another on the first lane.
 *
 * `skip` excludes lanes the caller owns for another purpose — a host that keeps
 * a dedicated subtitle lane, say, does not want a hand-added text element
 * landing in it just because that lane happened to be free.
 *
 * Returns undefined when every eligible lane is busy there.
 */
function findFreeTrack(
  engine: TimelineEngine,
  kind: TrackKind,
  desired: number,
  durationFrames: number,
  skip?: (track: Track) => boolean,
): string | undefined {
  for (const track of getProjectTracks(engine)) {
    if (track.kind !== kind || track.locked) continue
    if (skip?.(track)) continue
    if (isFreeAt(engine, track.id, desired, durationFrames)) return track.id
  }
  return undefined
}

/**
 * Next free lane of `kind` at `desired`, creating one when they are all busy.
 *
 * Layering is the point of an overlay track: adding a caption on top of a title
 * on top of a shape at the same moment should just work, rather than being
 * capped by however many lanes the host happened to seed. Returns undefined only
 * if a new lane could not be created.
 */
function acquireFreeTrack(
  engine: TimelineEngine,
  kind: TrackKind,
  desired: number,
  durationFrames: number,
  skip?: (track: Track) => boolean,
): { trackId: string; created: boolean } | undefined {
  // Auto-generated lanes are reserved by default: a host that names a track
  // "Subtitles (original)" is managing its contents itself, and dropping a
  // hand-added title into it would be replaced on the next subtitle run.
  const reserved = skip ?? ((t: Track) => AUTO_LANE_NAME_PATTERN.test(t.name))
  const free = findFreeTrack(engine, kind, desired, durationFrames, reserved)
  if (free) return { trackId: free, created: false }

  // Number the new lane against lanes sharing its prefix, not every track of
  // this kind — otherwise a host-managed "Subtitles" lane inflates the count and
  // the sequence reads "Elements, Elements 2, Elements 4".
  const base = kind === 'elements' ? 'Elements' : 'Audio'
  const prefixed = getProjectTracks(engine).filter(
    (t) => t.kind === kind && t.name.startsWith(base),
  )
  try {
    return {
      trackId: engine.addTrack(kind, { name: `${base} ${prefixed.length + 1}` }).id,
      created: true,
    }
  } catch {
    return undefined
  }
}

/** Add one media clip. MediaKind is never text, so `src` is always valid. */
function addMediaClip(
  engine: TimelineEngine,
  trackId: string,
  type: MediaClipType,
  asset: MediaAsset,
  startFrame: number,
  durationFrames: number,
) {
  return engine.addClip({
    trackId,
    type,
    name: asset.name,
    startFrame,
    durationFrames,
    src: asset.src,
    assetId: asset.id,
  })
}

function addElementClip(
  engine: TimelineEngine,
  trackId: string,
  payload: DragElementPayload,
  startFrame: number,
  durationFrames: number,
) {
  const existing = clipsOn(engine, trackId)
  const n = existing.length + 1

  if (payload.element === 'text') {
    return engine.addClip({
      trackId,
      type: 'text',
      name: `Text ${n}`,
      startFrame,
      durationFrames,
      text: {
        content: `Text ${n}`,
        fontSize: 200,
        color: '#ffffff',
        fontFamily: 'sans-serif',
        fontWeight: 'normal',
        textAlign: 'center',
      },
    })
  }

  if (payload.element === 'shape') {
    const shapeKind = payload.shapeVariant ?? 'rect'
    return engine.addClip({
      trackId,
      type: 'shape',
      name: `${shapeKind.charAt(0).toUpperCase() + shapeKind.slice(1)} ${n}`,
      startFrame,
      durationFrames,
      // Explicit transform matches ShapeLayer's render defaults so the canvas,
      // selection overlay, and Transform properties panel agree immediately.
      transform: { x: 0.5, y: 0.5, scale: 0.5, rotation: 0, anchor: { x: 0.5, y: 0.5 } },
      shape: {
        shapeKind,
        shapeFill: 'transparent',
        shapeStroke: '#4f9cf9',
        shapeStrokeWidth: 4,
      },
    })
  }

  return engine.addClip({
    trackId,
    type: 'freehand',
    name: `Drawing ${n}`,
    startFrame,
    durationFrames,
    freehand: {
      pathData: '',
      strokeColor: '#ffffff',
      strokeWidth: 4,
    },
  })
}

function mediaRefusal(
  kind: MediaKind,
  reason: InsertAssetFailureReason,
): InsertAssetResult {
  return { ok: false, kind, reason }
}

function elementRefusal(reason: InsertAssetFailureReason): InsertAssetResult {
  return { ok: false, kind: 'element', reason }
}

/**
 * Insert a media asset using the same adapter that backs timeline drag-drop.
 * The helper owns target-track lookup for tap insertion, keeping SDK panels
 * from duplicating timeline placement and audio-dialog rules.
 */
export async function insertMediaAsset(
  engine: TimelineEngine,
  assetId: string,
  opts: InsertAssetOptions = {},
): Promise<InsertAssetResult> {
  const asset = useMediaLibraryStore.getState().getAsset(assetId)
  if (!asset) return mediaRefusal('video', 'missing-asset')

  const target = resolveMediaTarget(engine, asset.kind, opts.targetTrackId)
  if (!target.ok) return mediaRefusal(asset.kind, target.reason)

  const desiredStart = currentDesiredStart(opts)
  const fps = engine.getProject().fps
  const fullDuration = Math.max(
    1,
    asset.durationSec > 0 ? secondsToFrames(asset.durationSec, fps) : fps * 5,
  )

  if (asset.kind !== 'video' || !asset.hasAudio) {
    const run = (): InsertAssetResult => {
      // Audio layers, so tap insertion picks a lane free at this moment (adding
      // one if needed) instead of queueing the second sound after the first.
      // Video is a single lane by model, and an explicit drop target always wins.
      const trackId =
        (!opts.targetTrackId && asset.kind === 'audio'
          ? acquireFreeTrack(engine, 'audio', desiredStart, fullDuration, opts.reserveTrack)
              ?.trackId
          : undefined) ?? target.trackId

      const r = resolveOn(engine, trackId, desiredStart, fullDuration)
      const clip = addMediaClip(
        engine,
        trackId,
        mediaKindToClipType(asset.kind),
        asset,
        r.startFrame,
        r.durationFrames,
      )
      return { ok: true, kind: asset.kind, trackId, clipIds: [clip.id] }
    }

    // Always batched: run() may add an audio lane, and that lane plus the clip
    // must collapse into one undo entry.
    let result: InsertAssetResult = mediaRefusal(asset.kind, 'no-track')
    engine.batch(() => {
      result = run()
    }, 'Add media')
    return result
  }

  const choice = await useAudioDropDialogStore.getState().request(asset.name)
  if (!choice) return mediaRefusal(asset.kind, 'cancelled')

  let result: InsertAssetResult = mediaRefusal(asset.kind, 'cancelled')
  engine.batch(() => {
    if (choice === 'video-only') {
      const v = resolveOn(engine, target.trackId, desiredStart, fullDuration)
      const clip = addMediaClip(engine, target.trackId, 'video', asset, v.startFrame, v.durationFrames)
      result = { ok: true, kind: asset.kind, trackId: target.trackId, clipIds: [clip.id] }
    } else if (choice === 'both') {
      // Resolve against BOTH tracks at once so the pair lands where neither
      // track is occupied; they stay frame-synced and never overlap.
      const audioTarget = ensureAudioTrack(engine)
      if (!audioTarget.ok) {
        result = mediaRefusal(asset.kind, audioTarget.reason)
        return
      }
      const videoClips = clipsOn(engine, target.trackId)
      const audioClips = clipsOn(engine, audioTarget.trackId)
      const r = resolveDropPosition(
        [...videoClips, ...audioClips],
        desiredStart,
        fullDuration,
      )
      const video = addMediaClip(engine, target.trackId, 'video', asset, r.startFrame, r.durationFrames)
      const audio = addMediaClip(engine, audioTarget.trackId, 'audio', asset, r.startFrame, r.durationFrames)
      result = {
        ok: true,
        kind: asset.kind,
        trackId: target.trackId,
        clipIds: [video.id, audio.id],
      }
    } else {
      const audioTarget = ensureAudioTrack(engine)
      if (!audioTarget.ok) {
        result = mediaRefusal(asset.kind, audioTarget.reason)
        return
      }
      const a = resolveOn(engine, audioTarget.trackId, desiredStart, fullDuration)
      const clip = addMediaClip(engine, audioTarget.trackId, 'audio', asset, a.startFrame, a.durationFrames)
      result = { ok: true, kind: asset.kind, trackId: audioTarget.trackId, clipIds: [clip.id] }
    }
  }, 'Add media')

  return result
}

/**
 * Insert a generated element from the published element drag payload. Keeping
 * the templates here means drag-drop and tap insertion always create identical
 * text, shape, and freehand clips.
 */
export function insertElement(
  engine: TimelineEngine,
  payload: DragElementPayload,
  opts: InsertAssetOptions = {},
): InsertAssetResult {
  if (payload.kind !== 'element') return elementRefusal('incompatible-track')

  const target = resolveElementTarget(engine, opts.targetTrackId)
  if (!target.ok) return elementRefusal(target.reason)

  const run = (): InsertAssetResult => {
    const fps = engine.getProject().fps
    const elemDuration = Math.max(1, fps * DEFAULT_TEXT_DURATION_SEC)
    const desired = currentDesiredStart(opts)

    // Tap insertion (no explicit track) layers onto a lane that is free right
    // here, adding one if every lane is busy — so stacking a title over a
    // caption over a shape at the same moment just works. A real drop keeps the
    // lane the user aimed at, occupied or not.
    let trackId = target.trackId
    if (!opts.targetTrackId) {
      const acquired = acquireFreeTrack(
        engine,
        'elements',
        desired,
        elemDuration,
        opts.reserveTrack,
      )
      if (acquired) trackId = acquired.trackId
    }

    const { startFrame, durationFrames } = resolveOn(engine, trackId, desired, elemDuration)
    const clip = addElementClip(engine, trackId, payload, startFrame, durationFrames)
    return { ok: true, kind: 'element', trackId, clipIds: [clip.id] }
  }

  // Always batched: run() can create a lane, and adding that lane plus the clip
  // has to collapse into a single undo entry.
  let result: InsertAssetResult = elementRefusal('no-track')
  engine.batch(() => {
    result = run()
  }, 'Add element')
  return result
}
