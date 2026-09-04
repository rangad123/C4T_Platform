import type { ReactNode } from 'react'
import { HomeHero } from '@/components/sections/HomeHero'
import styles from './AuthCard.module.css'

/**
 * The panel that holds an auth form.
 *
 * Sign in, register, forgot password and reset password each rendered their
 * own copy of the same inline styles, and `AuthBackdrop` a fifth. They were
 * identical apart from the shadow, which meant the padding could not be made
 * responsive without editing five files — see the media query in the CSS
 * module for why it had to become responsive.
 *
 * The `<dialog>` that intercepts `/login` and `/register` from the nav reuses
 * this same card — see `AuthModal`, which supplies the backdrop and centring
 * where `AuthPage` supplies the page's. One card, two frames, so the dialog
 * and the standalone page cannot drift apart.
 *
 * `AuthPage` puts the standalone form on the dark band. That is what closes
 * the gap the earlier attempt at this fell into: the dialog is dimmed over the
 * site, and a hard load — a refresh, an emailed link, a bounce from a
 * protected route — now lands on the same ground rather than a sheet of white.
 */
export function AuthCard({
  children,
  raised = true,
  wide = false,
  inDialog = false,
}: {
  children: ReactNode
  /**
   * The card's shadow. Every screen carries it now that all of them float
   * over a scrim; the two password screens used to render flat because they
   * sat on a plain page instead.
   */
  raised?: boolean
  /** The dialog's wider measure — see `.wide` in the CSS module. */
  wide?: boolean
  /**
   * Set by the two intercepted routes. `AuthModal` floats a close button over
   * this card's top-right corner, so the first row has to start below it —
   * register's header row put a "Sign in" link exactly there and the two
   * collided. The standalone pages have no close button and no such band.
   */
  inDialog?: boolean
}) {
  const classes = [
    styles.card,
    raised && styles.raised,
    wide && styles.wide,
    inDialog && styles.inDialog,
  ]
    .filter(Boolean)
    .join(' ')

  return <div className={classes}>{children}</div>
}

/**
 * The standalone presentation of an auth screen — sign in, register, the two
 * password screens, email preferences.
 *
 * ── IT LOOKS LIKE THE DIALOG, BECAUSE IT IS THE SAME SCREEN
 *
 * These routes exist for the arrivals a dialog cannot serve: a pasted or
 * emailed link, a protected route bouncing to sign-in, the redirect after
 * signing out, and the OAuth callback returning from Google. All are hard
 * loads with no page underneath, so `@auth/(.)*` never intercepts them.
 *
 * The first attempt at closing that gap put the card on a full-bleed dark
 * band. It matched the dialog's backdrop COLOUR, and it still read as a
 * different screen — a black page rather than something opened over the
 * site. So this now renders what a dialog actually renders over: real site
 * content, dimmed, with the card floating on top. A dialog only ever reveals
 * about one viewport of what is behind it, which is why the homepage HERO is
 * enough and the whole homepage would be waste.
 *
 * The backdrop is `inert` and `aria-hidden`: it is a picture of the site, not
 * a working copy of it. Nothing in it takes focus, answers a click, or
 * reaches a screen reader, so the card is the only thing on the page in every
 * sense that matters.
 *
 * `priority={false}` on the hero image. On the homepage that image is the LCP
 * element and must never wait; here it is scenery behind a form, and
 * preloading it would delay the one thing the visitor came for.
 */
export function AuthPage({
  children,
  wide = false,
}: {
  children: ReactNode
  /**
   * Register's wider measure, mirroring the dialog's `wide`. The two have to
   * agree: the whole point of this presentation is that arriving at register
   * by a hard load and by a click look like the same screen, and a card that
   * changes width between them would give that away immediately.
   */
  wide?: boolean
}) {
  return (
    <div className={styles.stage}>
      <div className={styles.backdrop} aria-hidden inert>
        <HomeHero priority={false} />
      </div>
      <div className={styles.scrim}>
        <div className={`${styles.stageCard} ${wide ? styles.stageCardWide : ''}`.trim()}>
          {children}
        </div>
      </div>
    </div>
  )
}
