/**
 * The complete legacy → new mapping. All 66 tables, none omitted.
 *
 * ── WHY THIS IS CODE AND NOT A MARKDOWN TABLE
 *
 * The brief asks for both a mapping document and a migration that implements
 * it. Kept as two artefacts they drift: the table says `payment_history →
 * Transaction` months after the loader stopped doing that. So this registry is
 * the single source — the runner reads it to decide what to migrate and in
 * what order, and `report/matrix.ts` renders MIGRATION.md's matrix from the
 * same rows. A mapping that is not in here does not happen.
 *
 * ── DISPOSITIONS (brief §22)
 *
 *   ACTIVE_EQUIVALENT      the new platform has this concept, in use
 *   HISTORICAL_EQUIVALENT  representable, but as history rather than live state
 *   REFERENCE_LOOKUP       read to resolve ids; its rows are not themselves migrated
 *   DEPRECATED             the concept was retired deliberately
 *   NO_EQUIVALENT          nothing in the new schema can hold it
 *
 * ── KINDS (brief §3)
 *
 *   DIRECT · RENAMED · SPLIT · MERGED · JUNCTION · NOT_MIGRATED
 */

export type Disposition =
  | 'ACTIVE_EQUIVALENT'
  | 'HISTORICAL_EQUIVALENT'
  | 'REFERENCE_LOOKUP'
  | 'DEPRECATED'
  | 'NO_EQUIVALENT'

export type MappingKind = 'DIRECT' | 'RENAMED' | 'SPLIT' | 'MERGED' | 'JUNCTION' | 'NOT_MIGRATED'

export interface TableMapping {
  /** Legacy table name, exactly as it appears in the dump. */
  legacyTable: string
  /** Legacy primary key. Null only for `ci_sessions`, which has none. */
  legacyPk: string | null
  /** Destination models. Empty when nothing is written. */
  targets: string[]
  disposition: Disposition
  kind: MappingKind
  /** Migration phase; lower runs first. See `phases.ts`. */
  phase: number
  /** One line for the matrix: what actually happens to the data. */
  transformation: string
  /** Why, when the answer is "nothing" — or the caveat when it is not. */
  notes: string
}

