import Link from 'next/link'
import { Icon } from '@/components/ds/core/Icon'
import { Logo } from '@/components/ds/core/Logo'
import { Button } from '@/components/ds/core/Button'
import { logoutAction } from '@/lib/auth/actions'

/**
 * The "portal not yet available" placeholder.
 *
 * This is what customer and tester accounts see when they sign in. The admin
 * portal is the only one currently open — the other two are still being built
 * and silently showing a half-built scaffold gave the wrong impression of the
 * product. Displaying a clear, honest holding page instead is the difference
 * between "we forgot this" and "it's on the way".
 *
 * The page is deliberately not a 404: the user is signed in, they are reaching
 * the right place, and the page explains why nothing is there and what they can
 * do about it. The screen renders inside the authenticated app layout, so the
 * header still belongs to the platform — the home button is the only one shown.
 *
 * Calls sign-out rather than offering a "go back" link because there is nowhere
 * to go back to that is not the same kind of placeholder. The sign-out form
 * targets the topbar's sign-out via the same server action, so cookies get
 * cleared on the same origin.
 */
export function PortalNotReady() {
  return (
    <main
      id="main"
      style={{
        maxWidth: 540,
        margin: '0 auto',
        padding: 'var(--space-13) var(--space-7)',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          marginBottom: 'var(--space-3)',
        }}
      >
        <Logo size={32} withWordmark />
      </div>

      <span
        className="c4t-eyebrow"
        style={{ color: 'var(--text-muted)' }}
      >
        Coming soon
      </span>

      <h1
        className="c4t-display-md"
        style={{
          margin: 0,
          textWrap: 'balance',
          color: 'var(--text-primary)',
        }}
      >
        Your portal is on the way
      </h1>

      <p
        style={{
          margin: 0,
          color: 'var(--text-secondary)',
          fontSize: 'var(--type-body-md-size)',
          lineHeight: 1.6,
        }}
      >
        You are signed in. The workspace for your account type is still being built
        — we will let you know when it opens.
      </p>

      <div
        style={{
          display: 'flex',
          gap: 'var(--space-3)',
          justifyContent: 'center',
          marginTop: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        <Button variant="primary" href="/" iconLeft="arrow-left">
          Back to the site
        </Button>
        <form action={logoutAction}>
          <Button type="submit" variant="secondary" iconLeft="log-out">
            Sign out
          </Button>
        </form>
      </div>

      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          marginTop: 'var(--space-5)',
          color: 'var(--text-muted)',
          fontSize: 'var(--type-caption-size)',
        }}
      >
        <Icon name="info" size={14} />
        Questions? Email support@crowd4test.com
      </span>
    </main>
  )
}
