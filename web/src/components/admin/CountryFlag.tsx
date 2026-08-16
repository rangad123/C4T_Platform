import type { CSSProperties } from 'react'
import * as Flags from 'country-flag-icons/react/3x2'
import { hasFlag } from 'country-flag-icons'

export interface CountryFlagProps {
  /** ISO 3166-1 alpha-2 country code, e.g. `IN`, `US`. Case-insensitive. */
  countryCode: string | null | undefined
  /** Rendered flag width in px. Height follows the 3:2 flag aspect ratio. */
  size?: number
  style?: CSSProperties
}

/**
 * A small flag next to a country code, everywhere the admin panel shows one
 * (organisation address, tester location, user profile).
 *
 * Flags come from `country-flag-icons` — real per-country SVGs, not the
 * Unicode regional-indicator emoji this project's copy rules ban, and not a
 * hand-rolled SVG per country. Renders nothing (not a broken-image icon) for
 * a code the package does not recognise, e.g. a stale or free-text value.
 */
export function CountryFlag({ countryCode, size = 18, style }: CountryFlagProps) {
  if (!countryCode) return null
  const code = countryCode.trim().toUpperCase()
  if (!hasFlag(code)) return null

  const Flag = (Flags as Record<string, (props: { style?: CSSProperties }) => React.JSX.Element>)[
    code
  ]
  if (!Flag) return null

  return (
    <Flag
      style={{
        display: 'inline-block',
        width: size,
        height: Math.round((size * 2) / 3),
        borderRadius: 2,
        flex: 'none',
        verticalAlign: 'middle',
        boxShadow: '0 0 0 1px var(--border-default)',
        ...style,
      }}
    />
  )
}

/**
 * Country code paired with its flag, in the "flag + code" shape used across
 * list columns and description lists. `label` overrides the visible text
 * (defaults to the code itself) — useful when a caller wants "India" instead
 * of "IN" next to the flag.
 */
export function CountryLabel({
  countryCode,
  label,
  size = 16,
}: {
  countryCode: string | null | undefined
  label?: string
  size?: number
}) {
  if (!countryCode) return null
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      <CountryFlag countryCode={countryCode} size={size} />
      <span>{label ?? countryCode.trim().toUpperCase()}</span>
    </span>
  )
}
