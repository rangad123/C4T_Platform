import type { Metadata } from 'next'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { hrResetPasswordAction } from '@/lib/hrms/hr-password-actions'
import { HrAuthCard, HrAuthNotice } from '../HrAuthCard'

/** The tab title has to follow the copy — an invitee is not resetting anything. */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string }>
}): Promise<Metadata> {
  const { invite } = await searchParams
  return {
    title: invite === '1' ? 'Choose your password' : 'Set a new password',
    robots: { index: false, follow: false },
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  missing: 'Enter a new password.',
  mismatch: "The two passwords don't match.",
  invalid: 'This link is invalid, expired or already used. Request a new one.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  network: 'Could not reach the sign-in service. Check your connection and retry.',
}

export default async function HrResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string; invite?: string }>
}) {
  const params = await searchParams
  const token = params.token ?? ''
  const error = params.error ? (ERROR_MESSAGES[params.error] ?? 'Something went wrong.') : null
  /**
   * An invitation and a reset are the same token, the same form and the same
   * endpoint — only the words differ. Someone who has never had a password
   * should not be told to reset one, and someone whose invitation has lapsed
   * should be told to ask HR rather than to use a "forgot password" link for
   * an account they cannot sign in to.
   */
  const invite = params.invite === '1'

  // A link with no token at all cannot be recovered by filling the form in.
  if (!token) {
    return (
      <HrAuthCard
        title={invite ? 'Choose your password' : 'Set a new password'}
        footer={
          invite
            ? { href: '/login', label: 'Back to sign in' }
            : { href: '/forgot-password', label: 'Request a new link' }
        }
      >
        <HrAuthNotice tone="error" icon="alert-triangle">
          {invite
            ? 'This invitation link is incomplete. Ask your HR administrator to send a new one.'
            : 'This link is missing its reset token. Request a new one.'}
        </HrAuthNotice>
      </HrAuthCard>
    )
  }

  return (
    <HrAuthCard
      title={invite ? 'Choose your password' : 'Set a new password'}
      subtitle={
        invite
          ? 'Welcome to Crowd4Test HRMS. Pick a password of at least 12 characters to finish setting up your account.'
          : 'Choose a password of at least 12 characters.'
      }
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
    </HrAuthCard>
  )
}
