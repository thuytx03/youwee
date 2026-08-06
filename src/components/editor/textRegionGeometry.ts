import { resolveDrawRect, type Clip } from '@elah/editor';
import type { StageRegion } from './textRegionStore';

/** A rectangle in the source video's own pixel grid — what ffmpeg filters want. */
export interface SourceRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Grow each box slightly before handing it to ffmpeg.
 *
 * `computeContainViewport` integer-rounds the letterbox rect, so the screen→stage
 * inversion carries up to a pixel of error, which the stage→source scale-up can
 * multiply. Covering a couple of extra pixels is free; missing the last row of
 * glyph antialiasing leaves a visible ghost of the text.
 */
const PADDING_PX = 2;

/**
 * Convert a region drawn in stage space into the source video's pixel space.
 *
 * Goes through `resolveDrawRect` rather than reimplementing the letterbox math,
 * because that function is the renderer's own authority and handles both cases
 * uniformly: a clip with no transform (contained in the stage) and one with an
 * explicit transform (scaled/moved). In both, `rect.width / contentWidth` is the
 * effective scale, so one formula covers them.
 *
 * Returns null when the box, after clamping, has no usable area — e.g. the user
 * drew it entirely on the letterbox bars outside the picture.
 */
export function stageRegionToSource(
  region: StageRegion,
  clip: Pick<Clip, 'transform'>,
  stage: { width: number; height: number },
  content: { width: number; height: number },
): SourceRegion | null {
  const rect = resolveDrawRect(
    clip.transform,
    stage.width,
    stage.height,
    content.width,
    content.height,
  );
  if (rect.width <= 0 || rect.height <= 0) return null;

  const scaleX = content.width / rect.width;
  const scaleY = content.height / rect.height;

  let x = (region.x - rect.x) * scaleX - PADDING_PX;
  let y = (region.y - rect.y) * scaleY - PADDING_PX;
  let w = region.w * scaleX + PADDING_PX * 2;
  let h = region.h * scaleY + PADDING_PX * 2;

  // delogo refuses a box touching the frame edge, so keep a 1px margin all round
  // and clamp rather than error — a box partly over the letterbox bar should
  // still clean the part that overlaps the picture.
  const minX = 1;
  const minY = 1;
  const maxX = content.width - 1;
  const maxY = content.height - 1;

  const x0 = Math.max(minX, Math.min(x, maxX));
  const y0 = Math.max(minY, Math.min(y, maxY));
  const x1 = Math.max(minX, Math.min(x + w, maxX));
  const y1 = Math.max(minY, Math.min(y + h, maxY));

  x = Math.round(x0);
  y = Math.round(y0);
  w = Math.round(x1 - x0);
  h = Math.round(y1 - y0);

  // Sub-pixel slivers are not worth an ffmpeg pass and delogo needs w,h ≥ 1.
  if (w < 2 || h < 2) return null;

  return { x, y, w, h };
}

/**
 * Whether this clip can be cleaned at all.
 *
 * Rotation is the blocker: every filter here takes an axis-aligned box, so a
 * rotated clip's on-screen rectangle does not correspond to any rectangle in the
 * source frame. Rather than silently cleaning the wrong area, refuse.
 */
export function cleanupBlockedReason(
  clip: Pick<Clip, 'transform'>,
): 'rotated' | null {
  const rotation = clip.transform?.rotation ?? 0;
  return Math.abs(rotation) > 1e-6 ? 'rotated' : null;
}
