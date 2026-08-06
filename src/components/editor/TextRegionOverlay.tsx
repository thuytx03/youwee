import { computeContainViewport, useTracksStore } from '@elah/editor';
import { X } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTextRegionStore } from './textRegionStore';

/** Ignore click-sized drags — they're almost always a misclick, not a box. */
const MIN_DRAG_PX = 8;

/**
 * Lets the user drag rectangles over the Preview to mark burned-in text.
 *
 * Lives in app code rather than inside the vendored Preview so the overlay stack
 * there stays untouched; it is rendered as a sibling positioned over the canvas.
 * Only captures pointer events while draw mode is on, so the vendored overlays
 * (clip transform, text editing) keep working the rest of the time.
 *
 * Regions are stored in stage coordinates and projected to the screen on every
 * render, which is what keeps the boxes glued to the picture across window
 * resizes and aspect-ratio changes.
 */
export function TextRegionOverlay() {
  const stage = useTracksStore((s) => s.stage);
  const active = useTextRegionStore((s) => s.active);
  const regions = useTextRegionStore((s) => s.regions);
  const selectedId = useTextRegionStore((s) => s.selectedId);
  const addRegion = useTextRegionStore((s) => s.addRegion);
  const removeRegion = useTextRegionStore((s) => s.removeRegion);
  const selectRegion = useTextRegionStore((s) => s.selectRegion);

  const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // Live drag rect in screen px; null when not dragging.
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const apply = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    apply();
    const obs = new ResizeObserver(apply);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // The same letterbox rect the renderer computes, so overlay and pixels agree.
  const fit = useMemo(
    () => computeContainViewport(size.width, size.height, stage.width, stage.height),
    [size.width, size.height, stage.width, stage.height],
  );
  // 0 until the ResizeObserver has measured, which would make every conversion
  // collapse to the origin. Guarded rather than defaulted to 1: silently mapping
  // with the wrong scale produces boxes that look plausible and land nowhere.
  const scale = fit.width > 0 && stage.width > 0 ? fit.width / stage.width : 0;
  const ready = scale > 0;

  const toStage = (clientX: number, clientY: number) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || !ready) return null;
    return {
      x: (clientX - rect.left - fit.x) / scale,
      y: (clientY - rect.top - fit.y) / scale,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!active || !ready || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setDrag({ x0: x, y0: y, x1: x, y1: y });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    setDrag({ ...drag, x1: e.clientX - rect.left, y1: e.clientY - rect.top });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (!drag) return;
    const w = Math.abs(drag.x1 - drag.x0);
    const h = Math.abs(drag.y1 - drag.y0);
    setDrag(null);
    if (w < MIN_DRAG_PX || h < MIN_DRAG_PX) return;

    // Convert both corners so a drag in any direction yields a positive rect.
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const a = toStage(rect.left + Math.min(drag.x0, drag.x1), rect.top + Math.min(drag.y0, drag.y1));
    const b = toStage(rect.left + Math.max(drag.x0, drag.x1), rect.top + Math.max(drag.y0, drag.y1));
    if (!a || !b) return;

    // Clamp to the picture. Without this a box drawn partly over the letterbox
    // bars keeps negative/overflowing stage coords, and the source-pixel clamp
    // downstream collapses it to nothing — which surfaced as "region outside
    // the video" even for a box that visibly covered the text.
    const x0 = Math.max(0, Math.min(a.x, stage.width));
    const y0 = Math.max(0, Math.min(a.y, stage.height));
    const x1 = Math.max(0, Math.min(b.x, stage.width));
    const y1 = Math.max(0, Math.min(b.y, stage.height));
    if (x1 - x0 < 1 || y1 - y0 < 1) return;

    addRegion({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  };

  // Always rendered, never conditionally unmounted: unmounting resets `size` to
  // 0, and the first pointerdown after a remount would then arrive before the
  // ResizeObserver has measured, mapping the drag with a bogus scale. The
  // element is inert (pointer-events: none) unless draw mode is on.
  return (
    <div
      ref={rootRef}
      className="absolute inset-0 z-[5] overflow-hidden"
      style={{
        pointerEvents: active ? 'auto' : 'none',
        cursor: active ? 'crosshair' : undefined,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Outline the picture while selecting, so it's obvious where a box can go
          (the canvas fills the whole element; the video only covers `fit`). */}
      {active && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: fit.x,
            top: fit.y,
            width: fit.width,
            height: fit.height,
            outline: '1px dashed rgba(255,255,255,0.35)',
            outlineOffset: -1,
          }}
        />
      )}

      {regions.map((r) => {
        const left = fit.x + r.x * scale;
        const top = fit.y + r.y * scale;
        const w = r.w * scale;
        const h = r.h * scale;
        const isSel = selectedId === r.id;
        return (
          <div
            key={r.id}
            onPointerDown={(e) => {
              // Clicking an existing box selects it instead of starting a new one.
              if (!active) return;
              e.stopPropagation();
              selectRegion(r.id);
            }}
            className="absolute"
            style={{
              left,
              top,
              width: w,
              height: h,
              border: `2px solid ${isSel ? 'var(--elah-accent)' : 'rgba(255,255,255,0.8)'}`,
              background: 'rgba(255,0,0,0.18)',
              pointerEvents: active ? 'auto' : 'none',
            }}
          >
            {active && (
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  removeRegion(r.id);
                }}
                className="absolute -top-2.5 -right-2.5 w-5 h-5 inline-flex items-center justify-center rounded-full bg-black/80 text-white cursor-pointer"
                title="Remove region"
              >
                <X size={11} />
              </button>
            )}
          </div>
        );
      })}

      {drag && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: Math.min(drag.x0, drag.x1),
            top: Math.min(drag.y0, drag.y1),
            width: Math.abs(drag.x1 - drag.x0),
            height: Math.abs(drag.y1 - drag.y0),
            border: '2px dashed var(--elah-accent)',
            background: 'rgba(255,0,0,0.12)',
          }}
        />
      )}
    </div>
  );
}
