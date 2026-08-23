import type { CSSProperties } from 'react'
import { Icon } from './Icon'

export interface SpinnerProps {
  /** Square px size. Match whatever icon scale it's standing in for — 16/18/20. */
  size?: number
  /** CSS color; defaults to currentColor, so it matches the surrounding text/button color. */
  color?: string
  className?: string
  style?: CSSProperties
  /**
   * Accessible name. Omit (the default) when the spinner sits next to visible
   * text that already says what's happening — "Saving…" — so a screen reader
   * doesn't announce "Loading" and the label back to back. Pass one only for
   * a standalone, icon-only spinner with nothing else nearby to name it.
   */
  label?: string
}

/**
 * The one spinner in the system — never hand-roll another rotating icon.
 *
 * A `loader-circle` glyph animated by the `.c4t-spin` utility in
 * tokens/interactions.css, which drops the rotation (not the icon itself)
 * under `prefers-reduced-motion` — the static ring still reads as "busy"
 * next to changed button text, just without motion a reduced-motion visitor
 * asked not to see.
 *
 * Server-safe: the animation is pure CSS, so this needs no `'use client'` —
 * fine to render from a Server Component whenever the pending state is
 * already known at render time (a page-level `loading.tsx`, for instance).
 * A control that only spins WHILE a click is in flight still needs a client
 * wrapper to know that — see `SubmitButton`.
 */
export function Spinner({ size = 18, color, className, style, label }: SpinnerProps) {
  return (
    <Icon
      name="loader-circle"
      size={size}
      color={color}
      className={['c4t-spin', className].filter(Boolean).join(' ')}
      style={style}
      label={label}
    />
  )
}
