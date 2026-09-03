import type { Role } from '@/lib/api/types'

/**
 * Turns a notification's stored link into one that exists in this portal.
 *
 * ── Why any translation is needed
 *
 * The API writes portal-agnostic links: `/app/bugs/:id`, `/app/projects/:id`,
 * `/app/messages/:id`. None of those are real routes. Every page lives under
 * a portal segment — `/app/customer/bugs/:id`, `/app/tester/bugs/:id`,
 * `/app/admin/bugs/:id` — so every one of these links would have 404'd.
 *
 * ── Why it is fixed here rather than at the API
 *
 * A notification has exactly one recipient, and the person clicking it is
 * that recipient, so the portal is knowable at render time from the session
 * alone. Doing it here also repairs the rows already in the database, which
 * changing the writers would not: those links were stored months ago and
 * would stay broken.
 *
 * Links that already name a portal are passed through untouched, so the API
 * can keep writing absolute ones where it knows better (a manager
 * assignment, say, which is genuinely admin-side).
 */
export function resolveNotificationHref(link: string | null, role: Role): string | null {
  if (!link) return null
  if (!link.startsWith('/app/')) return link

  const portal =
    role === 'ADMIN' || role === 'SUB_ADMIN'
      ? 'admin'
      : role === 'CUSTOMER'
        ? 'customer'
        : role === 'TESTER'
          ? 'tester'
          : null
  if (!portal) return link

  // Already portal-qualified (or a shared route) — leave it alone.
  if (/^\/app\/(admin|customer|tester|files|onboarding)\b/.test(link)) return link

  const rest = link.slice('/app/'.length)

  /**
   * A conversation, from `/app/messages/:id`.
   *
   * The admin portal gives a thread its own page; the customer and tester
   * portals select one inside their conversation list by query parameter.
   * Sending an admin the query form landed them on the broadcast composer —
   * which declares no `thread` param and simply ignores it — so the
   * notification opened a "send one message to many testers" form instead of
   * the reply that prompted it.
   */
  const message = /^messages\/([^/?#]+)/.exec(rest)
  if (message) {
    return portal === 'admin'
      ? `/app/admin/communication/threads/${message[1]}`
      : `/app/${portal}/communication?thread=${message[1]}`
  }

  /**
   * A platform-wide announcement, from `/app/communication?announcement=:id`.
   *
   * Same split, and the same failure without it: the fallthrough below would
   * hand an admin `/app/admin/communication?announcement=…`, which the
   * composer also ignores.
   */
  const announcement = /^communication\?announcement=([^&#]+)/.exec(rest)
  if (announcement) {
    return portal === 'admin'
      ? `/app/admin/communication/announcements/${announcement[1]}`
      : `/app/${portal}/communication?announcement=${announcement[1]}`
  }

  // Money reads differently per portal: admins run the ledger, testers see
  // their own balance on their profile's payment section.
  if (rest.startsWith('transactions')) {
    return portal === 'admin' ? '/app/admin/transactions' : `/app/${portal}/profile?section=payment`
  }

  // Leads are an admin concept; a non-admin has nowhere to land.
  if (rest.startsWith('leads')) return portal === 'admin' ? `/app/admin/${rest}` : null

  // bugs/:id, projects/:id and anything else that mirrors per portal.
  return `/app/${portal}/${rest}`
}
