import { Hero, SiteImage } from '@/components/ds'
import s from '@/components/sections/sections.module.css'
import { HOME_HERO, PHOTOS } from '@/content'

/**
 * The homepage hero.
 *
 * Extracted from `app/(marketing)/page.tsx` because it has a second caller:
 * `AuthPage` renders it, inert, as the page BEHIND a standalone auth screen.
 *
 * ── WHY AN AUTH SCREEN NEEDS A HERO
 *
 * Sign-in, register and the password screens open as a dialog over whatever
 * you were reading — except when they cannot. A pasted link, an emailed
 * link, a protected route bouncing to sign-in, and the OAuth callback coming
 * back from Google are all hard loads with no page underneath, so the dialog
 * has nothing to sit over and the standalone page renders instead.
 *
 * That page used to be a full-bleed dark band, which read as a different
 * screen entirely — the same complaint that got the modal removed once
 * before. Putting real site content behind the card closes the gap: a dialog
 * only ever reveals about one viewport of what is behind it, and this is
 * what that viewport looks like when you open sign-in from the homepage.
 *
 * One definition, two callers, so the two cannot drift.
 */
export function HomeHero({ priority = true }: { priority?: boolean }) {
  return (
    <Hero
      className={s.deep}
      tone="inverse"
      // No eyebrow: it repeated the opening of the headline word for word.
      // See the note in content/home.ts.
      title={HOME_HERO.title}
      // Tints the closing "Human Intelligence" in the accent. Teal-100 on
      // this dark band, not teal-500 — see the note in Hero.
      titleHighlight={HOME_HERO.titleHighlight}
      description={HOME_HERO.description}
      primaryCta={HOME_HERO.primaryCta}
      primaryHref="/contact"
      secondaryCta={HOME_HERO.secondaryCta}
      secondaryHref="/contact"
      bullets={[
        '2-week pilot · Fixed scope',
        'Named QA lead on every engagement',
        'Results triaged in your Jira',
      ]}
      trustLine={HOME_HERO.trustLine}
      // The headline is long — nine words — and at the default measure it
      // broke over four lines, which reads as a paragraph rather than a
      // statement. `copy-led` narrows the media column and lifts the copy
      // cap so it sets in three. The art loses width; it is a wide
      // illustration and crops to the same 4:3 box either way.
      mediaWidth="copy-led"
      media={
        // The brand artwork. This slot held `public/home.mp4` until the
        // still was supplied; the geometry is unchanged, because the mask,
        // the upward nudge and the container bleed all describe a rectangle
        // rather than an element type. See `.c4t-hero-media` in
        // overrides.css and the `heroLanding` note in content/media.ts.
        <SiteImage
          src={PHOTOS.heroLanding.src}
          alt={PHOTOS.heroLanding.alt}
          fill
          // `priority` because this IS the LCP element on the homepage.
          // Without it Next lazy-loads the hero, which is the one image on
          // the site that must never wait.
          //
          // FALSE behind an auth screen. There it is scenery, and preloading
          // it would push the one thing the visitor actually came for — the
          // sign-in form — behind a decorative image in the queue.
          priority={priority}
          // The frame renders at ~610px in the container and up to ~830px
          // once the bleed applies, so the browser never needs a
          // full-viewport asset here. Left at the container's real ceiling
          // rather than the default 50vw, which over-fetches on wide screens.
          sizes="(max-width: 900px) 100vw, 830px"
          // No rounded corners: the edges are feathered to transparent by
          // the mask, so there is no visible corner left to round.
          radius="0"
          // MUST BE INLINE. <SiteImage> sets `background: var(--surface-sunken)`
          // as an inline style so a slow load shows a surface instead of a
          // hole. Inline beats any external stylesheet, so the `background:
          // transparent` in overrides.css does NOT win — measured at
          // rgb(241,237,232) on the rendered wrapper. On this hero that light
          // floor shows straight through the feathered edges as a pale
          // rectangle on the ink-950 band, which is precisely what the mask
          // exists to avoid. SiteImage spreads `style` last, so this overrides
          // it. Removing this line silently brings the rectangle back.
          style={{ background: 'transparent' }}
          // ALL geometry lives in overrides.css against this class, and
          // deliberately so: this slot previously carried an inline
          // `width: 100%`, and an inline style outranks any external
          // stylesheet rule short of `!important`. That silently defeated the
          // width rule in overrides.css — the mask and the vertical nudge
          // applied, because neither is an inline property, but every attempt
          // to widen the frame was overridden and had no effect. Keeping the
          // box model in one place is what stops that recurring.
          className="c4t-hero-media"
        />
      }
    />
  )
}
