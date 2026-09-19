'use client'

import { useActionState, useEffect } from 'react'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { HrAuthNotice } from '../HrAuthCard'
import { hrResetPasswordAction, type HrResetPasswordState } from '@/lib/hrms/hr-password-actions'
import { hrBrowserNavigate } from '@/lib/hrms/hr-browser-navigate'

/**
 * Holds the action's result instead of bouncing back through
 * `?error=...` — see `hr-password-actions.ts` for why a redirect to
 * `/reset-password` landed on the marketing site's page of the same name.
 *
 * The one navigation left is the successful one, and it is a real browser
 * navigation for the same reason: `/login` collides too, and only a genuine
 * request passes back through the hostname rewrite.
 */

const ERROR_MESSAGES: Record<string, string> = {
  missing: 'Enter a new password.',
  missing_token: 'This link is missing its token. Request a new one.',
  mismatch: "The two passwords don't match.",
  invalid: 'This link is invalid, expired or already used. Request a new one.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  network: 'Could not reach the sign-in service. Check your connection and retry.',
}

export function HrResetPasswordForm({ token, invite }: { token: string; invite: boolean }) {
  const [state, formAction] = useActionState<HrResetPasswordState, FormData>(
    hrResetPasswordAction,
    {},
  )
  const error = state.error ? (ERROR_MESSAGES[state.error] ?? 'Something went wrong.') : null

  useEffect(() => {
    if (state.done) hrBrowserNavigate('/login?notice=password_reset')
  }, [state.done])

  return (
    <>
      {error ? (
        <HrAuthNotice tone="error" icon="alert-triangle">
          {error}
        </HrAuthNotice>
      ) : null}

      <form
        action={formAction}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
      >
        <input type="hidden" name="token" value={token} />
        {invite ? <input type="hidden" name="invite" value="1" /> : null}

        <Field
          label={invite ? 'Password' : 'New password'}
          htmlFor="password"
          required
          hint="At least 12 characters."
        >
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

        <Field
          label={invite ? 'Confirm password' : 'Confirm new password'}
          htmlFor="confirmPassword"
          required
        >
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
          {invite ? 'Set my password' : 'Set new password'}
        </SubmitButton>
      </form>
    </>
  )
}
