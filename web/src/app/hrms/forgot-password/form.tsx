'use client'

import { useActionState } from 'react'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { HrAuthNotice } from '../HrAuthCard'
import { hrForgotPasswordAction, type HrForgotPasswordState } from '@/lib/hrms/hr-password-actions'

/**
 * Holds the action's result rather than reading `?sent=1&error=...` back out
 * of the URL. See `hr-password-actions.ts` for why nothing here navigates:
 * `/forgot-password` exists twice in this app, and a redirect to it lands on
 * the marketing site's copy instead of this one.
 */

const ERROR_MESSAGES: Record<string, string> = {
  missing: 'Enter the email address you sign in with.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  network: 'Could not reach the sign-in service. Check your connection and retry.',
}

export function HrForgotPasswordForm() {
  const [state, formAction] = useActionState<HrForgotPasswordState, FormData>(
    hrForgotPasswordAction,
    {},
  )
  const error = state.error ? (ERROR_MESSAGES[state.error] ?? 'Something went wrong.') : null

  return (
    <>
      {state.sent ? (
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
        action={formAction}
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
    </>
  )
}
