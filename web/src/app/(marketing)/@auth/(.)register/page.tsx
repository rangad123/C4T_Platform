import RegisterForm from '../../register/form'
import { AuthCard } from '@/components/auth/AuthCard'
import { AuthModal } from '@/components/auth/AuthModal'

/**
 * `/register` intercepted from inside the marketing site — the sign-up half of
 * `(.)login`, and the same reasoning: the form is imported from the standalone
 * route so the two cannot drift, and only the frame differs.
 *
 * This covers tester and customer registration alike; which one is being
 * created is the `role` search param the form already reads, not a separate
 * screen.
 */
export default async function RegisterModal({
  searchParams,
}: {
  searchParams: Promise<{
    role?: string
    error?: string
    detail?: string
    email?: string
    firstName?: string
    lastName?: string
    organisationName?: string
    next?: string
  }>
}) {
  const params = await searchParams
  return (
    <AuthModal wide>
      <AuthCard wide>
        <RegisterForm searchParams={Promise.resolve(params)} />
      </AuthCard>
    </AuthModal>
  )
}
