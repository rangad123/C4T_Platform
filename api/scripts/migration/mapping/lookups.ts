import {
  AnnouncementAudience,
  AssignmentStatus,
  BugFieldType,
  BugSeverity,
  BugStatus,
  BugType,
  BugReproducibility,
  DeviceType,
  OrgMemberRole,
  PaymentAccountCountry,
  PaymentMethod,
  ProjectStatus,
  Role,
  TestCaseResult,
  TransactionStatus,
  TransactionType,
  UserStatus,
} from '@prisma/client'

/**
 * Legacy value → new enum member.
 *
 * ── KEYED LOWERCASE, UNDERSCORED
 *
 * `transform/values.ts:enumValue` lowercases its input and turns spaces and
 * hyphens into underscores before looking it up here, so every key below is in
 * that normalised form. This is what lets "In Progress", "in-progress" and
 * "IN_PROGRESS" — all three of which appear in dumps of this age — land on the
 * same member without three separate entries.
 *
 * ── UNMAPPED VALUES ARE REPORTED, NOT GUESSED
 *
 * A miss returns the caller's fallback AND a problem record. That is the
 * difference between "we defaulted this and told you" and the silent
 * mis-categorisation the brief forbids. Anything genuinely ambiguous is left
 * out of these tables deliberately so it surfaces in the report.
 */

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * `roles.csv` from the legacy export. Ids are stable in the dump, and role is
 * too load-bearing to resolve by name — a renamed legacy role must not silently
 * become USER.
 */
export const ROLE_BY_LEGACY_ID: Record<string, Role> = {
  '1': Role.ADMIN,
  '2': Role.CUSTOMER,
  '3': Role.TESTER,
  '4': Role.SUB_ADMIN,
  '5': Role.USER,
}

export const ROLE_BY_NAME: Record<string, Role> = {
  admin: Role.ADMIN,
  administrator: Role.ADMIN,
  super_admin: Role.ADMIN,
  sub_admin: Role.SUB_ADMIN,
  subadmin: Role.SUB_ADMIN,
  manager: Role.SUB_ADMIN,
  test_manager: Role.SUB_ADMIN,
  customer: Role.CUSTOMER,
  client: Role.CUSTOMER,
  company: Role.CUSTOMER,
  tester: Role.TESTER,
  crowdtester: Role.TESTER,
  user: Role.USER,
}

/** `usr_active` / `activity_status`, both enum('active','inactive'). */
export const USER_STATUS: Record<string, UserStatus> = {
  active: UserStatus.ACTIVE,
  inactive: UserStatus.DEACTIVATED,
  suspended: UserStatus.SUSPENDED,
  pending: UserStatus.PENDING_VERIFICATION,
}

/**
 * `uom_role_id` → OrgMemberRole.
 *
 * The new model has exactly two org roles. Every legacy role that is not the
 * organisation's creator collapses to MEMBER; ownership is assigned from
 * `organisation.org_created_by` rather than inferred here, because the legacy
 * map has no "owner" concept and guessing one would hand somebody billing
 * rights they never had.
 */
export const ORG_MEMBER_ROLE_BY_LEGACY_ID: Record<string, OrgMemberRole> = {
  '2': OrgMemberRole.OWNER,
}

// ── Projects and builds ──────────────────────────────────────────────────────

/**
 * The legacy `projects` table has NO status column — this is derived from
 * dates and build state in the project loader. Kept here so the derivation
 * rule is written down next to the enum it produces.
 */
export const PROJECT_STATUS_FALLBACK = ProjectStatus.COMPLETED

export const ASSIGNMENT_STATUS: Record<string, AssignmentStatus> = {
  invited: AssignmentStatus.INVITED,
  pending: AssignmentStatus.INVITED,
  accepted: AssignmentStatus.ACCEPTED,
  declined: AssignmentStatus.DECLINED,
  rejected: AssignmentStatus.DECLINED,
  active: AssignmentStatus.ACTIVE,
  in_progress: AssignmentStatus.ACTIVE,
  started: AssignmentStatus.ACTIVE,
  completed: AssignmentStatus.COMPLETED,
  complete: AssignmentStatus.COMPLETED,
  finished: AssignmentStatus.COMPLETED,
  closed: AssignmentStatus.COMPLETED,
  removed: AssignmentStatus.REMOVED,
  deleted: AssignmentStatus.REMOVED,
}

export const TEST_CASE_RESULT: Record<string, TestCaseResult> = {
  pass: TestCaseResult.PASS,
  passed: TestCaseResult.PASS,
  success: TestCaseResult.PASS,
  fail: TestCaseResult.FAIL,
  failed: TestCaseResult.FAIL,
  blocked: TestCaseResult.BLOCKED,
  // The new enum has no SKIPPED: an unexecuted case is NOT_TESTED, which is
  // also the right home for legacy "not run" rows.
  skipped: TestCaseResult.NOT_TESTED,
  not_run: TestCaseResult.NOT_TESTED,
  not_tested: TestCaseResult.NOT_TESTED,
  pending: TestCaseResult.NOT_TESTED,
}

