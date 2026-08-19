import { GoogleMark } from '@/components/GoogleMark'
import { env } from '@/lib/env'

export interface GoogleButtonProps {
  /**
   * Which role to create if this Google account is new to the platform.
   * Ignored when the account already exists — an existing user signs into the
   * account they already have, whichever button they pressed.
   */
  role?: 'customer' | 'tester'
  /** Same-origin path to land on afterwards. Validated server-side. */
  next?: string
  /** Button text. "Continue with" on sign-in, "Sign up with" on registration. */
  label?: string
}

/**
 * "Continue with Google".
 *
 * A PLAIN LINK, NOT A FORM OR A CLIENT HANDLER. OAuth begins with a top-level
 * browser navigation to Google's consent screen, so an anchor is exactly the
 * right element: it works without JavaScript, it is keyboard and
 * middle-click friendly, and it keeps this a Server Component.
 *
 * It points straight at the API's own origin (`env.API_ORIGIN`) — the same
 * server the other auth flows already call directly (see
 * `lib/auth/actions.ts`'s `new URL('/v1/auth/...', env.API_ORIGIN)` calls).
 * There is no same-origin rewrite to lean on: `next.config.ts` deliberately
 * has none in the Vercel + Render split deploy, so a relative `/api/v1/...`
 * link 404s on Vercel's own domain instead of ever reaching the API. This
 * link has to carry the full origin because, unlike a fetch, the browser
 * itself follows it — Google's redirect has to land on wherever the API's
 * `GET /v1/auth/google/callback` route actually lives, which is the API's
 * origin, not the web app's.
 */
export function GoogleButton({ role, next, label = 'Continue with Google' }: GoogleButtonProps) {
  const params = new URLSearchParams()
  if (role) params.set('role', role)
  if (next) params.set('next', next)
  const query = params.toString()

  const href = new URL(`/v1/auth/google${query ? `?${query}` : ''}`, env.API_ORIGIN).toString()

  return (
    <a
      href={href}
      className="c4t-btn c4t-btn--secondary"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-3)',
        width: '100%',
        height: 48,
        padding: '0 var(--space-5)',
        background: 'var(--surface-canvas)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-button)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--type-button-md-size)',
        fontWeight: 'var(--fw-medium)',
        textDecoration: 'none',
        transition: 'var(--transition-control)',
      }}
    >
      <GoogleMark size={18} />
      {label}
    </a>
  )
}

/**
 * The "or" rule between the Google button and the password form.
 *
 * The line is drawn with two flex children rather than a border on the text,
 * so it stretches to whatever width the form is without a fixed measurement.
 */
export function AuthDivider({ label = 'or' }: { label?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-4)',
        margin: 'var(--space-6) 0',
      }}
    >
      <span style={{ flex: 1, height: 1, background: 'var(--border-default)' }} />
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--text-muted)',
        }}
      >
        {label}
      </span>
      <span style={{ flex: 1, height: 1, background: 'var(--border-default)' }} />
    </div>
  )
}
