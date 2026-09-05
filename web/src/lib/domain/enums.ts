import { titleCase } from '@/lib/admin/format'

/**
 * The API's enums, once.
 *
 * ── WHY THIS FILE EXISTS
 *
 * These vocabularies were copied into the pages and actions that used them:
 * `SEVERITIES` was declared in NINE files, `PAYMENT_METHODS` in six under
 * three different names, `DEVICE_TYPES` in five. Each copy was a place for
 * the list to drift from `schema.prisma` — a value added to the API is a
 * value some of those files silently do not offer, and a value removed is one
 * some of them still send.
 *
 * The order here is the ORDER IN THE PRISMA ENUM, not alphabetical. That
 * order is meaningful and was already relied on: severity reads
 * critical → low, a bug's lifecycle reads new → resolved, and a picker that
 * sorted them alphabetically would put "CRITICAL" between "APP_FREEZE" and
 * "FUNCTIONAL" and read as noise.
 *
 * ── WHAT DOES NOT BELONG HERE
 *
 * A deliberate SUBSET. Several files narrow one of these lists on purpose —
 * the statuses a bug may transition INTO are not the statuses it may be
 * filtered BY, and a customer may set fewer than an admin. Those stay where
 * they are, defined in terms of the rule they encode rather than pulled in
 * here and re-filtered, because the subset is the point.
 *
 * ── AND WHAT THIS IS NOT
 *
 * Not a replacement for the API's validation. Every one of these is checked
 * again server-side; this list decides what a picker OFFERS, never what is
 * accepted.
 */

export interface EnumOption {
  value: string
  label: string
}

/** `IN_PROGRESS` → `In progress`, the label every one of these pickers used. */
function options(values: readonly string[]): readonly EnumOption[] {
  return values.map((value) => ({ value, label: titleCase(value) }))
}

// ─── Bugs ────────────────────────────────────────────────────────────────────

export const BUG_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const
export const BUG_STATUSES = [
  'NEW',
  'TRIAGED',
  'CONFIRMED',
  'IN_PROGRESS',
  'FIXED',
  'VERIFIED',
  'REOPENED',
  'REJECTED',
  'DUPLICATE',
  'WONT_FIX',
  'FEATURE_REQUEST',
] as const
export const BUG_TYPES = [
  'CRASH',
  'APP_FREEZE',
  'FUNCTIONAL',
  'UI',
  'UX',
  'SECURITY',
  'PERFORMANCE',
] as const
export const BUG_REPRODUCIBILITIES = ['ALWAYS', 'SOMETIMES', 'ONCE', 'UNABLE_TO_REPRODUCE'] as const

export const BUG_SEVERITY_OPTIONS = options(BUG_SEVERITIES)
export const BUG_STATUS_OPTIONS = options(BUG_STATUSES)
export const BUG_TYPE_OPTIONS = options(BUG_TYPES)
export const BUG_REPRODUCIBILITY_OPTIONS = options(BUG_REPRODUCIBILITIES)

// ─── People and accounts ─────────────────────────────────────────────────────

export const ROLES = ['USER', 'CUSTOMER', 'TESTER', 'ADMIN', 'SUB_ADMIN'] as const
export const USER_STATUSES = ['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const
export const TESTER_STATUSES = [
  'APPLIED',
  'UNDER_REVIEW',
  'VERIFIED',
  'REJECTED',
  'SUSPENDED',
] as const
export const ORGANISATION_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const
export const ORG_MEMBER_ROLES = ['OWNER', 'MEMBER'] as const

export const ROLE_OPTIONS = options(ROLES)
export const USER_STATUS_OPTIONS = options(USER_STATUSES)
export const TESTER_STATUS_OPTIONS = options(TESTER_STATUSES)
export const ORGANISATION_STATUS_OPTIONS = options(ORGANISATION_STATUSES)
export const ORG_MEMBER_ROLE_OPTIONS = options(ORG_MEMBER_ROLES)

// ─── Work ────────────────────────────────────────────────────────────────────

export const PROJECT_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'IN_PROGRESS',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
] as const
export const PROJECT_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
export const ASSIGNMENT_STATUSES = [
  'INVITED',
  'ACCEPTED',
  'DECLINED',
  'ACTIVE',
  'COMPLETED',
  'REMOVED',
] as const
export const BUILD_STATUSES = ['NEW', 'ASSIGNED', 'TESTED', 'REVIEWED', 'CLOSED'] as const
export const DEVICE_TYPES = [
  'MOBILE',
  'TABLET',
  'DESKTOP',
  'SMART_TV',
  'WEARABLE',
  'OTHER',
] as const

