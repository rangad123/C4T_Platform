import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getUser } from '@/lib/auth/session'
import { ROLE_HOME } from '@/lib/api/types'
import { safeNextOrHome } from '@/lib/safe-redirect'
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

  /**
   * Send a genuinely signed-in visitor to their home rather than showing them
   * a sign-in form.
   *
   * This used to be the proxy's job, but the proxy can only see that a cookie
   * EXISTS — not that the session behind it is alive. That gap produced an
   * infinite `/login ⇄ /app` redirect loop whenever a cookie outlived its
   * session (see the note in `src/proxy.ts`). `getUser()` asks the API, so a
   * dead cookie returns null here and the form renders, which is exactly what
   * a user holding a stale cookie needs.
   *
   * `getUser` is the non-throwing read — a signed-out visitor is the normal
   * case on this page, not an error.
   *
   * `next` is honoured so a live session following a deep link lands where it
   * was going, not on a generic home. `safeNextOrHome` rejects off-origin and
   * protocol-relative targets, so this cannot become an open redirect.
   */
  const user = await getUser()
  if (user) redirect(safeNextOrHome(params.next, ROLE_HOME[user.role]))

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
