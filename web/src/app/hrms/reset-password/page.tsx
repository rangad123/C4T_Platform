import type { Metadata } from 'next'
import { HrAuthCard, HrAuthNotice } from '../HrAuthCard'
import { HrResetPasswordForm } from './form'

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

export default async function HrResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; invite?: string }>
}) {
  const params = await searchParams
  const token = params.token ?? ''
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
      <HrResetPasswordForm token={token} invite={invite} />
    </HrAuthCard>
  )
}
