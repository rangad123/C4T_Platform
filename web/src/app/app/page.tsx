import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth/session'
import { ROLE_HOME } from '@/lib/api/types'
import { PortalNotReady } from '@/components/portal/PortalNotReady'

/**
 * `/app` — the authenticated landing for CUSTOMER and USER, the two roles
 * whose own `ROLE_HOME` points right back here.
 *
 * Every OTHER role must be forwarded to its real home rather than shown this
 * placeholder. In principle admin/tester traffic should never reach this
 * page — `app/layout.tsx`'s own `requireUser()` redirect is the one place
 * that can land here for the wrong reason, since a hardcoded `next=/app`
 * beats `ROLE_HOME` in `loginAction`'s `safeNext(next) ?? home`. Rather than
 * rely on that never happening, this page checks the role itself: an admin
 * or tester who ends up on `/app` — a stale bookmark, a re-login after a
 * session timeout, anything — is bounced onward instead of being told their
 * whole portal doesn't exist yet.
 *
 * The OLD version of this page rendered a customer dashboard scaffold. With
 * the admin portal the only one being shipped, a half-built scaffold is the
 * wrong sign — it suggests the platform is in a working state that it isn't.
 * The placeholder says the opposite, plainly, and offers two clear actions:
 * back to the site, or sign out.
 */
export default async function AppIndexPage() {
  const user = await requireUser('/app')
  const home = ROLE_HOME[user.role]
  if (home !== '/app') redirect(home)
  return <PortalNotReady />
}
