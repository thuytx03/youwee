'use client'

import { type CSSProperties, type ReactNode } from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Clip } from '@elah/editor'
import { cn } from '@/lib/utils'

export const inputCls =
  'w-full bg-ed-bg border border-ed-border rounded-md text-ed-text text-xs font-sans px-2.5 py-1.5 outline-none focus:border-ed-accent transition-colors'

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <div className="text-[11px] text-ed-text-muted mb-1.5">{label}</div>
      {children}
    </div>
  )
}

export function NumberField({
  value,
  onChange,
  onCommit,
  step = 1,
  min,
  max,
  suffix,
  placeholder,
}: {
  value: number
  onChange: (v: number) => void
  onCommit: () => void
  step?: number
  min?: number
  max?: number
  suffix?: string
  placeholder?: string
}) {
  const clamp = (v: number) =>
    Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))
  const bump = (dir: 1 | -1) => {
    onChange(clamp(Number((value + dir * step).toFixed(4))))
    onCommit()
  }
  return (
    <div className="relative">
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        placeholder={placeholder}
        onChange={(e) => onChange(Number(e.target.value))}
        onBlur={onCommit}
        className={cn(
          inputCls,
          'pr-8 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
        )}
      />
      {suffix && (
        <span className="absolute right-8 top-1/2 -translate-y-1/2 text-[10px] text-ed-text-muted pointer-events-none">
          {suffix}
        </span>
      )}
      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex flex-col gap-px">
        <button
          type="button"
          tabIndex={-1}
          onClick={() => bump(1)}
          className="flex items-center justify-center w-5 h-[11px] rounded-[3px] text-ed-text-muted hover:text-ed-text hover:bg-ed-elevated"
        >
          <ChevronUp size={10} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          onClick={() => bump(-1)}
          className="flex items-center justify-center w-5 h-[11px] rounded-[3px] text-ed-text-muted hover:text-ed-text hover:bg-ed-elevated"
        >
          <ChevronDown size={10} />
        </button>
      </div>
    </div>
  )
}

export function SliderRow({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  display: string
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-2.5">
        <input
          type="range"
          className="elah-range flex-1"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="text-[11px] text-ed-text-muted font-mono w-10 text-right tabular-nums">
          {display}
        </span>
      </div>
    </Field>
  )
}

export const PANEL = 'w-[300px] shrink-0 flex flex-col bg-ed-panel border-l border-ed-border'

export function PanelHeader({ subtitle }: { subtitle?: string }) {
  const { t } = useTranslation('pages')
  return (
    <div className="px-4 pt-4 pb-3 shrink-0">
      <div className="text-[15px] font-semibold text-ed-text">{t('editor.ui.properties')}</div>
      {subtitle && (
        <div className="text-[10px] text-ed-text-muted mt-0.5 font-mono">{subtitle}</div>
      )}
    </div>
  )
}

export function mergeTransform(c: Partial<Clip>) {
  return { x: 0.5, y: 0.5, scale: 1, rotation: 0, anchor: { x: 0.5, y: 0.5 }, ...c.transform }
}

// ---------------------------------------------------------------------------
// Color helpers — a Clip's backgroundColor is a single CSS color string, while
// the UI edits it as separate hex + opacity. These convert between the two.
// ---------------------------------------------------------------------------

/** Combine a hex color + 0..1 opacity into the `rgba()` string clips store. */
export function hexToRgba(hex: string, opacity: number): string {
  const m = hex.replace('#', '')
  const r = parseInt(m.slice(0, 2), 16)
  const g = parseInt(m.slice(2, 4), 16)
  const b = parseInt(m.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${opacity})`
}

/**
 * Inverse of hexToRgba, so a control can show the color actually painted.
 *
 * Only `rgb()`/`rgba()` and bare `#rrggbb` are understood — every value this
 * app writes goes through hexToRgba, so anything else (a named color, hsl())
 * is foreign and falls back to the default rather than guessing.
 */
export function rgbaToHexOpacity(color: string | undefined): { hex: string; opacity: number } {
  const rgba = color?.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/)
  if (rgba) {
    const toHex = (n: string) => Number(n).toString(16).padStart(2, '0')
    return {
      hex: `#${toHex(rgba[1])}${toHex(rgba[2])}${toHex(rgba[3])}`,
      opacity: rgba[4] !== undefined ? Number(rgba[4]) : 1,
    }
  }
  if (color && /^#[0-9a-f]{6}$/i.test(color)) return { hex: color.toLowerCase(), opacity: 1 }
  return { hex: '#000000', opacity: 0.6 }
}

/**
 * Color swatch + hex text input. The picker commits immediately (it already
 * has its own confirm step), while the text field previews on change and only
 * commits on blur so a half-typed hex never reaches the engine.
 */
export function ColorRow({
  value,
  fallback,
  onPreview,
  onCommit,
}: {
  value: string | undefined
  fallback: string
  onPreview: (v: string) => void
  onCommit: (v: string) => void
}) {
  const current = value ?? fallback
  return (
    <div className="flex gap-1.5 items-center">
      <input
        type="color"
        value={current}
        onChange={(e) => onCommit(e.target.value)}
        className="w-9 h-8 p-0 border border-ed-border rounded-md cursor-pointer bg-transparent shrink-0"
      />
      <input
        type="text"
        value={current}
        onChange={(e) => onPreview(e.target.value)}
        onBlur={() => onCommit(current)}
        className={cn(inputCls, 'font-mono')}
      />
    </div>
  )
}

/** Two-or-more mutually exclusive options rendered as one segmented control. */
export function SegmentedToggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { id: T; label: string }[]
  onChange: (id: T) => void
}) {
  return (
    <div className="flex gap-2">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={cn(
            'flex-1 rounded-md px-2 py-1.5 text-xs border transition-colors cursor-pointer',
            value === o.id
              ? 'bg-ed-accent-soft text-ed-accent-hover border-ed-accent'
              : 'bg-ed-bg text-ed-text-muted border-ed-border hover:text-ed-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Grid of one-click style templates. `chipStyle` lets a chip preview what it
 * applies (a font chip renders in its own font, a color chip paints itself),
 * which is the whole point of a template picker.
 */
export function PresetChips<T extends { id: string }>({
  presets,
  activeId,
  columns,
  onPick,
  renderLabel,
  chipStyle,
  chipClassName,
}: {
  presets: readonly T[]
  activeId?: string
  columns: 2 | 3 | 4
  onPick: (p: T) => void
  renderLabel: (p: T) => ReactNode
  chipStyle?: (p: T) => CSSProperties
  chipClassName?: string
}) {
  const cols = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4' }[columns]
  return (
    <div className={cn('grid gap-1.5', cols)}>
      {presets.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onPick(p)}
          style={chipStyle?.(p)}
          className={cn(
            'rounded-md px-1 py-1.5 text-xs border transition-colors truncate cursor-pointer',
            activeId === p.id
              ? 'border-ed-accent ring-1 ring-ed-accent text-ed-text'
              : 'border-ed-border text-ed-text-muted hover:bg-ed-elevated',
            chipClassName,
          )}
        >
          {renderLabel(p)}
        </button>
      ))}
    </div>
  )
}