export const REGISTRY: readonly TableMapping[] = [
  // ── Phase 1 · Reference and catalog ───────────────────────────────────────
  {
    legacyTable: 'roles',
    legacyPk: 'rol_id',
    targets: ['Role (enum)'],
    disposition: 'REFERENCE_LOOKUP',
    kind: 'NOT_MIGRATED',
    phase: 1,
    transformation: 'rol_id → Role enum member, via ROLE_BY_LEGACY_ID',
    notes:
      'The new platform models roles as a Prisma enum on User, not rows. Read to resolve users.usr_role_id and user_organisation_map.uom_role_id; nothing is written.',
  },
  {
    legacyTable: 'permissions',
    legacyPk: 'per_id',
    targets: ['Permission (seeded from code)'],
    disposition: 'REFERENCE_LOOKUP',
    kind: 'NOT_MIGRATED',
    phase: 1,
    transformation: 'per_name → an existing Permission.code, for resolving grants only',
    notes:
      'The new permission catalogue is a CLOSED set defined in src/config/permissions.ts and seeded idempotently by prisma/seed.ts. A legacy permission code that is not in that set gates nothing — importing it would fill the admin screen with permissions no route checks, the same failure as importing unknown site_settings keys. Read only to resolve which users held which grants.',
  },
  {
    legacyTable: 'skill_categories',
    legacyPk: 'scat_id',
    targets: ['SkillCategory'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'DIRECT',
    phase: 1,
    transformation: 'scat_name → name + slug',
    notes: 'Already imported by prisma/seed-catalog.ts from DataCSV. Idempotent upsert on slug.',
  },
  {
    legacyTable: 'skills',
    legacyPk: 'sname_id',
    targets: ['Skill'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'DIRECT',
    phase: 1,
    transformation: 'sname → name + slug, category via scat_id',
    notes:
      'Seeded from DataCSV with documented name fixes (bracketed abbreviations, Localisation/Localization).',
  },
  {
    legacyTable: 'os',
    legacyPk: 'os_id',
    targets: ['OperatingSystem'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'MERGED',
    phase: 1,
    transformation: 'os_name → OperatingSystem, kind from OS_KIND_BY_LEGACY_ID',
    notes: 'Merged with mobile_os_type into one OperatingSystem table split by OsKind.',
  },
  {
    legacyTable: 'os_versions',
    legacyPk: 'os_id',
    targets: ['OsVersion'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'MERGED',
    phase: 1,
    transformation: 'version → OsVersion.version, parent via os_type_id',
    notes:
      'Legacy PK is confusingly also called os_id. Merged with mobile_os_version. Seeded from DataCSV.',
  },
  {
    legacyTable: 'mobile_os_type',
    legacyPk: 'ost_id',
    targets: ['OperatingSystem'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'MERGED',
    phase: 1,
    transformation: 'ost_name → OperatingSystem with kind=MOBILE',
    notes: 'Second half of the OS merge. No DataCSV export; read from the live database.',
  },
  {
    legacyTable: 'mobile_os_version',
    legacyPk: 'mov_id',
    targets: ['OsVersion'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'MERGED',
    phase: 1,
    transformation: 'mov_name → OsVersion under the MOBILE OperatingSystem',
    notes: 'Second half of the OS-version merge.',
  },
  {
    legacyTable: 'browsers',
    legacyPk: 'brw_id',
    targets: ['Browser'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'DIRECT',
    phase: 1,
    transformation: 'brw_name → name + slug',
    notes: 'Seeded from DataCSV.',
  },
  {
    legacyTable: 'browser_versions',
    legacyPk: 'version_id',
    targets: ['BrowserVersion'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'DIRECT',
    phase: 1,
    transformation: 'version → BrowserVersion.version, parent via brw_id',
    notes: 'No DataCSV export — this one only exists in the live database.',
  },
  {
    legacyTable: 'mobile_brands',
    legacyPk: 'mbr_id',
    targets: ['DeviceBrand'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'DIRECT',
    phase: 1,
    transformation: 'mbr_name → DeviceBrand.name, case-normalised',
    notes: 'Seeded from DataCSV; "lge" folded into "LG" as the same manufacturer.',
  },
  {
    legacyTable: 'network_providers',
    legacyPk: 'network_id',
    targets: ['NetworkProvider'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'DIRECT',
    phase: 1,
    transformation: 'network_name + country → NetworkProvider',
    notes: 'Carrier list used by TesterDevice.primaryNetworkId / secondaryNetworkId.',
  },
  {
    legacyTable: 'base_country',
    legacyPk: 'id',
    targets: ['ISO country codes'],
    disposition: 'REFERENCE_LOOKUP',
    kind: 'NOT_MIGRATED',
    phase: 1,
    transformation: 'country name → ISO 3166-1 alpha-2',
    notes:
      'The new schema stores bare alpha-2 codes and validates them against src/lib/iso-countries.ts. A second country table would be a duplicate source, which the platform rules forbid.',
  },
  {
    legacyTable: 'app_types',
    legacyPk: 'at_id',
    targets: ['Project.platformTargets'],
    disposition: 'REFERENCE_LOOKUP',
    kind: 'NOT_MIGRATED',
    phase: 1,
    transformation: 'at_name → a string in Project.platformTargets[]',
    notes: 'Resolved when projects are migrated. Seeded from DataCSV for reference.',
  },
  {
    legacyTable: 'test_types',
    legacyPk: 'tt_id',
    targets: ['Build.testType'],
    disposition: 'REFERENCE_LOOKUP',
    kind: 'NOT_MIGRATED',
    phase: 1,
    transformation: 'tt_name → Build.testType (free text on the new model)',
    notes: 'Kept as a lookup so builds carry a readable name rather than a legacy integer.',
  },
  {
    legacyTable: 'test_status',
    legacyPk: 'ts_id',
    targets: ['TestCaseResult (enum)', 'AssignmentStatus (enum)'],
    disposition: 'REFERENCE_LOOKUP',
    kind: 'NOT_MIGRATED',
    phase: 1,
    transformation: 'ts_name → enum member',
    notes: 'Resolves assigned_tests.ast_test_status_id and test_report result values.',
  },
  {
    legacyTable: 'bug_types',
    legacyPk: 'bt_id',
    targets: ['BugType (enum)'],
    disposition: 'REFERENCE_LOOKUP',
    kind: 'NOT_MIGRATED',
    phase: 1,
    transformation: 'bt_name → BugType enum member',
    notes:
      'The new BugType is a closed enum (CRASH, APP_FREEZE, FUNCTIONAL, UI, UX, SECURITY, PERFORMANCE). Legacy names outside it are reported and the bug is stored with type=null rather than being forced into the wrong member.',
  },
  {
    legacyTable: 'pricing_models',
    legacyPk: 'pm_id',
    targets: [],
    disposition: 'NO_EQUIVALENT',
    kind: 'NOT_MIGRATED',
    phase: 1,
    transformation: '—',
    notes:
      'The new platform has no pricing/plan model; commercial terms live outside it. Retained in the legacy database for reference. Referenced by projects.project_pricing_model_id, which is dropped with a note.',
  },
  {
    legacyTable: 'resources',
    legacyPk: 'res_id',
    targets: [],
    disposition: 'NO_EQUIVALENT',
    kind: 'NOT_MIGRATED',
    phase: 1,
    transformation: '—',
    notes:
      'A three-column lookup (res_name, res_desc) with no inbound reference anywhere else in the 66-table schema. Nothing consumes it; nothing to preserve.',
  },

  // ── Phase 2 · Identity ────────────────────────────────────────────────────
  {
    legacyTable: 'users',
    legacyPk: 'usr_id',
    targets: ['User', 'TesterProfile', 'FileObject'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'SPLIT',
    phase: 2,
    transformation:
      'Account fields → User (legacyId=usr_id); testing fields → TesterProfile; usr_profile_pic → FileObject + User.avatarFileId',
    notes:
      'usr_password (varchar(50)) is unsalted MD5/SHA-1 — carried across with passwordAlgo set by digest length and upgraded to Argon2id on first successful sign-in. jira_username/password/url, usr_apple and export have no equivalent and are reported. usr_account_balance is NOT copied: the new balance is derived from the Transaction ledger, and a stored figure would be a second, diverging source.',
  },
  {
    legacyTable: 'organisation',
    legacyPk: 'org_id',
    targets: ['Organisation', 'FileObject'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'RENAMED',
    phase: 2,
    transformation: 'org_title → name (+ slug), org_address → addressLine1, org_desc → notes',
    notes:
      'org_wallet_balance, locked_amount, credit_rate, test_manager_fee and active_plan_id have no destination — the ledger is the source of truth for money. org_currency (enum $/INR) is carried onto each migrated Transaction instead.',
  },
  {
    legacyTable: 'user_organisation_map',
    legacyPk: 'uom_id',
    targets: ['OrganisationMember'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'JUNCTION',
    phase: 2,
    transformation: 'uom_user_id + uom_org_id → OrganisationMember, uom_role_id → OrgMemberRole',
    notes:
      'uom_status=inactive has no equivalent (OrganisationMember has no status column); those rows are skipped and reported rather than silently reactivating a removed member.',
  },
  {
    legacyTable: 'user_invitation',
    legacyPk: 'invite_id',
    targets: ['OrganisationInvitation'],
    disposition: 'HISTORICAL_EQUIVALENT',
    kind: 'RENAMED',
    phase: 2,
    transformation: 'invite_email → email, invite_accepted → acceptedAt, invite_role → orgRole',
    notes:
      'invite_passcode is NOT migrated into tokenHash: the new flow hashes a single-use token and a legacy passcode is not one. Accepted invitations migrate as history; pending ones migrate already expired, so nobody can redeem a ten-year-old code.',
  },

  // ── Phase 3 · Organisation data ───────────────────────────────────────────
  {
    legacyTable: 'active_plans',
    legacyPk: 'act_pid',
    targets: [],
    disposition: 'NO_EQUIVALENT',
    kind: 'NOT_MIGRATED',
    phase: 3,
    transformation: '—',
    notes:
      'Subscription plans (plan_name enum) have no counterpart; the new platform does not model subscriptions. Reported so the commercial history is known to exist in the legacy database.',
  },
  {
    legacyTable: 'projects',
    legacyPk: 'project_id',
    targets: ['Project', 'Build', 'FileObject'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'SPLIT',
    phase: 3,
    transformation:
      'project_title → title, project_desc → summary, project_scope/out_of_scope → instructions; device/browser/language CSV columns → the default Build',
    notes:
      'The legacy table has no status column, so ProjectStatus is derived from its builds and dates. project_devices/browsers/test_lang are comma-separated varchars that belong to a build in the new model, so a default Build is created per project to hold them. project_cycle_type, project_pricing_model_id and export_project_key have no destination.',
  },
  {
    legacyTable: 'marketing',
    legacyPk: 'Sno',
    targets: ['Lead'],
    disposition: 'HISTORICAL_EQUIVALENT',
    kind: 'RENAMED',
    phase: 3,
    transformation: 'FirstName/LastName/Email/Phone/organization → Lead, status=NEW',
    notes:
      'Website enquiry capture. Maps cleanly onto the new Lead model. marketingConsent defaults false — consent was not recorded, and assuming it is not something a migration may do.',
  },

  // ── Phase 4 · Builds and testing ──────────────────────────────────────────
  {
    legacyTable: 'builds',
    legacyPk: 'build_id',
    targets: ['Build', 'BugCustomField'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'DIRECT',
    phase: 4,
    transformation: '41 columns → Build; target device/browser/OS/country/language CSVs → String[]',
    notes:
      'Build has no legacyId column, so the mapping lives in migration_record_map. build_customize_bug drives bugCustomizationEnabled.',
  },
  {
    legacyTable: 'documents',
    legacyPk: 'doc_id',
    targets: ['ProjectMaterial', 'FileObject'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'SPLIT',
    phase: 4,
    transformation: 'doc_filename + doc_loc_server → FileObject; doc_title → ProjectMaterial.title',
    notes:
      'ProjectMaterial requires both projectId and buildId; a document with only doc_project_id is attached to that project’s default build.',
  },
  {
    legacyTable: 'build_reports',
    legacyPk: 'brep_id',
    targets: ['ProjectMaterial', 'FileObject'],
    disposition: 'HISTORICAL_EQUIVALENT',
    kind: 'MERGED',
    phase: 4,
    transformation: 'brep_file_name → FileObject + ProjectMaterial on the build',
    notes:
      'Uploaded per-build report files. No dedicated model; merged into ProjectMaterial, which is what the new platform uses for build-scoped artefacts.',
  },
  {
    legacyTable: 'assigned_tests',
    legacyPk: 'ast_id',
    targets: ['ProjectAssignment', 'Rating'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'SPLIT',
    phase: 4,
    transformation:
      'ast_build_id + ast_tester_id → ProjectAssignment; rate/rate_by/feedback → Rating',
    notes:
      'The legacy row carries both the assignment and the customer’s rating of the tester, which are separate models now. ast_pmt_status and credit are handled in phase 7 as ledger entries, not here.',
  },
  {
    legacyTable: 'applied_tests',
    legacyPk: 'apt_id',
    targets: [],
    disposition: 'DEPRECATED',
    kind: 'NOT_MIGRATED',
    phase: 4,
    transformation: '—',
    notes:
      'A tester applying to a project. The new platform is invite-only by design — there is no apply direction to migrate into, and creating assignments from applications would fabricate acceptances that never happened. Reported so the applications remain traceable.',
  },
  {
    legacyTable: 'assign_testCase',
    legacyPk: 'Sno',
    targets: ['TestCaseAssignment'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'JUNCTION',
    phase: 4,
    transformation: 'case_id + tester id → TestCaseAssignment',
    notes: 'Note the camelCase table name — it is spelled that way in the dump.',
  },
  {
    legacyTable: 'test_case',
    legacyPk: 'case_id',
    targets: ['TestCase'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'DIRECT',
    phase: 4,
    transformation: 'case_title → title, steps → steps, expected → expectedResult',
    notes:
      'The new schema gained TestCase/TestReport/TestReview after the first legacy audit was written; that audit’s "structured testing workflow is MISSING" verdict is out of date.',
  },
  {
    legacyTable: 'test_report',
    legacyPk: 'trep_id',
    targets: ['TestReport'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'DIRECT',
    phase: 4,
    transformation: 'result → TestCaseResult, trep_defect_id → TestReport.linkedBugId',
    notes:
      'trep_defect_id is the load-bearing column: it is what makes a bug the outcome of executing a test case rather than a free-floating report. Resolved in phase 5 once bugs exist.',
  },
  {
    legacyTable: 'test_review',
    legacyPk: 'rvw_id',
    targets: ['TestReview'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'DIRECT',
    phase: 4,
    transformation: 'rvw_summary → summary, rvw_val → rating',
    notes: 'Build-level review with a numeric rating.',
  },
  {
    legacyTable: 'test_scenarios',
    legacyPk: 'tsc_id',
    targets: [],
    disposition: 'NO_EQUIVALENT',
    kind: 'NOT_MIGRATED',
    phase: 4,
    transformation: '—',
    notes:
      'Scenarios sit above test cases in the legacy hierarchy. The new schema models cases directly on a build with no scenario grouping, so there is no column to hold a scenario and flattening would invent structure. Reported for review.',
  },
  {
    legacyTable: 'test_scenario_reports',
    legacyPk: 'tsr_id',
    targets: [],
    disposition: 'NO_EQUIVALENT',
    kind: 'NOT_MIGRATED',
    phase: 4,
    transformation: '—',
    notes: 'Depends on test_scenarios, which has no destination.',
  },
  {
    legacyTable: 'testing_time_sheet',
    legacyPk: 'tts_id',
    targets: [],
    disposition: 'NO_EQUIVALENT',
    kind: 'NOT_MIGRATED',
    phase: 4,
    transformation: '—',
    notes:
      'Logged time with tts_approved_time/tts_approved_by, so it fed billing. The new platform has no timesheet model. Flagged as a genuine capability gap rather than obsolete data — see MIGRATION.md, "Known incompatibilities".',
  },

  // ── Phase 5 · Defects ─────────────────────────────────────────────────────
  {
    legacyTable: 'bugs_report',
    legacyPk: 'bug_id',
    targets: ['Bug'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'DIRECT',
    phase: 5,
    transformation:
      '33 columns → Bug (legacyId=bug_id); severity/status/type/reproducibility → enums',
    notes:
      'Bug.buildId is required but the legacy column is nullable, so a bug with no build is attached to its project’s default build rather than dropped. Legacy statuses outside BugStatus are reported and mapped to the closest member.',
  },
  {
    legacyTable: 'defect_comments',
    legacyPk: 'comments_id',
    targets: ['BugComment'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'DIRECT',
    phase: 5,
    transformation: 'comment body → BugComment.body, author via written_by',
    notes: 'isInternal defaults false — the legacy table draws no internal/external distinction.',
  },
  {
    legacyTable: 'attachments',
    legacyPk: 'attach_id',
    targets: ['BugAttachment', 'FileObject'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'SPLIT',
    phase: 5,
    transformation: 'attach_filename + attach_loc_server → FileObject; row → BugAttachment',
    notes:
      'THIS TABLE IS EMPTY — zero rows in the live database. Every attachment the platform ever took is held inline on the row instead: bugs_report.bug_screen1 (13,945), bug_screen2 (1,937), bug_attachment (386), and defect_comments.comments_attach1 (1,405) / attach2 (244). The bug and comment loaders read those columns, so BugAttachment is populated from there and not from here. A BugAttachment cannot exist without a FileObject, so an attachment whose file cannot be located is reported in missing-files.csv and skipped rather than pointed at a URL that 404s.',
  },
  {
    legacyTable: 'cust_bug_fields',
    legacyPk: 'cbf_id',
    targets: ['BugCustomField'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'DIRECT',
    phase: 5,
    transformation: 'cbf_name → name, cbf_type → BugFieldType, options CSV → options[]',
    notes: 'Custom bug fields are build-scoped in both schemas.',
  },
  {
    legacyTable: 'cust_bug_answers',
    legacyPk: 'cbfa_id',
    targets: ['BugCustomValue'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'DIRECT',
    phase: 5,
    transformation: 'answer → BugCustomValue.value, keyed by bug + field',
    notes: 'Skipped when either the bug or the field failed to migrate.',
  },
  {
    legacyTable: 'comments_monitor',
    legacyPk: 'monitor_id',
    targets: [],
    disposition: 'NO_EQUIVALENT',
    kind: 'NOT_MIGRATED',
    phase: 5,
    transformation: '—',
    notes:
      'Looks like 99,862 per-user read receipts for bug comments. It is not: COUNT(DISTINCT user_read) = 1 against the live database — every row says 0, unread. The flag was never updated in the platform’s life, so the table records who a comment was addressed to and nothing about whether anyone read it. A model and 99,862 rows for a column with one value would be schema surface with no information in it. Not migrated on that evidence, not for want of a destination.',
  },

  // ── Phase 6 · Contests ────────────────────────────────────────────────────
  ...(
    [
      [
        'contests',
        'contest_id',
        'The contest itself — 34 columns including prizes, gender targeting and custom feedback.',
      ],
      ['contest_tasks', 'task_id', 'Tasks within a contest.'],
      ['contest_question', 'question_id', 'Survey questions (survey_type, answer_type).'],
      ['contest_answers', 'answer_id', 'Participant answers.'],
      ['contest_participant', 'participant_id', 'Who entered.'],
      ['contest_feedback', 'feedback_id', 'Feedback submitted per contest.'],
      ['cust_feedback_fields', 'cff_id', 'Custom feedback field definitions, contest-scoped.'],
      ['cust_feedback_answers', 'cffa_id', 'Answers to those custom feedback fields.'],
    ] as const
  ).map(([legacyTable, legacyPk, what]) => ({
    legacyTable,
    legacyPk,
    targets: [] as string[],
    disposition: 'NO_EQUIVALENT' as const,
    kind: 'NOT_MIGRATED' as const,
    phase: 6,
    transformation: '—',
    notes: `${what} The new platform has no contest feature at all — no model, no route, no UI. Eight tables of real historical data with nowhere to land; migrating them would require designing and building the feature first. Reported in full so nothing is lost from the record.`,
  })),

  // ── Phase 7 · Financial ───────────────────────────────────────────────────
  {
    legacyTable: 'payment_acc_details',
    legacyPk: 'pmt_id',
    targets: ['PaymentAccount'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'DIRECT',
    phase: 7,
    transformation:
      'Bank/PayPal/Paytm details → encrypted PaymentAccount.secureDetails + masked display fields',
    notes:
      'The legacy table stores account numbers in the clear. The new model encrypts them into secureDetails and keeps only a last-4/masked form for display, so the migration encrypts on the way in. Raw values never reach a log or a report.',
  },
  {
    legacyTable: 'payment_history',
    legacyPk: 'pmt_id',
    targets: ['Transaction'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'DIRECT',
    phase: 7,
    transformation:
      'pmt_amount → amountMinor (BigInt), pmt_type/method/status → enums, legacyId=pmt_id',
    notes:
      'Amounts move from float/varchar to integer minor units — the reason the new schema uses BigInt. Currency comes from the owning organisation’s org_currency.',
  },
  {
    legacyTable: 'tds_history',
    legacyPk: 'tds_id',
    targets: ['Transaction.tdsAmountMinor'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'MERGED',
    phase: 7,
    transformation: 'tds amount → tdsAmountMinor on the related Transaction',
    notes:
      'Indian withholding tax. Merged onto the transaction it belongs to rather than kept as a separate ledger, which is how the new schema models it.',
  },

  // ── Phase 8 · Communication and system ────────────────────────────────────
  {
    legacyTable: 'message',
    legacyPk: 'id',
    targets: ['Broadcast'],
    disposition: 'HISTORICAL_EQUIVALENT',
    kind: 'RENAMED',
    phase: 8,
    transformation: 'creator_id → senderId, message_body → body, status=SENT',
    notes:
      'One author, many recipients, no reply — that is the new Broadcast model, not Thread/Message (which is two-way). Mapping it to a Thread would imply conversations that never existed.',
  },
  {
    legacyTable: 'message_recipient',
    legacyPk: 'id',
    targets: ['BroadcastRecipient'],
    disposition: 'HISTORICAL_EQUIVALENT',
    kind: 'JUNCTION',
    phase: 8,
    transformation: 'recipient_id + message_id → BroadcastRecipient',
    notes:
      'is_read has no destination — BroadcastRecipient records delivery and failure, not reading. Reported once per run rather than per row.',
  },
  {
    legacyTable: 'announcements',
    legacyPk: 'id',
    targets: ['Announcement'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'DIRECT',
    phase: 8,
    transformation: 'A_body → body, A_build_id → buildId, audience=ALL',
    notes:
      'Announcement.title is required and the legacy table has no title column; the first line of the body is used, which is what the legacy UI displayed anyway.',
  },
  {
    legacyTable: 'notification',
    legacyPk: 'Sno',
    targets: [],
    disposition: 'NO_EQUIVALENT',
    kind: 'NOT_MIGRATED',
    phase: 8,
    transformation: '—',
    notes:
      'Per-organisation notification PREFERENCES (allN, buildStatus, criticalDef), not notification records. The new platform has a single per-user User.emailNotifications flag and no per-event or per-org preferences, so there is nothing with the right shape to receive these.',
  },
  {
    legacyTable: 'site_settings',
    legacyPk: 'id',
    targets: ['PlatformSetting'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'DIRECT',
    phase: 8,
    transformation: 'key_name → key, key_value → value',
    notes:
      'Imported only where the key is one the new platform recognises; unknown legacy keys are reported rather than written, so the settings table does not fill with dead configuration.',
  },
  {
    legacyTable: 'site_statistics',
    legacyPk: 'stat_id',
    targets: [],
    disposition: 'DEPRECATED',
    kind: 'NOT_MIGRATED',
    phase: 8,
    transformation: '—',
    notes:
      'A precomputed rollup of counts the new platform queries live. Migrating it would create a second, immediately stale source for numbers the database can already answer exactly.',
  },

  // ── Phase 9 · Automation ──────────────────────────────────────────────────
  {
    legacyTable: 'automation_modules',
    legacyPk: 'tc_id',
    targets: [],
    disposition: 'NO_EQUIVALENT',
    kind: 'NOT_MIGRATED',
    phase: 9,
    transformation: '—',
    notes:
      'Automation suites. The new platform has no automation feature. Reported; the data stays in the legacy database.',
  },
  {
    legacyTable: 'automation_reports',
    legacyPk: 'ID',
    targets: [],
    disposition: 'NO_EQUIVALENT',
    kind: 'NOT_MIGRATED',
    phase: 9,
    transformation: '—',
    notes: 'Automation run results. Depends on automation_modules, which has no destination.',
  },

  // ── Devices, owned by testers ─────────────────────────────────────────────
  {
    legacyTable: 'devices',
    legacyPk: 'dvc_id',
    targets: ['TesterDevice'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'DIRECT',
    phase: 2,
    transformation:
      'dvc_manufacturer/name/ram/screen/networks → TesterDevice, linked to the catalog where a match exists',
    notes:
      'Runs late in phase 2 because it depends on users. Free-text legacy values are preserved alongside the catalog foreign keys rather than replaced, so an unrecognised handset still displays.',
  },
  {
    legacyTable: 'user_browsers',
    legacyPk: 'user_browsers_id',
    targets: ['TesterBrowser'],
    disposition: 'ACTIVE_EQUIVALENT',
    kind: 'JUNCTION',
    phase: 2,
    transformation: '(user, os, browser, browser_version) → TesterBrowser',
    notes: 'Depends on the phase-1 browser and OS catalog.',
  },

  // ── Infrastructure ────────────────────────────────────────────────────────
  {
    legacyTable: 'ci_sessions',
    legacyPk: null,
    targets: [],
    disposition: 'DEPRECATED',
    kind: 'NOT_MIGRATED',
    phase: 99,
    transformation: '—',
    notes:
      'CodeIgniter PHP session storage — ephemeral infrastructure, not business data, and the brief calls it out by name. The new platform issues its own stateful sessions; importing decade-old PHP session blobs would be meaningless and is the one table with no primary key to stream on.',
  },
]

/** Fails loudly if the registry and the dump ever disagree about the table list. */
export const REGISTRY_BY_TABLE: ReadonlyMap<string, TableMapping> = new Map(
  REGISTRY.map((m) => [m.legacyTable, m]),
)

export function mappingsInPhaseOrder(): TableMapping[] {
  return [...REGISTRY].sort((a, b) =>
    a.phase === b.phase ? a.legacyTable.localeCompare(b.legacyTable) : a.phase - b.phase,
  )
}

/** The tables this run should actually read. */
export function selectedMappings(only: string[], skip: string[]): TableMapping[] {
  return mappingsInPhaseOrder().filter((m) => {
    if (only.length > 0 && !only.includes(m.legacyTable)) return false
    if (skip.includes(m.legacyTable)) return false
    return true
  })
}

export function isMigrated(m: TableMapping): boolean {
  return m.kind !== 'NOT_MIGRATED'
}
