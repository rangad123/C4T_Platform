import { Badge } from '@/components/ds/core/Badge'
import { titleCase } from '@/lib/admin/format'

type Tone = NonNullable<React.ComponentProps<typeof Badge>['tone']>

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

export function SeverityBadge({ severity }: { severity: string | null | undefined }) {
  if (!severity) return <span style={{ color: 'var(--text-muted)' }}>—</span>
  return (
    <Badge tone={SEVERITY_TONES[severity] ?? 'neutral'} uppercase={false}>
      {titleCase(severity)}
    </Badge>
  )
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
