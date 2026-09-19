import { redirect } from 'next/navigation'
import { env } from '@/lib/env'

/**
 * Builds an absolute URL for an HRMS redirect and hands it to `redirect()`.
 *
 * ── WHAT THIS DOES AND DOES NOT SOLVE
 *
 * It does NOT force a full browser navigation. That was the first attempt at
 * fixing HRMS sign-in landing on the marketing site, and it was wrong: Next
 * normalises a same-origin absolute URL straight back into a client-side
 * transition, so the client router still resolved the path against the
 * filesystem and still found the marketing site's own `/login`. Verified
 * against the deployed site, not assumed.
 *
 * The three paths that collide — `/login`, `/forgot-password`,
 * `/reset-password` — are therefore not solved here at all. Their actions
 * return their result to the form instead of redirecting, and the one real
 * navigation left (to sign-in after a password is set, and after sign-out)
 * is a `window.location` call from the client, which is a genuine request and
 * so passes back through `proxy.ts`'s hostname rewrite.
 *
 * ── WHAT IT IS STILL FOR
 *
 * Redirects to HRMS-only addresses — `/admin`, `/employee` — which collide
 * with nothing and resolve correctly whichever way they are made. Two things
 * make routing them through here worthwhile:
 *
 *   • `requireHrEmployee` and `requireHrRole` redirect while a page renders,
 *     so Next answers with a real HTTP redirect and the browser's follow-up
 *     request passes through the rewrite properly.
 *   • Locally there is no hrms hostname and so no rewrite, which is why every
 *     bare-path redirect used to 404 in development. Targeting `/hrms<path>`
 *     there hits the real route directly.
 */
export function hrExternalRedirect(path: string, type: 'push' | 'replace' = 'replace'): never {
  const production = env.NEXT_PUBLIC_ENVIRONMENT === 'production'
  const origin = production ? 'https://hrms.crowd4test.com' : env.NEXT_PUBLIC_SITE_URL
  const prefix = production ? '' : '/hrms'
  redirect(`${origin}${prefix}${path}`, type)
}
