import { env } from '@/lib/env'

/**
 * Sends the browser to an HRMS path with a real navigation.
 *
 * Used for the two places HRMS genuinely has to leave the page for one of the
 * paths it shares a name with the marketing site — signing out, and finishing
 * a password reset, both of which land on `/login`.
 *
 * It must be `window.location`, not the router. `/login` exists a second time
 * at the marketing site's top level, and Next's client router resolves it to
 * that one, knowing nothing about the hostname rewrite that serves HRMS. Only
 * a real request goes back through the server, where the rewrite is applied.
 *
 * In development there is no hrms hostname and so no rewrite, which is why a
 * bare `/login` lands on the marketing page locally. Targeting `/hrms<path>`
 * there hits the real route directly.
 */
export function hrBrowserNavigate(path: string): void {
  const prefix = env.NEXT_PUBLIC_ENVIRONMENT === 'production' ? '' : '/hrms'
  window.location.assign(`${prefix}${path}`)
}
