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
 * `variant="page"` is the card as it appears in the marketing layout;
 * `variant="modal"` is the same card inside the `<dialog>`, which does its
 * own centring and so needs no wrapper. Use `AuthPage` for the wrapper.
 */
export function AuthCard({
  children,
  variant = 'page',
  raised = true,
}: {
  children: ReactNode
  /** `page` sits on the marketing background, `modal` over a dimmed page. */
  variant?: 'page' | 'modal'
  /** The two password screens render flat. Ignored for the modal. */
  raised?: boolean
}) {
  const tone = variant === 'modal' ? styles.modal : raised ? styles.raised : ''
  return <div className={`${styles.card} ${tone}`.trim()}>{children}</div>
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
          <Logo size={32} withWordmark />
        </div>
      ) : null}
      {children}
    </div>
  )
}
