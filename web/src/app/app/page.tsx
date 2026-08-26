import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth/session'
import { ROLE_HOME } from '@/lib/api/types'

/**
 * `/app` — a bare landing stop, not a portal. Every role now has a real named
 * home (`ROLE_HOME`), so this page's only job is to forward the caller there.
 *
 * It still has to exist: `proxy.ts` hardcodes `/app` as the bounce target for
 * a signed-in visitor on a guest-only page, and `app/layout.tsx`'s `returnTo`
 * fallback defaults to `/app` when `x-full-path` is missing. Both need
 * somewhere that resolves onward correctly rather than a 404.
 */
export default async function AppIndexPage() {
  const user = await requireUser('/app')
  redirect(ROLE_HOME[user.role])
}
