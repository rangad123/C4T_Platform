'use client'

import { useTransition } from 'react'
import { Icon } from '@/components/ds/core/Icon'
import { hrLogoutAction } from '@/lib/hrms/hr-actions'
import { hrBrowserNavigate } from '@/lib/hrms/hr-browser-navigate'

/**
 * Sign out, then send the browser to the sign-in page itself.
 *
 * The navigation is `window.location`, not a redirect from the action and not
 * the router, and that is the whole point. `/login` also exists as a real
 * page at the marketing site's top level, and Next's client router — which
 * knows nothing about the hostname rewrite that puts HRMS at
 * `hrms.crowd4test.com` — resolves it to that one. Signing out therefore
 * dropped people on the marketing homepage. A real browser navigation goes
 * back through the server, where the rewrite has never been wrong.
 *
 * It also guarantees a fresh document after the session cookies are cleared,
 * with no signed-in router state left in memory.
 */
export function HrSignOutButton({ className }: { className?: string }) {
  const [pending, startTransition] = useTransition()

  return (
    <button
      type="button"
      className={className}
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          await hrLogoutAction()
          hrBrowserNavigate('/login')
        })
      }}
    >
      <Icon name="log-out" size={16} />
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  )
}