export const PROJECT_STATUS_OPTIONS = options(PROJECT_STATUSES)
export const PROJECT_PRIORITY_OPTIONS = options(PROJECT_PRIORITIES)
export const ASSIGNMENT_STATUS_OPTIONS = options(ASSIGNMENT_STATUSES)
export const BUILD_STATUS_OPTIONS = options(BUILD_STATUSES)
export const DEVICE_TYPE_OPTIONS = options(DEVICE_TYPES)

// ─── Money ───────────────────────────────────────────────────────────────────

export const TRANSACTION_TYPES = [
  'CUSTOMER_INVOICE',
  'CUSTOMER_PAYMENT',
  'TESTER_EARNING',
  'TESTER_PAYOUT',
  'ADJUSTMENT',
  'REFUND',
] as const
export const TRANSACTION_STATUSES = [
  'PENDING',
  'APPROVED',
  'RELEASED',
  'PAID',
  'FAILED',
  'CANCELLED',
] as const
export const PAYMENT_METHODS = [
  'IND_BANK_ACCOUNT',
  'NON_IND_BANK_ACCOUNT',
  'PAYPAL',
  'PAYTM',
] as const
export const PAYMENT_ACCOUNT_COUNTRIES = ['INDIAN', 'NON_INDIAN'] as const

export const TRANSACTION_TYPE_OPTIONS = options(TRANSACTION_TYPES)
export const TRANSACTION_STATUS_OPTIONS = options(TRANSACTION_STATUSES)
/**
 * Hand-written labels, not `titleCase`.
 *
 * The generated version reads "Ind bank account", "Non ind bank account" and
 * "Paypal" — an abbreviation nobody says aloud and a brand spelled wrong.
 * Three files had already written these labels out by hand; this is where
 * they live now, so the fourth caller does not have to guess.
 */
export const PAYMENT_METHOD_LABELS: Record<(typeof PAYMENT_METHODS)[number], string> = {
  IND_BANK_ACCOUNT: 'Indian bank account',
  NON_IND_BANK_ACCOUNT: 'International bank account',
  PAYPAL: 'PayPal',
  PAYTM: 'Paytm',
}

export const PAYMENT_METHOD_OPTIONS: readonly EnumOption[] = PAYMENT_METHODS.map((value) => ({
  value,
  label: PAYMENT_METHOD_LABELS[value],
}))
export const PAYMENT_ACCOUNT_COUNTRY_OPTIONS = options(PAYMENT_ACCOUNT_COUNTRIES)

// ─── Elsewhere ───────────────────────────────────────────────────────────────

export const LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'WON', 'LOST', 'SPAM'] as const
export const ANNOUNCEMENT_AUDIENCES = ['ALL', 'CUSTOMERS', 'TESTERS', 'ADMINS'] as const
export const LANGUAGE_PROFICIENCIES = ['BASIC', 'PROFESSIONAL', 'FLUENT', 'NATIVE'] as const

export const LEAD_STATUS_OPTIONS = options(LEAD_STATUSES)
export const ANNOUNCEMENT_AUDIENCE_OPTIONS = options(ANNOUNCEMENT_AUDIENCES)
export const LANGUAGE_PROFICIENCY_OPTIONS = options(LANGUAGE_PROFICIENCIES)

/**
 * Membership test for a value that arrived as a plain string.
 *
 * The lists above are `as const`, so their element type is the union of their
 * members — which is what makes them useful as types, and what stops
 * `list.includes(someString)` from compiling. A form field is a `string` until
 * something checks it, and this is that check.
 */
export function isOneOf(values: readonly string[], value: string): boolean {
  return values.includes(value)
}