// ── Bugs ─────────────────────────────────────────────────────────────────────

export const BUG_SEVERITY: Record<string, BugSeverity> = {
  critical: BugSeverity.CRITICAL,
  blocker: BugSeverity.CRITICAL,
  showstopper: BugSeverity.CRITICAL,
  high: BugSeverity.HIGH,
  major: BugSeverity.HIGH,
  medium: BugSeverity.MEDIUM,
  normal: BugSeverity.MEDIUM,
  moderate: BugSeverity.MEDIUM,
  low: BugSeverity.LOW,
  minor: BugSeverity.LOW,
  trivial: BugSeverity.LOW,
  cosmetic: BugSeverity.LOW,
}

export const BUG_STATUS: Record<string, BugStatus> = {
  new: BugStatus.NEW,
  open: BugStatus.NEW,
  submitted: BugStatus.NEW,
  triaged: BugStatus.TRIAGED,
  under_review: BugStatus.TRIAGED,
  reviewing: BugStatus.TRIAGED,
  confirmed: BugStatus.CONFIRMED,
  accepted: BugStatus.CONFIRMED,
  approved: BugStatus.CONFIRMED,
  valid: BugStatus.CONFIRMED,
  in_progress: BugStatus.IN_PROGRESS,
  assigned: BugStatus.IN_PROGRESS,
  fixed: BugStatus.FIXED,
  resolved: BugStatus.FIXED,
  verified: BugStatus.VERIFIED,
  closed: BugStatus.VERIFIED,
  reopened: BugStatus.REOPENED,
  reopen: BugStatus.REOPENED,
  rejected: BugStatus.REJECTED,
  invalid: BugStatus.REJECTED,
  declined: BugStatus.REJECTED,
  duplicate: BugStatus.DUPLICATE,
  dupe: BugStatus.DUPLICATE,
  wont_fix: BugStatus.WONT_FIX,
  will_not_fix: BugStatus.WONT_FIX,
  deferred: BugStatus.WONT_FIX,
  feature_request: BugStatus.FEATURE_REQUEST,
  enhancement: BugStatus.FEATURE_REQUEST,
  suggestion: BugStatus.FEATURE_REQUEST,
}

/**
 * `bug_types.csv` names → the closed BugType enum.
 *
 * Deliberately incomplete. A legacy type with no honest counterpart (the
 * export contains rows like "Content" and "Other") is left unmapped so the bug
 * migrates with `type = null` and a review line, rather than being filed under
 * whichever member looked closest.
 */
export const BUG_TYPE: Record<string, BugType> = {
  crash: BugType.CRASH,
  app_crash: BugType.CRASH,
  app_freeze: BugType.APP_FREEZE,
  freeze: BugType.APP_FREEZE,
  hang: BugType.APP_FREEZE,
  functional: BugType.FUNCTIONAL,
  functionality: BugType.FUNCTIONAL,
  ui: BugType.UI,
  visual: BugType.UI,
  cosmetic: BugType.UI,
  ux: BugType.UX,
  usability: BugType.UX,
  security: BugType.SECURITY,
  performance: BugType.PERFORMANCE,
  load: BugType.PERFORMANCE,
}

export const BUG_REPRODUCIBILITY: Record<string, BugReproducibility> = {
  always: BugReproducibility.ALWAYS,
  every_time: BugReproducibility.ALWAYS,
  sometimes: BugReproducibility.SOMETIMES,
  intermittent: BugReproducibility.SOMETIMES,
  occasionally: BugReproducibility.SOMETIMES,
  rarely: BugReproducibility.SOMETIMES,
  once: BugReproducibility.ONCE,
  one_time: BugReproducibility.ONCE,
  unable_to_reproduce: BugReproducibility.UNABLE_TO_REPRODUCE,
  not_reproducible: BugReproducibility.UNABLE_TO_REPRODUCE,
  cannot_reproduce: BugReproducibility.UNABLE_TO_REPRODUCE,
}

/** `cbf_type` / `cff_type` — the legacy custom-field widget. */
export const BUG_FIELD_TYPE: Record<string, BugFieldType> = {
  text: BugFieldType.TEXT,
  textbox: BugFieldType.TEXT,
  input: BugFieldType.TEXT,
  textarea: BugFieldType.TEXTAREA,
  number: BugFieldType.NUMBER,
  numeric: BugFieldType.NUMBER,
  select: BugFieldType.SELECT,
  dropdown: BugFieldType.SELECT,
  radio: BugFieldType.RADIO,
  checkbox: BugFieldType.CHECKBOX,
  multiselect: BugFieldType.CHECKBOX,
  date: BugFieldType.DATE,
  datetime: BugFieldType.DATE,
  url: BugFieldType.URL,
  link: BugFieldType.URL,
}

// ── Devices ──────────────────────────────────────────────────────────────────

