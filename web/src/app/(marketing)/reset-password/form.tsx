import Link from 'next/link'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Icon } from '@/components/ds/core/Icon'
import { resetPasswordAction } from '@/lib/auth/actions'

const ERROR_MESSAGES: Record<string, string> = {
  missing: 'Enter a new password to continue.',
  network: 'Could not reach the sign-in service. Check your connection and try again.',
  expired: 'This reset link is invalid, expired, or already used. Request a new one and try again.',
  password_mismatch: 'Those passwords do not match. Type it the same way twice.',
  failed: 'We could not update your password. Request a new link and try again.',
}

/**
 * The shared "choose a new password" form.
 *
 * Split from the page like `login/form.tsx`, so the standalone route and the
 * dialog at `@auth/(.)reset-password` render one form rather than two copies.
 *
 * In practice this one is almost always the full page: it is reached from a
 * link in an email, which is a hard load with no page underneath for a dialog
 * to sit over. The intercepted variant exists so that IF something inside the
 * site ever links here, it behaves like the rest of the auth screens instead
 * of being the one that navigates away.
 */
export default async function ResetPasswordForm({
  searchParams,
}: {
  searchParams?: Promise<{ token?: string; error?: string }>
} = {}) {
  const params = searchParams ? await searchParams : { token: undefined, error: undefined }
  const token = params.token ?? ''
  const error = params.error

  return (
    <>
      <h1 className="c4t-heading-lg" style={{ marginBottom: 'var(--space-3)' }}>
        Choose a new password
      </h1>
      <p
        style={{
          color: 'var(--text-secondary)',
          fontSize: 'var(--type-body-sm-size)',
          marginBottom: 'var(--space-6)',
        }}
      >
        At least 12 characters. A long phrase beats a short scramble.
      </p>

      {error && ERROR_MESSAGES[error] ? (
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
          <span>{ERROR_MESSAGES[error]}</span>
        </div>
      ) : null}

      {token ? (
        <form
          action={resetPasswordAction}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
        >
          <input type="hidden" name="token" value={token} />

          <Field label="New password" htmlFor="password" required>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={200}
              required
              showPasswordToggle
            />
          </Field>

          <Field label="Confirm new password" htmlFor="confirmPassword" required>
            <Input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={200}
              required
              showPasswordToggle
            />
          </Field>

          <SubmitButton
            variant="primary"
            size="lg"
            fullWidth
            iconRight="arrow-right"
            pendingLabel="Updating…"
          >
            Update password
          </SubmitButton>
        </form>
      ) : (
        <p
          role="alert"
          style={{
            color: 'var(--text-secondary)',
            fontSize: 'var(--type-body-sm-size)',
          }}
        >
          This page expects a reset link. Open the one we sent in your email.
        </p>
      )}

      <div
        style={{
          marginTop: 'var(--space-6)',
          paddingTop: 'var(--space-5)',
          borderTop: '1px solid var(--border-default)',
          fontSize: 'var(--type-body-sm-size)',
          color: 'var(--text-secondary)',
          textAlign: 'center',
        }}
      >
        Already updated?{' '}
        {/* `Link replace`, not a bare `<a>` — see the note in
            `forgot-password/form.tsx` for both halves of that. */}
        <Link
          href="/login"
          replace
          style={{
            color: 'var(--text-brand)',
            textDecoration: 'underline',
            textUnderlineOffset: 3,
          }}
        >
          Sign in
        </Link>
      </div>
    </>
  )
}
