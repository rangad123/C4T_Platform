import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Icon } from '@/components/ds/core/Icon'
import { hrLoginAction } from '@/lib/hrms/hr-actions'

/**
 * The HRMS sign-in form. Structural copy of `(marketing)/login/form.tsx`
 * minus Google sign-in and the register/forgot-password links — HRMS has
 * neither: employees are provisioned by an admin, not self-registered, and
 * there is no self-serve password reset yet.
 */

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: 'That email and password did not match. Try again.',
  account_locked:
    'This account is temporarily locked after repeated failed attempts. Try again in a few minutes.',
  account_unavailable: 'This account is no longer active. Contact an administrator.',
  network: 'Could not reach the sign-in service. Check your connection and retry.',
  missing: 'Enter your email and password to continue.',
}

function errorMessage(code: string | undefined): string | null {
  if (!code) return null
  return ERROR_MESSAGES[code] ?? 'Sign-in failed. Please try again.'
}

export default async function HrLoginForm({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; email?: string }>
}) {
  const params = await searchParams
  const message = errorMessage(params.error)
  const preservedEmail = params.email ?? ''

  return (
    <div>
      <h1 className="c4t-heading-lg" style={{ marginBottom: 'var(--space-3)' }}>
        HRMS sign in
      </h1>
      <p
        style={{
          margin: '0 0 var(--space-6)',
          fontSize: 'var(--type-body-sm-size)',
          color: 'var(--text-secondary)',
        }}
      >
        Crowd4Test staff only.
      </p>

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
        action={hrLoginAction}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
      >
        <input type="hidden" name="next" value={params.next ?? ''} />

        <Field label="Email" htmlFor="email" required>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            defaultValue={preservedEmail}
            placeholder="you@crowd4test.com"
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

        <SubmitButton
          variant="primary"
          size="lg"
          fullWidth
          iconRight="arrow-right"
          pendingLabel="Signing in…"
        >
          Sign in
        </SubmitButton>
      </form>
    </div>
  )
}