export const DEVICE_TYPE: Record<string, DeviceType> = {
  mobile: DeviceType.MOBILE,
  phone: DeviceType.MOBILE,
  smartphone: DeviceType.MOBILE,
  handset: DeviceType.MOBILE,
  tablet: DeviceType.TABLET,
  ipad: DeviceType.TABLET,
  desktop: DeviceType.DESKTOP,
  laptop: DeviceType.DESKTOP,
  pc: DeviceType.DESKTOP,
  computer: DeviceType.DESKTOP,
  smart_tv: DeviceType.SMART_TV,
  tv: DeviceType.SMART_TV,
  wearable: DeviceType.WEARABLE,
  watch: DeviceType.WEARABLE,
  other: DeviceType.OTHER,
}

// ── Money ────────────────────────────────────────────────────────────────────

/** `payment_history.pmt_type`. */
export const TRANSACTION_TYPE: Record<string, TransactionType> = {
  invoice: TransactionType.CUSTOMER_INVOICE,
  customer_invoice: TransactionType.CUSTOMER_INVOICE,
  credit: TransactionType.CUSTOMER_PAYMENT,
  payment: TransactionType.CUSTOMER_PAYMENT,
  customer_payment: TransactionType.CUSTOMER_PAYMENT,
  earning: TransactionType.TESTER_EARNING,
  tester_earning: TransactionType.TESTER_EARNING,
  payout: TransactionType.TESTER_PAYOUT,
  withdrawal: TransactionType.TESTER_PAYOUT,
  tester_payout: TransactionType.TESTER_PAYOUT,
  debit: TransactionType.TESTER_PAYOUT,
  adjustment: TransactionType.ADJUSTMENT,
  refund: TransactionType.REFUND,
}

export const TRANSACTION_STATUS: Record<string, TransactionStatus> = {
  pending: TransactionStatus.PENDING,
  requested: TransactionStatus.PENDING,
  approved: TransactionStatus.APPROVED,
  released: TransactionStatus.RELEASED,
  paid: TransactionStatus.PAID,
  completed: TransactionStatus.PAID,
  success: TransactionStatus.PAID,
  failed: TransactionStatus.FAILED,
  cancelled: TransactionStatus.CANCELLED,
  canceled: TransactionStatus.CANCELLED,
  rejected: TransactionStatus.CANCELLED,
}

/** `pmt_payment_type` on payment_acc_details, and `pmt_method` on history. */
export const PAYMENT_METHOD: Record<string, PaymentMethod> = {
  bank: PaymentMethod.IND_BANK_ACCOUNT,
  bank_account: PaymentMethod.IND_BANK_ACCOUNT,
  indian_bank: PaymentMethod.IND_BANK_ACCOUNT,
  neft: PaymentMethod.IND_BANK_ACCOUNT,
  imps: PaymentMethod.IND_BANK_ACCOUNT,
  international_bank: PaymentMethod.NON_IND_BANK_ACCOUNT,
  wire: PaymentMethod.NON_IND_BANK_ACCOUNT,
  swift: PaymentMethod.NON_IND_BANK_ACCOUNT,
  paypal: PaymentMethod.PAYPAL,
  paytm: PaymentMethod.PAYTM,
}

/** `pmt_country` — enum('indian','non_indian') in the dump. */
export const PAYMENT_ACCOUNT_COUNTRY: Record<string, PaymentAccountCountry> = {
  indian: PaymentAccountCountry.INDIAN,
  india: PaymentAccountCountry.INDIAN,
  in: PaymentAccountCountry.INDIAN,
  non_indian: PaymentAccountCountry.NON_INDIAN,
  international: PaymentAccountCountry.NON_INDIAN,
  foreign: PaymentAccountCountry.NON_INDIAN,
}

// ── Communication ────────────────────────────────────────────────────────────

export const ANNOUNCEMENT_AUDIENCE: Record<string, AnnouncementAudience> = {
  all: AnnouncementAudience.ALL,
  everyone: AnnouncementAudience.ALL,
  customers: AnnouncementAudience.CUSTOMERS,
  testers: AnnouncementAudience.TESTERS,
  admins: AnnouncementAudience.ADMINS,
}

/**
 * `org_currency` is `enum('$','INR')` — a symbol, not a code. Transaction
 * .currency is a 3-letter code, so the symbol is translated here rather than
 * stored as-is.
 */
export const CURRENCY_BY_LEGACY_SYMBOL: Record<string, string> = {
  $: 'USD',
  inr: 'INR',
  '₹': 'INR',
}

/**
 * `site_settings.key_name` values the new PlatformSetting recognises.
 *
 * An allow-list rather than a passthrough: the legacy table accumulated keys
 * for features that no longer exist, and importing them would fill the
 * settings screen with configuration that controls nothing.
 */
export const PLATFORM_SETTING_KEYS: Record<string, string> = {
  site_name: 'platform.name',
  site_email: 'platform.supportEmail',
  support_email: 'platform.supportEmail',
  contact_email: 'platform.supportEmail',
  site_phone: 'platform.supportPhone',
  tds_percentage: 'finance.tdsPercent',
  tds_percent: 'finance.tdsPercent',
  min_payout: 'finance.minimumPayoutMinor',
  minimum_payout: 'finance.minimumPayoutMinor',
}
