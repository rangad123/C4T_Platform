import type { CSSProperties } from 'react'
import Link from 'next/link'
import { Icon } from '../core/Icon'
import type { IconName } from '../core/icon-registry'
import { Media } from './Media'
import { SiteImage } from './SiteImage'

export type ResourceType = 'Article' | 'Guide' | 'Webinar' | 'Report' | 'Case study' | 'Podcast'

const TYPE_ICON = {
  Article: 'newspaper',
  Guide: 'book-open',
  Webinar: 'video',
  Report: 'file-text',
  'Case study': 'trending-up',
  Podcast: 'mic',
} as const satisfies Record<ResourceType, IconName>

export interface ResourceCardProps {
  type?: ResourceType
  title: string
  description?: string
  readTime?: string
  date?: string
  author?: string
  layout?: 'vertical' | 'horizontal'
  href: string
  /**
   * A real photo instead of the `<Media>` placeholder plate — a blog post's
   * featured image. Optional and additive: every existing call site (the
   * homepage resource carousel) omits this and keeps rendering the
   * placeholder exactly as before.
   */
  image?: { src: string; alt: string }
  /**
   * Replaces `type` in the eyebrow row when present. A blog card's topic
   * ("API Testing") is what belongs there, not its format ("Article") —
   * `type` still silently drives the plate's icon glyph either way. Omit to
   * keep the existing `type`-as-label behavior unchanged.
   */
  category?: string
  style?: CSSProperties
  className?: string
}

/**
 * A blog post, guide, report or webinar.
 *
 * PORT NOTES.
 *  - `type` is a union rather than a free string. The source did
 *    `TYPE_ICON[type] || "file-text"`, silently falling back when a typo'd
 *    category came through; the union makes that a compile error instead.
 *  - `onClick`/`href="#"` became a required `href`, as on ServiceCard.
 *
 * The plate is a `<Media>` placeholder, not a photograph — resource artwork is
 * per-post and arrives with the MDX in build step 9.
 */
export function ResourceCard({
  type = 'Article',
  title,
  description,
  readTime,
  date,
  author,
  layout = 'vertical',
  href,
  image,
  category,
  style,
  className,
}: ResourceCardProps) {
  const horizontal = layout === 'horizontal'
  const eyebrowLabel = category ?? type

  return (
    <Link
      href={href}
      className={['c4t-card-hover', horizontal ? 'c4t-resource-horizontal' : null, className]
        .filter(Boolean)
        .join(' ')}
      style={{
        display: horizontal ? 'grid' : 'flex',
        gridTemplateColumns: horizontal ? '260px 1fr' : undefined,
        flexDirection: horizontal ? undefined : 'column',
        gap: horizontal ? 'var(--space-6)' : 0,
        overflow: 'hidden',
        background: 'var(--surface-canvas)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-card)',
        textDecoration: 'none',
        color: 'inherit',
        height: '100%',
        ...style,
      }}
    >
      {image ? (
        <SiteImage
          src={image.src}
          alt={image.alt}
          fill
          ratio={horizontal ? '4 / 3' : '16 / 9'}
          sizes={horizontal ? '260px' : '(max-width: 900px) 100vw, 25vw'}
          radius="0"
          style={{
            borderRight: horizontal ? '1px solid var(--border-subtle)' : 'none',
            borderBottom: horizontal ? 'none' : '1px solid var(--border-subtle)',
          }}
        />
      ) : (
        <Media
          ratio={horizontal ? '4 / 3' : '16 / 9'}
          label={type}
          icon={TYPE_ICON[type]}
          tone="sunken"
          radius="0"
          style={{
            borderWidth: 0,
            borderRight: horizontal ? '1px solid var(--border-subtle)' : 'none',
            borderBottom: horizontal ? 'none' : '1px solid var(--border-subtle)',
            height: horizontal ? '100%' : undefined,
          }}
        />
      )}

      <div
        style={{
          padding: horizontal ? '20px var(--space-6) 20px 0' : 'var(--space-card-padding)',
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--type-eyebrow-size)',
            fontWeight: 'var(--fw-semibold)',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--text-brand)',
          }}
        >
          {eyebrowLabel}
          {date ? (
            <span style={{ color: 'var(--text-muted)', letterSpacing: '0.06em' }}>{date}</span>
          ) : null}
        </div>

        <h3
          style={{
            marginTop: 10,
            fontSize: 'var(--type-heading-sm-size)',
            lineHeight: 'var(--type-heading-sm-line)',
            letterSpacing: 'var(--type-heading-sm-tracking)',
            textWrap: 'pretty',
          }}
        >
          {title}
        </h3>

        {description ? (
          <p
            style={{
              marginTop: 8,
              fontSize: 'var(--type-body-sm-size)',
              lineHeight: 'var(--type-body-sm-line)',
              color: 'var(--text-secondary)',
            }}
          >
            {description}
          </p>
        ) : null}

        {(author ?? readTime) ? (
          <div
            style={{
              marginTop: 'auto',
              paddingTop: 18,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 'var(--type-caption-size)',
              color: 'var(--text-muted)',
            }}
          >
            {author ? <span>{author}</span> : null}
            {author && readTime ? <span aria-hidden="true">·</span> : null}
            {readTime ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Icon name="clock" size={13} />
                {readTime}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </Link>
  )
}
