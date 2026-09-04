import type { Metadata } from 'next'
import RegisterForm from './form'
import { AuthCard, AuthPage } from '@/components/auth/AuthCard'

export const metadata: Metadata = {
  title: 'Create an account',
  robots: { index: false, follow: false },
}

/**
 * The full-page sign-up. `/register` used to have a modal variant, reachable
 * only by a client-side navigation from inside the marketing layout — see the
 * note on `AuthCard` for why that was removed. This is the only form now, for
 * every path in: a refresh, a pasted URL, a link share, or the "Create an
 * account" link from `/login`.
 *
 * No `<main>` here: `MarketingShell` (via the route-group layout) already
 * renders `<main id="main">`, and the skip link targets that id. A second one
 * nested inside it made two `main` landmarks and two elements sharing one DOM
 * id — the same mistake `app/not-found.tsx` calls out.
 */
export default async function RegisterPage({
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
    /** Where to land after a successful sign-up — e.g. an invitation link. */
    next?: string
  }>
}) {
  // Resolve the searchParams here so the page wrapper still has the await
  // path Next expects, and the form below receives the awaited value.
  const params = await searchParams
  return (
    <AuthPage wide>
      <AuthCard wide>
        <RegisterForm searchParams={Promise.resolve(params)} />
      </AuthCard>
    </AuthPage>
  )
}
