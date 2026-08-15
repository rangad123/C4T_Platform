import type { Metadata } from 'next'
import RegisterForm from './form'

export const metadata: Metadata = {
  title: 'Create an account',
  robots: { index: false, follow: false },
}

/**
 * The full-page sign-up. Direct visits (refresh, URL paste, link-share)
 * land here. Client-side navigations from the login form's "Create an account"
 * link land on the intercepting route `app/(marketing)/@auth/(.)register/page.tsx`
 * instead, which renders the same form inside a modal over the login page.
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
    <main
      id="main"
      style={{
        padding: 'var(--space-11) var(--space-7)',
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          padding: 'var(--space-9)',
          background: 'var(--surface-canvas)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-card)',
          boxShadow: 'var(--shadow-md)',
          width: '100%',
          maxWidth: 'var(--container-form)',
        }}
      >
        <RegisterForm searchParams={Promise.resolve(params)} />
      </div>
    </main>
  )
}
