import type { Metadata } from 'next'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { hrResetPasswordAction } from '@/lib/hrms/hr-password-actions'
import { HrAuthCard, HrAuthNotice } from '../HrAuthCard'

export const metadata: Metadata = {
  title: 'Set a new password',
  robots: { index: false, follow: false },
}

const ERROR_MESSAGES: Record<string, string> = {
  missing: 'Enter a new password.',
  mismatch: "The two passwords don't match.",
  invalid: 'This reset link is invalid, expired or already used. Request a new one.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  network: 'Could not reach the sign-in service. Check your connection and retry.',
}

export default async function HrResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>
}) {
  const params = await searchParams
  const token = params.token ?? ''
  const error = params.error ? (ERROR_MESSAGES[params.error] ?? 'Something went wrong.') : null

  // A link with no token at all cannot be recovered by filling the form in.
  if (!token) {
    return (
      <HrAuthCard
        title="Set a new password"
        footer={{ href: '/forgot-password', label: 'Request a new link' }}
      >
        <HrAuthNotice tone="error" icon="alert-triangle">
          This link is missing its reset token. Request a new one.
        </HrAuthNotice>
      </HrAuthCard>
    )
  }

  return (
    <HrAuthCard
      title="Set a new password"
      subtitle="Choose a password of at least 12 characters."
      footer={{ href: '/login', label: 'Back to sign in' }}
    >
      {error ? (
        <HrAuthNotice tone="error" icon="alert-triangle">
          {error}
        </HrAuthNotice>
      ) : null}

      <form
        action={hrResetPasswordAction}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
      >
        <input type="hidden" name="token" value={token} />

        <Field label="New password" htmlFor="password" required hint="At least 12 characters.">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            iconLeft="lock"
            showPasswordToggle
          />
        </Field>

        <Field label="Confirm new password" htmlFor="confirmPassword" required>
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            iconLeft="lock"
            showPasswordToggle
          />
        </Field>

        <SubmitButton
          variant="primary"
          size="lg"
          fullWidth
          iconRight="arrow-right"
          pendingLabel="Saving…"
        >
          Set new password
        </SubmitButton>
      </form>
    </HrAuthCard>
  )
}
