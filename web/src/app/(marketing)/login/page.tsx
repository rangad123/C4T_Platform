import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getUser } from '@/lib/auth/session'
import { ROLE_HOME } from '@/lib/api/types'
import { safeNextOrHome } from '@/lib/safe-redirect'
import LoginForm from './form'
import { AuthCard, AuthPage } from '@/components/auth/AuthCard'

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
}

/**
 * The full-page sign-in. `/login` used to have a modal variant, reachable
 * only by a client-side navigation from inside the marketing layout — a
 * refresh, a pasted URL, or the redirect after signing out all rendered the
 * full page instead, so the same screen looked different depending on how you
 * arrived at it. See the note on `AuthCard` for why the modal was removed;
 * this is the only form now, for every path in.
 *
 * No `<main>` here: `MarketingShell` (via the route-group layout) already
 * renders `<main id="main">`, and the skip link targets that id. A second one
 * nested inside it made two `main` landmarks and two elements sharing one DOM
 * id — the same mistake `app/not-found.tsx` calls out.
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
    <AuthPage withLogo>
      <AuthCard>
        <LoginForm searchParams={Promise.resolve(params)} />
      </AuthCard>
    </AuthPage>
  )
}
