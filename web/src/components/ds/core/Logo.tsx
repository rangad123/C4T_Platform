import type { CSSProperties } from 'react'
import Link from 'next/link'
import Image from 'next/image'

export interface LogoProps {
  /**
   * Mark height in px. The mark is square, so width follows.
   *   32 in nav and footer (matched).
   *   40+ for hero lockups and the footer brand column.
   */
  size?: number
  /**
   * Wordmark font size in px. Defaults to 0.75 × `size` so the type reads as
   * a label to the mark's icon — 32 mark → 24 type, the 3:4 ratio that holds
   * at any size. Pass an explicit value to override.
   */
  wordmarkSize?: number
  tone?: 'default' | 'inverse'
  /** Show the wordmark alongside the mark. Default true. */
  withWordmark?: boolean
  /** Link target; pass null or "" to render a plain span. */
  href?: string | null
  style?: CSSProperties
  className?: string
}

/**
 * The Crowd4Test mark.
 *
 * A 1:1 raster sits to the left of the wordmark, with the accent "4" pulled
 * out in the brand colour. The wordmark uses the display face so the cap-height
 * of the type matches the mark height, and the gap is fixed at 1/3 of the mark
 * for a ratio that holds at any size.
 *
 * Why both — the mark alone is iconic, but in a wordmark-driven navbar the
 * "Crowd4Test" text reads faster than the abstract mark. Both together is the
 * brand pattern on every page that has a logo lockup.
 *
 * Tinting: on inverse bands the wordmark flips to `--text-inverse` and the
 * accent "4" flips to `--text-brand-inverse` (the pale-tint accent-on-dark
 * role). The mark itself is a fixed-colour asset and renders as-is on both
 * surfaces — see the note on `/logo--inverse.png` if contrast ever fails on
 * the dark band.
 *
 * Accessibility: the link carries `aria-label="Crowd4Test"` so a screen reader
 * hears the brand once, not "Crowd4Test Crowd4Test" (image alt + visible text).
 * The image's `alt=""` keeps assistive tech from repeating it.
 */
export function Logo({
  size = 32,
  wordmarkSize,
  tone = 'default',
  withWordmark = true,
  href = '/',
  style,
  className,
}: LogoProps) {
  const color = tone === 'inverse' ? 'var(--text-inverse)' : 'var(--text-primary)'
  const accent = tone === 'inverse' ? 'var(--text-brand-inverse)' : 'var(--accent-base)'

  const base: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: Math.round(size / 3),
    lineHeight: 1,
    textDecoration: 'none',
    ...style,
  }

  // The mark is a single-colour artwork with a transparent background, so on
  // an inverse band the original pixel values fade against the band. A single
  // CSS filter (brightness 0 + invert 1) strips the colour and leaves a
  // white-on-transparent silhouette that matches the wordmark on the dark
  // surface. The wordmark already flips via `tone` (its colour token is
  // selected in the span below); this is the mark-side half of the same logic.
  const markStyle: CSSProperties = {
    display: 'block',
    height: 'auto',
    ...(tone === 'inverse' ? { filter: 'brightness(0) invert(1)' } : {}),
  }

  const mark = (
    <Image
      // The mark is a 1:1 raster. Explicit width/height reserve layout space
      // so the browser doesn't reflow once the image arrives. `priority` is not
      // set because the logo is rarely the LCP element — on the homepage the
      // hero is, and on inner pages it is below the fold.
      src="/logo.png"
      alt=""
      width={size}
      height={size}
      style={markStyle}
    />
  )

  const wordmark = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        fontFamily: 'var(--font-display)',
        fontWeight: 'var(--fw-semibold)',
        // Default 0.75 × mark — 32 mark → 24 type. Override with the prop for
        // hero lockups where a larger wordmark reads better, or strip the
        // wordmark entirely with `withWordmark={false}`.
        fontSize: wordmarkSize ?? Math.round(size * 0.75),
        // Tracking scales with the type size so the wordmark sits with the mark
        // at any logo size — same -0.038 ratio the inline text render used.
        letterSpacing: (wordmarkSize ?? Math.round(size * 0.75)) * -0.038,
        color,
        whiteSpace: 'nowrap',
      }}
    >
      Crowd<span style={{ color: accent }}>4</span>Test
    </span>
  )

  const content = withWordmark ? (
    <>
      {mark}
      {wordmark}
    </>
  ) : (
    mark
  )

  if (!href) {
    return (
      <span className={className} style={base} aria-label="Crowd4Test">
        {content}
      </span>
    )
  }

  return (
    <Link href={href} className={className} style={base} aria-label="Crowd4Test">
      {content}
    </Link>
  )
}
