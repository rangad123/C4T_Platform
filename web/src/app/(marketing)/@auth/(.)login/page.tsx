import { redirect } from 'next/navigation'
import { getUser } from '@/lib/auth/session'
import { ROLE_HOME } from '@/lib/api/types'
import { safeNextOrHome } from '@/lib/safe-redirect'
import LoginForm from '../../login/form'
import { AuthCard } from '@/components/auth/AuthCard'
import { AuthModal } from '@/components/auth/AuthModal'

/**
 * `/login` intercepted from inside the marketing site, rendered as a dialog
 * over whatever the reader was already looking at.
 *
 * The FORM is imported from the standalone route rather than copied, so the
 * two cannot drift: one set of fields, one action, one set of error codes.
 * Only the frame differs.
 *
 * The signed-in redirect is repeated here on purpose. This is a real route
 * with its own server render, so it needs its own guard — without it, a
 * signed-in visitor clicking "Sign in" would get a dialog asking them to sign
 * in again. `AuthPage` is deliberately absent: `AuthModal` supplies the
 * centring the page wrapper would.
 */
export default async function LoginModal({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; email?: string; notice?: string }>
}) {
  const params = await searchParams

  const user = await getUser()
  if (user) redirect(safeNextOrHome(params.next, ROLE_HOME[user.role]))

  return (
    <AuthModal>
      <AuthCard>
        <LoginForm searchParams={Promise.resolve(params)} />
      </AuthCard>
    </AuthModal>
  )
}
