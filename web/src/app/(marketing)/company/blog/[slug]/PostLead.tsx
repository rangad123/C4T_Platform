import { SiteImage } from '@/components/ds/marketing/SiteImage'
import type { BlogPostLayout } from '@/lib/blog/types'

export interface PostLeadProps {
  layout: BlogPostLayout
  title: string
  featuredImageUrl: string | null
  secondaryImageUrl: string | null
  /** The breadcrumb, meta line, title and excerpt — identical in every layout. */
  children: React.ReactNode
}

/**
 * The top of a post: its title block, and where the lead image sits relative
 * to it.
 *
 * Only the arrangement changes between layouts. The text is the same nodes in
 * the same order every time, passed straight through — a layout is not licence
 * to say different things, and duplicating that block per variant is how the
 * four drift apart.
 *
 * ── Exactly one image is `priority`
 *
 * Whichever image leads the page is the LCP element and is preloaded; the
 * others are not. Marking two would preload two large files and make the
 * measurement worse rather than better, which is the trap in adding a lead
 * image without removing the flag from the one it replaces. GALLERY has no
 * lead image here at all — its first gallery item is the lead, and carries the
 * flag instead.
 *
 * ── Why this does not attempt an edge-to-edge hero
 *
 * `Section` clamps its children to `--container-max` with gutters, and the
 * dark band sets `overflow: hidden`. Breaking a photograph out of both would
 * mean restructuring the shared Section, which every marketing page uses. HERO
 * instead fills the container at a cinematic ratio with the title over it —
 * the same effect within the grid the rest of the site keeps to.
 */
export function PostLead({
  layout,
  title,
  featuredImageUrl,
  secondaryImageUrl,
  children,
}: PostLeadProps) {
  // SPLIT prefers the second image — that is what the field is for — and falls
  // back so a post switched to SPLIT without one is not left with a blank column.
  const sideImage = secondaryImageUrl ?? featuredImageUrl

  if (layout === 'HERO' && featuredImageUrl) {
    return (
      <div style={{ position: 'relative' }}>
        <SiteImage
          src={featuredImageUrl}
          alt={title}
          fill
          ratio="21 / 9"
          priority
          sizes="(max-width: 1200px) 100vw, 1200px"
        />
        {/*
          The text sits over the photograph, so it needs its own scrim —
          `--surface-scrim` is the token the design system already uses for
          exactly this, rather than a new colour. Absolute only where there is
          room for it: below the breakpoint the overlay becomes a stack, since
          a 44px display title over a phone-width photo does not fit.
        */}
        <div className="c4t-post-hero-overlay">
          <div className="c4t-post-hero-scrim" aria-hidden="true" />
          <div style={{ position: 'relative' }}>{children}</div>
        </div>
      </div>
    )
  }

  if (layout === 'SPLIT' && sideImage) {
    return (
      <div className="c4t-post-split">
        <div>{children}</div>
        <SiteImage
          src={sideImage}
          alt={title}
          fill
          ratio="4 / 3"
          priority
          sizes="(max-width: 900px) 100vw, 560px"
        />
      </div>
    )
  }

  // GALLERY leads with its grid in the body, so no image here.
  if (layout === 'GALLERY') return <>{children}</>

  return (
    <>
      {children}
      {featuredImageUrl ? (
        <SiteImage
          src={featuredImageUrl}
          alt={title}
          fill
          ratio="16 / 9"
          priority
          sizes="(max-width: 1200px) 100vw, 1200px"
          style={{ marginTop: 'var(--space-8)' }}
        />
      ) : null}
    </>
  )
}
