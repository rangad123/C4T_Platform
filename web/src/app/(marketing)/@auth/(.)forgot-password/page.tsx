import ForgotPasswordForm from '../../forgot-password/form'
import { AuthCard } from '@/components/auth/AuthCard'
import { AuthModal } from '@/components/auth/AuthModal'

/**
 * `/forgot-password` intercepted from inside the marketing site.
 *
 * Sign-in already opened as a dialog, so "Forgot password" inside it dropping
 * the reader onto a full page was the seam in the flow: one click into a
 * modal, one click out of it, for what is the same task continued. The form
 * is imported from the standalone route rather than copied, so the two cannot
 * drift.
 *
 * No signed-in guard here, unlike `(.)login`. Asking to reset a password is
 * not a thing a session makes meaningless — someone signed in on one device
 * may well be recovering the account on another — and the API answers
 * identically either way.
 */
export default async function ForgotPasswordModal({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; error?: string }>
}) {
  const params = await searchParams

  return (
    <AuthModal>
      <AuthCard inDialog>
        <ForgotPasswordForm searchParams={Promise.resolve(params)} />
      </AuthCard>
    </AuthModal>
  )
}
