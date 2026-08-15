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
 * The `@auth` slot is the intercepting-routes target. When a user clicks
 * "Sign in" in the top nav while on a marketing page, Next.js renders the
 * `app/(marketing)/@auth/(.)login/page.tsx` instead of the full
 * `/login/page.tsx`. The marketing page underneath stays mounted, so the
 * modal opens over it instead of replacing it. Direct visits to `/login`
 * (refresh, URL paste) still hit the full page.
 */
export default function MarketingLayout({
  children,
  auth,
}: {
  children: React.ReactNode
  auth: React.ReactNode
}) {
  return (
    <MarketingShell>
      {children}
      {auth}
    </MarketingShell>
  )
}
