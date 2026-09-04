import ResetPasswordForm from '../../reset-password/form'
import { AuthCard } from '@/components/auth/AuthCard'
import { AuthModal } from '@/components/auth/AuthModal'

/**
 * `/reset-password` intercepted from inside the marketing site.
 *
 * Mostly a completeness measure. The real route into this screen is a link in
 * an email, which is a hard load with no page underneath, so that path renders
 * the standalone page and always will. This exists so that a client-side
 * navigation here — from anywhere that might later link to it — behaves like
 * every other auth screen rather than being the one that throws the reader
 * out of the dialog.
 */
export default async function ResetPasswordModal({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>
}) {
  const params = await searchParams

  return (
    <AuthModal>
      <AuthCard inDialog>
        <ResetPasswordForm searchParams={Promise.resolve(params)} />
      </AuthCard>
    </AuthModal>
  )
}
