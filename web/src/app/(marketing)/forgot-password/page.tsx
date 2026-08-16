import { Logo } from '@/components/ds/core/Logo'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Button } from '@/components/ds/core/Button'
import { Icon } from '@/components/ds/core/Icon'
import { forgotPasswordAction } from '@/lib/auth/actions'

/**
 * `/forgot-password` — request a password-reset email.
 *
 * The Server Action hits `POST /v1/auth/forgot-password` and the API returns
 * 200 unconditionally whether the email matched an account or not, so the
 * page never reveals whether the address exists. The redirect carries the
 * typed email back so the next page can show it in the input — useful when the
 * user typed it in another tab and wants to confirm what they asked for.
 */
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; error?: string }>
}) {
  const { email: emailParam = '', error } = await searchParams
  const sent = !error && emailParam.length > 0

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-9)' }}>
        <Logo size={32} withWordmark />
      </div>

      <div
        style={{
          padding: 'var(--space-9)',
          background: 'var(--surface-canvas)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-card)',
        }}
      >
        <h1 className="c4t-heading-lg" style={{ marginBottom: 'var(--space-3)' }}>
          {sent ? 'Check your inbox' : 'Reset your password'}
        </h1>
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: 'var(--type-body-sm-size)',
            marginBottom: 'var(--space-7)',
          }}
        >
          {sent ? (
            <>
              If an account exists for <strong>{emailParam}</strong>, we sent a reset link.
              The link expires in 60 minutes.
            </>
          ) : (
            <>
              Enter the email you signed up with and we will send you a link to
              choose a new password.
            </>
          )}
        </p>

        {error === 'network' ? (
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
            <span>Could not reach the sign-in service. Check your connection and try again.</span>
          </div>
        ) : null}

        <form
          action={forgotPasswordAction}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
        >
          <Field label="Email" htmlFor="email" required>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              defaultValue={emailParam}
              placeholder="you@company.com"
              iconLeft="mail"
            />
          </Field>

          <Button type="submit" variant="primary" size="lg" fullWidth iconRight="arrow-right">
            Send reset link
          </Button>
        </form>

        <div
          style={{
            marginTop: 'var(--space-7)',
            paddingTop: 'var(--space-6)',
            borderTop: '1px solid var(--border-default)',
            fontSize: 'var(--type-body-sm-size)',
            color: 'var(--text-secondary)',
            textAlign: 'center',
          }}
        >
          Remembered your password?{' '}
          <a
            href="/login"
            style={{
              color: 'var(--text-brand)',
              textDecoration: 'underline',
              textUnderlineOffset: 3,
            }}
          >
            Sign in
          </a>
        </div>
      </div>
    </div>
  )
}
