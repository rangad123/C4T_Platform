'use client'

import { useState } from 'react'
import { IconButton } from '../core/IconButton'
import { Icon } from '../core/Icon'
import { SOCIAL_ICONS, type SocialIconName } from '@/components/SocialIcons'

const PLATFORMS: {
  icon: SocialIconName
  label: string
  hrefFor: (url: string, title: string) => string
}[] = [
  {
    icon: 'x',
    label: 'Share on X',
    hrefFor: (url, title) => `https://twitter.com/intent/tweet?url=${url}&text=${title}`,
  },
  {
    icon: 'linkedin',
    label: 'Share on LinkedIn',
    hrefFor: (url) => `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
  },
  {
    icon: 'facebook',
    label: 'Share on Facebook',
    hrefFor: (url) => `https://www.facebook.com/sharer/sharer.php?u=${url}`,
  },
]

/**
 * Share links for a blog post. Each platform link is a plain share-intent
 * URL (no SDK, no tracking pixel) — a small, self-contained row rather than
 * the "intrusive sharing bar" the spec explicitly warns against. Reuses the
 * same brand glyphs the footer already uses (`SOCIAL_ICONS`), so a reader
 * sees the same LinkedIn/Facebook marks in both places instead of two
 * different icon languages.
 */
export function ShareRow({ url, title }: { url: string; title: string }) {
  const [copied, setCopied] = useState(false)

  const encodedUrl = encodeURIComponent(url)
  const encodedTitle = encodeURIComponent(title)

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be denied (permissions, insecure context) — the
      // link is still visible in the address bar, so this is a nicety, not
      // something worth surfacing an error for.
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
      <span className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>
        Share
      </span>
      {PLATFORMS.map(({ icon, label, hrefFor }) => {
        const Glyph = SOCIAL_ICONS[icon]
        return (
          <a
            key={icon}
            href={hrefFor(encodedUrl, encodedTitle)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={label}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 40,
              height: 40,
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-default)',
              background: 'var(--surface-canvas)',
              color: 'var(--text-secondary)',
              transition: 'var(--transition-control)',
            }}
          >
            <Glyph width={18} height={18} aria-hidden="true" />
          </a>
        )
      })}
      <IconButton
        icon={copied ? 'check' : 'paperclip'}
        label={copied ? 'Link copied' : 'Copy link'}
        variant="outline"
        onClick={copyLink}
      />
      {copied ? (
        <span style={{ fontSize: 'var(--type-caption-size)', color: 'var(--text-muted)' }}>
          <Icon name="check" size={12} style={{ verticalAlign: -1, marginRight: 3 }} />
          Copied
        </span>
      ) : null}
    </div>
  )
}
