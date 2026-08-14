import { Badge } from '@/components/ds/core/Badge'
import type { BadgeProps } from '@/components/ds/core/Badge'

/**
 * The LeadStatus enum on the API:
 *   NEW, CONTACTED, QUALIFIED, WON, LOST, SPAM
 *
 * The tone choices follow the messaging an admin actually wants at a glance:
 * SPAM is a warning because it IS a warning, not a normal terminal state —
 * the filter that filed it might be wrong. WON is the only positive outcome
 * so far, hence `success`. Everything else is "in flight" or "given up on".
 *
 * The label is sentence-cased — the Badge's mono-uppercase treatment is the
 * one exception to that rule, but LeadStatus is read by humans as a noun not
 * a code, so the words are left alone. Pass `uppercase={false}`.
 */
const STATUS_TONE: Record<LeadStatusValue, BadgeProps['tone']> = {
  NEW: 'info',
  CONTACTED: 'info',
  QUALIFIED: 'accent',
  WON: 'success',
  LOST: 'neutral',
  SPAM: 'warning',
}

const STATUS_LABEL: Record<LeadStatusValue, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  QUALIFIED: 'Qualified',
  WON: 'Won',
  LOST: 'Lost',
  SPAM: 'Spam',
}

export type LeadStatusValue = 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'WON' | 'LOST' | 'SPAM'

export function LeadStatusBadge({ status }: { status: string }) {
  const known = (Object.keys(STATUS_TONE) as LeadStatusValue[]).includes(status as LeadStatusValue)
  const value = known ? (status as LeadStatusValue) : 'NEW'
  return (
    <Badge tone={STATUS_TONE[value]} uppercase={false}>
      {STATUS_LABEL[value]}
    </Badge>
  )
}
