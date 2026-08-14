import { requireUser } from '@/lib/auth/session'
import { PortalNotReady } from '@/components/portal/PortalNotReady'

/**
 * `/app` — the authenticated landing for every non-admin role.
 *
 * Admin users never reach this page. `app/admin/layout.tsx` runs the
 * `requireRole(['ADMIN', 'SUB_ADMIN'])` check before this page renders, so by
 * the time we get here we know the user is a CUSTOMER, TESTER, or plain USER.
 *
 * The OLD version of this page rendered a customer dashboard scaffold. With
 * the admin portal the only one being shipped, a half-built scaffold is the
 * wrong sign — it suggests the platform is in a working state that it isn't.
 * The placeholder says the opposite, plainly, and offers two clear actions:
 * back to the site, or sign out.
 */
export default async function AppIndexPage() {
  await requireUser('/app')
  return <PortalNotReady />
}
