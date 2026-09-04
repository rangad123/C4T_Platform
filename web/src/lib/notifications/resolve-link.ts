import 'server-only'
import { ROLE_HOME, type Role } from '@/lib/api/types'

/**
 * Where a notification's portal-agnostic link should actually land.
 *
 * ── THE BUG THIS EXISTS TO FIX
 *
 * The API composes notification links without knowing which portal the
 * recipient uses — `createNotifications(userIds, payload)` sends ONE payload
 * to many users who may hold different roles, so it cannot name a portal.
 * It wrote paths like `/app/bugs/:id` and `/app/messages/:id`, and no such
 * routes exist: every bug lives at `/app/{admin,customer,tester}/bugs/:id`.
 *
 * The result was that whole families of notification were dead links —
 * MESSAGE_RECEIVED, the bug notifications, leads, project assignment — and
 * clicking one produced a 404 rather than the record it announced.
 *
 * Rather than teach every producer about portals (it cannot know), the web
 * tier resolves the link at click time, when the session role IS known. The
 * routes under `app/(resolve)/` are thin redirects that call this.
 */

/**
 * A record kind reachable from a notification, and where each role reads it.
 *
 * `USER` is deliberately absent throughout: it is the pre-onboarding role,
 * which has no portal to send anyone into. Those fall through to
 * `ROLE_HOME`, which routes them to onboarding.
 */
const DESTINATIONS: Record<string, Partial<Record<Role, (id: string) => string>>> = {
  bugs: {
    ADMIN: (id: string) => `/app/admin/bugs/${id}`,
    SUB_ADMIN: (id: string) => `/app/admin/bugs/${id}`,
    CUSTOMER: (id: string) => `/app/customer/bugs/${id}`,
    TESTER: (id: string) => `/app/tester/bugs/${id}`,
  },
  projects: {
    ADMIN: (id: string) => `/app/admin/projects/${id}`,
    SUB_ADMIN: (id: string) => `/app/admin/projects/${id}`,
    CUSTOMER: (id: string) => `/app/customer/projects/${id}`,
    TESTER: (id: string) => `/app/tester/projects/${id}`,
  },
  /**
   * Only the admin portal has a thread detail route. A customer or tester
   * reads the same conversation from their own communication list, which is
   * a single page rather than one route per thread — so they land there with
   * the thread named in the query, and the page opens it.
   */
  messages: {
    ADMIN: (id: string) => `/app/admin/communication/threads/${id}`,
    SUB_ADMIN: (id: string) => `/app/admin/communication/threads/${id}`,
    CUSTOMER: (id: string) => `/app/customer/communication?thread=${id}`,
    TESTER: (id: string) => `/app/tester/communication?thread=${id}`,
  },
  /** Leads are an admin-side concept; nobody else has a page for one. */
  leads: {
    ADMIN: (id: string) => `/app/admin/leads/${id}`,
    SUB_ADMIN: (id: string) => `/app/admin/leads/${id}`,
    CUSTOMER: () => '/app/customer',
    TESTER: () => '/app/tester',
  },
} as const

export type ResolvableKind = 'bugs' | 'projects' | 'messages' | 'leads'

/**
 * The path this role should be sent to, or their portal home when the record
 * has no page for them.
 *
 * Never throws and never 404s: a notification that cannot be resolved still
 * lands somewhere sensible, because bouncing someone to an error page for
 * following their own notification is worse than bouncing them home.
 */
export function resolveNotificationLink(kind: ResolvableKind, id: string, role: Role): string {
  const destination = DESTINATIONS[kind]?.[role]
  return destination ? destination(id) : ROLE_HOME[role]
}
