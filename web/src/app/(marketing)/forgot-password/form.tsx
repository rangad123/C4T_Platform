import Link from 'next/link'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Icon } from '@/components/ds/core/Icon'
import { forgotPasswordAction } from '@/lib/auth/actions'

/**
 * The shared "email me a reset link" form.
 *
 * Split from the page for the same reason `login/form.tsx` is: two callers
 * render it — the standalone `/forgot-password` and the dialog at
 * `@auth/(.)forgot-password` — and only the frame differs. Copying it would
 * let the two drift in exactly the place a user notices least and trusts
 * most.
 *
 * The Server Action hits `POST /v1/auth/forgot-password`, which returns 200
 * whether or not the address matched an account, so this never reveals who
 * has one. The redirect carries the typed email back so the confirmation can
 * name it.
 */
export default async function ForgotPasswordForm({
  searchParams,
}: {
  searchParams?: Promise<{ email?: string; error?: string }>
} = {}) {
  const params = searchParams ? await searchParams : { email: undefined, error: undefined }
  const emailParam = params.email ?? ''
  const sent = !params.error && emailParam.length > 0

  return (
    <>
      <h1 className="c4t-heading-lg" style={{ marginBottom: 'var(--space-3)' }}>
        {sent ? 'Check your inbox' : 'Reset your password'}
      </h1>
      <p
        style={{
          color: 'var(--text-secondary)',
          fontSize: 'var(--type-body-sm-size)',
          marginBottom: 'var(--space-6)',
        }}
      >
        {sent ? (
          <>
            If an account exists for <strong>{emailParam}</strong>, we sent a reset link. The link
            expires in 60 minutes.
          </>
        ) : (
          <>
            Enter the email you signed up with and we will send you a link to choose a new password.
          </>
        )}
      </p>

      {params.error === 'network' ? (
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

        <SubmitButton
          variant="primary"
          size="lg"
          fullWidth
          iconRight="arrow-right"
          pendingLabel="Sending…"
        >
          Send reset link
        </SubmitButton>
      </form>

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
        Remembered your password?{' '}
        {/*
          `Link`, not a bare `<a>`. An anchor is a full page load, which means
          the intercepting route never fires and the reader is thrown out of
          the dialog onto a whole new page — the exact bug that stopped the
          register modal opening from sign-in. `replace` because sign-in and
          the password screens are one modal to the reader: moving between
          them must not stack history entries, or closing walks back through
          each screen visited instead of returning to the page underneath.
        */}
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
