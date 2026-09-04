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
  /**
   * 'login' (the /login page) means the visitor expects to reach an EXISTING
   * account — the API will refuse to silently register one for a Google
   * identity it has never seen, and sends them to /register instead.
   * 'register' (default, the /register page) keeps the account-creation
   * behaviour: sign in if the identity is known, create one if not.
   */
  intent?: 'login' | 'register'
}

/**
 * "Continue with Google".
 *
 * A PLAIN LINK, NOT A FORM OR A CLIENT HANDLER. OAuth begins with a top-level
 * browser navigation to Google's consent screen, so an anchor is exactly the
 * right element: it works without JavaScript, it is keyboard and
 * middle-click friendly, and it keeps this a Server Component.
 *
 * ── WHY NOT `API_ORIGIN`
 *
 * It used to build this from `env.API_ORIGIN`, reasoning that the browser has
 * to reach the API's own `GET /v1/auth/google/callback`. True, but
 * `API_ORIGIN` is the origin THIS SERVER uses to reach the API, and on a
 * single-box deployment that is `http://127.0.0.1:4000` — the loopback
 * address of the machine reading it. Every other use of `API_ORIGIN` in this
 * app is a server-side `fetch`, where loopback is exactly right; this was the
 * one place the value was handed to a browser.
 *
 * The effect was silent and confusing rather than broken-looking: production
 * rendered `href="http://127.0.0.1:4000/v1/auth/google"`, so clicking it sent
 * the visitor to their OWN machine. For anyone without a local server they
 * got a connection error; for a developer running one, the entire sign-in ran
 * against their laptop, which then failed a state check and redirected to
 * localhost — a failure that looks like a broken deployment and is nothing of
 * the kind.
 *
 * `NEXT_PUBLIC_API_BASE` is the browser-facing address of the same API, which
 * is what a link the browser follows needs. It takes either shape:
 *   - a path (`/api/v1`, the default) where a proxy in front of both services
 *     routes it — the single-box nginx deployment;
 *   - an absolute origin, for the split deployment where the API is on a
 *     different host and no shared proxy exists.
 * Joining without `new URL()` keeps both working: a path stays relative to
 * whatever host the visitor is actually on.
 */
export function GoogleButton({
  role,
  next,
  label = 'Continue with Google',
  intent,
}: GoogleButtonProps) {
  const params = new URLSearchParams()
  if (role) params.set('role', role)
  if (next) params.set('next', next)
  if (intent) params.set('intent', intent)
  const query = params.toString()

  // Trailing slash trimmed so a base of `/api/v1/` does not produce `//auth`.
  const base = env.NEXT_PUBLIC_API_BASE.replace(/\/$/, '')
  const href = `${base}/auth/google${query ? `?${query}` : ''}`

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
        margin: 'var(--space-5) 0',
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
