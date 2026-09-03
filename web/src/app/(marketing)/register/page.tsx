import type { Metadata } from 'next'
import RegisterForm from './form'
import { AuthCard, AuthPage } from '@/components/auth/AuthCard'

export const metadata: Metadata = {
  title: 'Create an account',
  robots: { index: false, follow: false },
}

/**
 * The full-page sign-up. Direct visits (refresh, URL paste, link-share)
 * land here. Client-side navigations from the login form's "Create an account"
 * link land on the intercepting route `app/(marketing)/@auth/(.)register/page.tsx`
 * instead, which renders the same form inside a modal over the login page.
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
  }>
}) {
  // Resolve the searchParams here so the page wrapper still has the await
  // path Next expects, and the form below receives the awaited value.
  const params = await searchParams
  return (
    <AuthPage withLogo compact>
      <AuthCard>
        <RegisterForm searchParams={Promise.resolve(params)} />
      </AuthCard>
    </AuthPage>
  )
}
