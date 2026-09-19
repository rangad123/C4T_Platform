'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Icon } from '@/components/ds/core/Icon'
import { hrLoginAction, type HrLoginState } from '@/lib/hrms/hr-actions'

/**
 * The HRMS sign-in form.
 *
 * A client component holding the action's returned state, rather than a
 * Server Component reading `?error=` out of the URL. A failed sign-in used to
 * redirect back to `/login?error=...`, and on this hostname that redirect
 * landed on the MARKETING site's own `/login` page instead of this one — see
 * `hrLoginAction`'s comment for the full reason. Keeping the failure in
 * component state means no navigation happens at all, so there is nothing to
 * resolve wrongly, and the address someone typed stays out of their URL bar.
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

export default function HrLoginForm({ next, notice }: { next?: string; notice?: string }) {
  const [state, formAction] = useActionState<HrLoginState, FormData>(hrLoginAction, {})
  const message = errorMessage(state.error)

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

      {notice === 'password_reset' ? (
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
          <span>Your password has been set. Sign in with it below.</span>
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
        action={formAction}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
      >
        <input type="hidden" name="next" value={next ?? ''} />

        <Field label="Email" htmlFor="email" required>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            defaultValue={state.email ?? ''}
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

      <p
        style={{
          margin: 'var(--space-6) 0 0',
          fontSize: 'var(--type-body-sm-size)',
          textAlign: 'center',
        }}
      >
        <Link href="/forgot-password">Forgot your password?</Link>
      </p>
    </div>
  )
}
