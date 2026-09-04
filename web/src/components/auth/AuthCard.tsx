import type { ReactNode } from 'react'
import { Logo } from '@/components/ds/core/Logo'
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
}: {
  children: ReactNode
  /** The two password screens render flat. */
  raised?: boolean
}) {
  return <div className={`${styles.card} ${raised ? styles.raised : ''}`.trim()}>{children}</div>
}

/**
 * The centred column an auth card sits in, with the page padding that shrinks
 * alongside the card's own on a narrow viewport.
 */
export function AuthPage({
  children,
  withLogo = false,
  compact = false,
}: {
  children: ReactNode
  /** The two password screens show the wordmark above the card. */
  withLogo?: boolean
  /** Register's smaller top padding, preserved from before this was shared. */
  compact?: boolean
}) {
  return (
    <div className={`${styles.wrap} ${compact ? styles.compact : ''}`.trim()}>
      {withLogo ? (
        <div className={styles.logo}>
          {/* `inverse` because `.wrap` now sits on the dark band — the
              default tone is ink, which would be invisible on it. */}
          <Logo size={32} withWordmark tone="inverse" />
        </div>
      ) : null}
      {children}
    </div>
  )
}
