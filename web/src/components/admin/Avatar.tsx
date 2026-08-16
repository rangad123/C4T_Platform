import type { CSSProperties } from 'react'
import { SiteImage } from '@/components/ds/marketing/SiteImage'

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl'

export interface AvatarProps {
  /** Person or organisation whose picture this is. */
  name: string
  /** Optional `fileId` (uploaded picture). When present, renders the picture. */
  fileId?: string | null
  /** Pixel size of the rendered square. Default `md` = 40px. */
  size?: AvatarSize
  /** Style override for the wrapper (margins, etc.). */
  style?: CSSProperties
  /**
   * Override the background tint of the initials fallback. Used by organisations
   * (always the same colour regardless of size) and by testers (deterministic
   * from email so the same person is always the same colour).
   */
  tint?: string
}

const SIZE_PX: Record<AvatarSize, number> = {
  sm: 28,
  md: 40,
  lg: 56,
  xl: 96,
}

/**
 * Avatar with a coloured-initials fallback.
 *
 * The picture is served via the SiteImage component (which already knows
 * how to hit `/api/v1/files/<id>/download-url`). When `fileId` is absent
 * the initials render over a deterministic background colour so two people
 * with the same initials do not collide visually.
 *
 * Two-line initials ("Alex Smith" → "AS") are kept short to fit a square
 * without overflow at every size.
 */
export function Avatar({ name, fileId, size = 'md', style, tint }: AvatarProps) {
  const px = SIZE_PX[size]
  const initials = pickInitials(name)
  const background = tint ?? pickTint(name)

  return (
    <span
      aria-hidden={fileId ? 'false' : 'true'}
      style={{
        display: 'inline-flex',
        width: px,
        height: px,
        flex: '0 0 auto',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '50%',
        overflow: 'hidden',
        background,
        color: 'var(--ink-50)',
        fontWeight: 'var(--fw-semibold)',
        fontSize: Math.max(11, Math.round(px * 0.36)),
        lineHeight: 1,
        letterSpacing: '0.02em',
        textTransform: 'uppercase',
        userSelect: 'none',
        ...style,
      }}
    >
      {fileId ? (
        <SiteImage
          src={`/api/v1/files/${fileId}/download-url`}
          alt={name}
          width={px}
          height={px}
          style={{ display: 'block', width: '100%', height: '100%' }}
        />
      ) : (
        initials
      )}
    </span>
  )
}

function pickInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = words[0]?.charAt(0) ?? ''
  const second = words.length > 1 ? words[1]?.charAt(0) ?? '' : ''
  return (first + second).toUpperCase() || '?'
}

const TINTS = [
  'var(--accent-base)',
  '#7a4ec5',
  '#d05a2c',
  '#3d7a4a',
  '#c43d6c',
  '#2c5dab',
  '#b08018',
  '#3d8a8a',
]

function pickTint(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0
  }
  return TINTS[h % TINTS.length] ?? TINTS[0]!
}
