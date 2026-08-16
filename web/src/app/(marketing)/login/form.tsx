import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Button } from '@/components/ds/core/Button'
import { Icon } from '@/components/ds/core/Icon'
import { AuthDivider, GoogleButton } from '@/components/auth/GoogleButton'
import { loginAction } from '@/lib/auth/actions'

/**
 * The shared sign-in form.
 *
 * Used by both `/login` (the full page) and `app/(marketing)/@auth/(.)login`
 * (the intercepting route that opens the form as a modal over the current
 * page). Same Server Component, same Server Action, same error mapping —
 * one source of truth for the form's behaviour.
 *
 * The form is a Server Component bound to `loginAction`. There is no
 * `useFormState`, no client bundle — feedback rides on the `?error=` query
 * parameter the action sets when a submission fails. That keeps the form
 * out of the client-component allowlist and means it works the same with
 * JS disabled.
 *
 * Open-redirect prevention is the action's job, not the page's: the form
 * only echoes `next` back into a hidden field. See `lib/safe-redirect.ts`.
 */

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: 'That email and password did not match. Try again.',
  email_not_verified: 'Verify your email before signing in. Check your inbox for the link we sent.',
  account_locked:
    'This account is temporarily locked after repeated failed attempts. Try again in a few minutes.',
  rate_limited: 'Too many sign-in attempts. Wait a minute and try again.',
  network: 'Could not reach the sign-in service. Check your connection and retry.',
  missing: 'Enter your email and password to continue.',
  google_unavailable:
    'Google sign-in is not configured on this deployment. Use email and password instead.',
  google_failed: 'Google sign-in did not complete. Try again, or use email and password.',
  google_state: 'That sign-in took too long. Try again.',
  google_rejected:
    'Google could not verify this email address, so it cannot sign you into an existing local account. Use email and password.',
  account_unavailable: 'This account is suspended or deactivated. Contact an administrator.',
  google_login_password_required:
    'This account uses Google sign-in. Use the Continue with Google button.',
}

function errorMessage(code: string | undefined): string | null {
  if (!code) return null
  return ERROR_MESSAGES[code] ?? 'Sign-in failed. Please try again.'
}

export default async function LoginForm({
  searchParams,
}: {
  searchParams?: Promise<{ next?: string; error?: string; email?: string; notice?: string }>
} = {}) {
  const params = searchParams ? await searchParams : { next: undefined, error: undefined, email: undefined, notice: undefined }
  const message = errorMessage(params.error)
  const preservedEmail = params.email ?? ''

  return (
    <div>
      <h1 className="c4t-heading-lg" style={{ marginBottom: 'var(--space-3)' }}>
        Sign in
      </h1>
      <p
        style={{
          color: 'var(--text-secondary)',
          fontSize: 'var(--type-body-sm-size)',
          marginBottom: 'var(--space-7)',
        }}
      >
        Sign in to your Crowd4Test workspace.
      </p>

      {params.notice === 'password_reset' ? (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--space-3)',
            padding: 'var(--space-4) var(--space-5)',
            marginBottom: 'var(--space-6)',
            background: 'var(--status-success-bg)',
            color: 'var(--status-success-fg)',
            borderRadius: 'var(--radius-input)',
            fontSize: 'var(--type-body-sm-size)',
            lineHeight: 1.45,
          }}
        >
          <Icon name="check-circle-2" size={18} style={{ flex: 'none', marginTop: 2 }} />
          <span>Your password has been updated. Sign in with your new password.</span>
        </div>
      ) : null}

      {message ? (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--space-3)',
            padding: 'var(--space-4) var(--space-5)',
            marginBottom: 'var(--space-6)',
            background: 'var(--status-error-bg)',
            color: 'var(--status-error-fg)',
            borderRadius: 'var(--radius-input)',
            fontSize: 'var(--type-body-sm-size)',
            lineHeight: 1.45,
          }}
        >
          <Icon name="alert-triangle" size={18} style={{ flex: 'none', marginTop: 2 }} />
          <span>{message}</span>
        </div>
      ) : null}

      <form
        action={loginAction}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
      >
        <GoogleButton next={params.next ?? undefined} label="Continue with Google" />
        <AuthDivider />

        <input type="hidden" name="next" value={params.next ?? ''} />

        <Field label="Email" htmlFor="email" required>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            defaultValue={preservedEmail}
            placeholder="you@company.com"
            iconLeft="mail"
          />
        </Field>

        <Field label="Password" htmlFor="password" required>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            iconLeft="lock"
            showPasswordToggle
          />
        </Field>

        <Button type="submit" variant="primary" size="lg" fullWidth iconRight="arrow-right">
          Sign in
        </Button>
      </form>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: 'var(--space-7)',
          paddingTop: 'var(--space-6)',
          borderTop: '1px solid var(--border-default)',
          fontSize: 'var(--type-body-sm-size)',
          color: 'var(--text-secondary)',
        }}
      >
        <a
          href="/forgot-password"
          style={{
            color: 'var(--text-brand)',
            textDecoration: 'underline',
            textUnderlineOffset: 3,
          }}
        >
          Forgot password
        </a>
        <a
          href="/register"
          style={{
            color: 'var(--text-brand)',
            textDecoration: 'underline',
            textUnderlineOffset: 3,
          }}
        >
          Create an account
        </a>
      </div>
    </div>
  )
}
