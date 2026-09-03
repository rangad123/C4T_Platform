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
 * Sign-in and register used to be intercepted here by an `@auth` slot, so
 * clicking "Sign in" in the nav opened a modal over the page while every
 * other route to the same screen rendered it in full. That could not be made
 * consistent: a modal needs a page underneath it, and there is none on a
 * refresh, a deep link, an invitation link, a protected route bouncing to
 * `/login`, or the redirect after signing out. The full page is the only form
 * that works from every entry, so it is now the only form.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return <MarketingShell>{children}</MarketingShell>
}
