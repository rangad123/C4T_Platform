import { Badge } from '@/components/ds/core/Badge'
import { titleCase } from '@/lib/admin/format'

export type Tone = NonNullable<React.ComponentProps<typeof Badge>['tone']>

/**
 * One badge for every status enum on the platform.
 *
 * There are nine status enums across the admin sections (user, organisation,
 * tester, project, bug, transaction, assignment, lead, payout) and they share
 * most of their vocabulary — ACTIVE, PENDING, REJECTED. Giving each one its own
 * badge component meant nine lookup tables that drifted apart; the tone for
 * REJECTED should not depend on which list you are looking at.
 *
 * So this is a single map keyed by the status string. Unknown values fall
 * through to `neutral` rather than throwing, because the API is free to add an
 * enum member before the web app knows about it — a new status should render as
 * a plain grey pill, not crash the list.
 */
const TONES: Record<string, Tone> = {
  // Terminal-good
  ACTIVE: 'success',
  VERIFIED: 'success',
  APPROVED: 'success',
  PAID: 'success',
  COMPLETED: 'success',
  FIXED: 'success',
  CLOSED: 'success',
  WON: 'success',
  ACCEPTED: 'success',

  // In flight
  NEW: 'info',
  APPLIED: 'info',
  PENDING: 'warning',
  PENDING_VERIFICATION: 'warning',
  IN_REVIEW: 'warning',
  UNDER_REVIEW: 'warning',
  PAUSED: 'warning',
  REOPENED: 'warning',
  IN_PROGRESS: 'info',
  TRIAGED: 'info',
  CONFIRMED: 'info',
  SUBMITTED: 'info',
  CONTACTED: 'info',
  QUALIFIED: 'info',
  INVITED: 'info',
  DRAFT: 'neutral',
  SCHEDULED: 'info',

  // Terminal-bad
  REJECTED: 'error',
  FAILED: 'error',
  CANCELLED: 'error',
  SUSPENDED: 'error',
  BLOCKED: 'error',
  LOST: 'error',
  SPAM: 'error',
  DUPLICATE: 'neutral',
  WONT_FIX: 'neutral',
  ARCHIVED: 'neutral',
  INACTIVE: 'neutral',
  EXPIRED: 'neutral',
  DEACTIVATED: 'neutral',
}

/** The tone a status maps to, for anything that needs the color without the pill (e.g. a chart segment). */
export function statusTone(status: string): Tone {
  return TONES[status] ?? 'neutral'
}

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span style={{ color: 'var(--text-muted)' }}>—</span>
  return (
    <Badge tone={TONES[status] ?? 'neutral'} uppercase={false}>
      {titleCase(status)}
    </Badge>
  )
}

/**
 * Bug severity, which is an ordered scale rather than a lifecycle — so it gets
 * its own map. CRITICAL and HIGH are both "act now" but they are not the same
 * badge, and folding them into the status map above would have put an ordering
 * concern inside a lifecycle lookup.
 */
const SEVERITY_TONES: Record<string, Tone> = {
  CRITICAL: 'error',
  HIGH: 'warning',
  MEDIUM: 'info',
  LOW: 'neutral',
}

/** Same as `statusTone`, for bug severity's separate ordered-scale map. */
export function severityTone(severity: string): Tone {
  return SEVERITY_TONES[severity] ?? 'neutral'
}

export function SeverityBadge({ severity }: { severity: string | null | undefined }) {
  if (!severity) return <span style={{ color: 'var(--text-muted)' }}>—</span>
  return (
    <Badge tone={SEVERITY_TONES[severity] ?? 'neutral'} uppercase={false}>
      {titleCase(severity)}
    </Badge>
  )
}

/**
 * Bug type is a plain classification, not a status or an ordered scale — so
 * unlike the two maps above, there is no "good/bad" meaning to lean on. Each
 * type still gets its own fixed, distinct tone (never cycled or assigned by
 * whichever types happen to be present) so a "Bugs by type" chart can use
 * color for identity the same way severity and status charts do.
 */
const BUG_TYPE_TONES: Record<string, Tone> = {
  CRASH: 'error',
  APP_FREEZE: 'warning',
  FUNCTIONAL: 'info',
  UI: 'accent',
  UX: 'brand',
  SECURITY: 'success',
  PERFORMANCE: 'neutral',
}

/** Same as `statusTone`, for bug type's separate classification map. */
export function bugTypeTone(type: string): Tone {
  return BUG_TYPE_TONES[type] ?? 'neutral'
}

/** Roles are not statuses either, but they want the same pill treatment. */
const ROLE_TONES: Record<string, Tone> = {
  ADMIN: 'brand',
  SUB_ADMIN: 'accent',
  CUSTOMER: 'info',
  TESTER: 'neutral',
  USER: 'neutral',
}

export function RoleBadge({ role }: { role: string | null | undefined }) {
  if (!role) return <span style={{ color: 'var(--text-muted)' }}>—</span>
  return (
    <Badge tone={ROLE_TONES[role] ?? 'neutral'} uppercase={false}>
      {titleCase(role)}
    </Badge>
  )
}
