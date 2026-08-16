import type { Metadata } from 'next'
import LoginForm from './form'

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
}

/**
 * The full-page sign-in. Direct visits (refresh, URL paste, link-share)
 * land here. Client-side navigations from the top nav land on the
 * intercepting route `app/(marketing)/@auth/(.)login/page.tsx` instead,
 * which renders the same form inside a modal over the current page.
 *
 * The page is "full" in the sense that it sits within the marketing layout
 * (top nav + footer); the modal is "full" in the sense that it covers the
 * entire viewport. Both share the same form content.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; email?: string; notice?: string }>
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
        <LoginForm searchParams={Promise.resolve(params)} />
      </div>
    </main>
  )
}
