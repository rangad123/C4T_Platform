import type { Metadata } from 'next'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { hrForgotPasswordAction } from '@/lib/hrms/hr-password-actions'
import { HrAuthCard, HrAuthNotice } from '../HrAuthCard'

export const metadata: Metadata = {
  title: 'Forgot password',
  robots: { index: false, follow: false },
}

const ERROR_MESSAGES: Record<string, string> = {
  missing: 'Enter the email address you sign in with.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  network: 'Could not reach the sign-in service. Check your connection and retry.',
}

export default async function HrForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>
}) {
  const params = await searchParams
  const error = params.error ? (ERROR_MESSAGES[params.error] ?? 'Something went wrong.') : null

  return (
    <HrAuthCard
      title="Forgot your password?"
      subtitle="We'll email you a link to set a new one."
      footer={{ href: '/login', label: 'Back to sign in' }}
    >
      {params.sent ? (
        <HrAuthNotice tone="success" icon="check-circle-2">
          If that address belongs to an active employee, a reset link is on its way. The link
          expires in 60 minutes.
        </HrAuthNotice>
      ) : null}
      {error ? (
        <HrAuthNotice tone="error" icon="alert-triangle">
          {error}
        </HrAuthNotice>
      ) : null}

      <form
        action={hrForgotPasswordAction}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
      >
        <Field label="Email" htmlFor="email" required>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@crowd4test.com"
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
    </HrAuthCard>
  )
}
