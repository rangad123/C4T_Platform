import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { requireUser } from '@/lib/auth/session'

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

/**
 * Authenticated shell for both personas.
 *
 * `requireUser()` here is THE authorization boundary for everything under
 * /app — it asks the API whether the session is live, which is the only thing
 * that can answer for stateful auth. `proxy.ts` merely spares signed-out
 * visitors the round trip; it proves nothing.
 *
 * A layout does not re-run on client-side navigation within its segment, so
 * every Server Action and Route Handler under /app must call `requireUser()`
 * itself rather than assuming this layout vouched for the caller.
 *
 * ── `returnTo` is the real page, not a hardcoded `/app`
 *
 * This layout wraps every route under /app, admin included, so it is the
 * one place a session that died mid-visit gets caught — an admin three
 * levels into a project page is just as likely to land here as a customer
 * on their own home. `x-full-path` (set by `proxy.ts` from the actual
 * request URL) is what `loginAction` redirects back to after a fresh
 * sign-in, so the visitor returns to where they were instead of the bare
 * `/app` placeholder. Falling back to `/app` only happens if the header is
 * ever missing (`proxy.ts`'s matcher excludes a request from Proxy
 * entirely).
 *
 * ── Why there is no <main> here
 *
 * This layout used to wrap `children` in `<main id="main">`. The admin area
 * (`/app/admin`) has a sidebar, and a sidebar's <nav> must NOT sit inside
 * <main> — main is for content unique to the page, navigation is not. Nesting
 * the area layout inside a main here also produced two <main> elements with
 * the same id once the admin shell added its own.
 *
 * So the landmark belongs to whichever layout actually knows the page
 * structure. Each area renders exactly one `<main id="main">`:
 * `app/admin/layout.tsx` does, and `app/page.tsx` does for the customer view.
 * Anything added under /app must do the same — the skip link in the marketing
 * shell targets `#main`, and a page without it breaks that jump.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const headerList = await headers()
  const returnTo = headerList.get('x-full-path') ?? '/app'
  const user = await requireUser(returnTo)

  return (
    <div style={{ minHeight: '100dvh' }}>
      {children}
      <span className="c4t-visually-hidden">Signed in as {user.email}</span>
    </div>
  )
}
