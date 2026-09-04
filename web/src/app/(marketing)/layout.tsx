import { MarketingShell } from '@/components/sections/MarketingShell'

/**
 * The marketing shell for every public page.
 *
 * The shell itself is `components/sections/MarketingShell` so that
 * `app/not-found.tsx` — which sits outside this route group and cannot inherit a
 * group layout — renders with the same navigation. See the note there.
 *
 * The active-section underline is still unwired: it needs the current pathname,
 * which belongs in TopNav via `usePathname` rather than here, since this is a
 * Server Component.
 *
 * ── THE `@auth` SLOT
 *
 * Sign in and register are intercepted here, so clicking either in the nav
 * opens a dialog over the page being read rather than navigating away from it.
 * `@auth/(.)login` and `@auth/(.)register` render the same forms the
 * standalone routes do — imported, not copied.
 *
 * This was tried once before and removed, because interception only happens on
 * a client-side navigation: a refresh, a pasted or emailed link, an invitation
 * link, a protected page bouncing to `/login`, and the redirect after signing
 * out all arrive as hard loads with no page underneath, so they render the
 * full page instead. The two looked like different products.
 *
 * That is now addressed rather than avoided. `@auth/default.tsx` renders
 * nothing for those loads, and the standalone pages sit on the same dark band
 * as the dialog's backdrop — so the fallback reads as the same screen arrived
 * at differently, not as a blank white page.
 */
export default function MarketingLayout({
  children,
  auth,
}: {
  children: React.ReactNode
  /** The intercepted sign-in / register dialog, or nothing. */
  auth: React.ReactNode
}) {
  return (
    <MarketingShell>
      {children}
      {auth}
    </MarketingShell>
  )
}
