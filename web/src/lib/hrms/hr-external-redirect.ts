import { redirect } from 'next/navigation'
import { env } from '@/lib/env'

/**
 * A redirect to one of the three bare paths HRMS shares a name with on the
 * main marketing site: `/login`, `/forgot-password`, `/reset-password`.
 *
 * ── WHY THIS EXISTS
 *
 * `hrmsRewrite` in `proxy.ts` is server-side middleware: on a fresh request
 * it correctly rewrites `hrms.crowd4test.com/login` to the `app/hrms/login`
 * page, invisibly. A plain `redirect('/login?error=...')` from a Server
 * Action does not go through that the same way. Next's client router
 * performs the follow-up navigation itself, and the router has no idea a
 * host-based rewrite exists — it resolves `/login` against its own
 * filesystem route table, where a literal `/login` page ALSO exists, at the
 * marketing site's top level. That page wins. The address bar still reads
 * `hrms.crowd4test.com/login`, but the marketing homepage renders behind its
 * own login modal — the exact "HRMS sign-in redirects to the main site"
 * report this project already fixed once for the bare hostname's root path.
 * This is the same failure, one level deeper: it needed a real page at every
 * shared name, not just at `/`.
 *
 * The fix is to never let the CLIENT resolve these three redirects at all.
 * `redirect()` given an absolute URL makes Next.js perform a real browser
 * navigation (`window.location`) instead of a soft client-side transition,
 * which sends the browser back through the server — and the server's rewrite
 * has never been wrong. Every redirect to these three paths from HRMS code
 * must go through this helper, not a bare `redirect('/login...')`.
 *
 * ── DEV
 *
 * There is no real separate hrms.crowd4test.com in development, so the
 * cleanest correct target is `/hrms<path>` on the same origin — the literal
 * file route, sidestepping the need for host detection entirely. This also
 * fixes the address bar showing the platform's login page in dev, which was
 * a known, previously-accepted limitation.
 */
export function hrExternalRedirect(path: string, type: 'push' | 'replace' = 'replace'): never {
  const production = env.NEXT_PUBLIC_ENVIRONMENT === 'production'
  const origin = production ? 'https://hrms.crowd4test.com' : env.NEXT_PUBLIC_SITE_URL
  const prefix = production ? '' : '/hrms'
  redirect(`${origin}${prefix}${path}`, type)
}
