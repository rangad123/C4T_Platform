import { AuthModal } from '@/components/auth/AuthBackdrop'
import RegisterForm from '@/app/(marketing)/register/form'

/**
 * The intercepting route for `/register`.
 *
 * Triggered when the user clicks a "Create an account" link on the marketing
 * site while a marketing page is already mounted. The marketing page stays
 * mounted, and the form renders inside a modal over it.
 *
 * Same form content as the full page — same Server Component, same
 * `registerAction`, same validation. The page is the canonical URL
 * (refresh, deep-link, link-share); the intercepting route is the
 * "soft navigation" variant.
 *
 * The modal reads its own searchParams and forwards them — the `?role=`,
 * `?error=`, and field-preserved query parameters (email, name, etc.) all
 * need to flow through so the modal renders the same state as the full
 * page would.
 */
export default async function InterceptedRegisterPage({
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
  }>
}) {
  const params = await searchParams
  return (
    <AuthModal>
      <RegisterForm searchParams={Promise.resolve(params)} />
    </AuthModal>
  )
}
