import { BuildStatus, ProjectPriority, ProjectStatus } from '@prisma/client'
import type { Prisma } from '@prisma/client'
import { query } from '../legacy/client.js'
import { ASSIGNMENT_STATUS, TEST_CASE_RESULT } from '../mapping/lookups.js'
import {
  bool,
  enumValue,
  int,
  legacyRef,
  list,
  requiredText,
  text,
  timestamp,
  timestampOr,
} from '../transform/values.js'
import type { Loader, LoadContext, RowOutcome } from './context.js'

/**
 * Phases 3–4 — projects, builds, assignments and the test-case workflow.
 *
 * ── THE DEFAULT BUILD
 *
 * The legacy model hangs devices, browsers, languages and documents off the
 * PROJECT. The new model hangs them off a BUILD, and several required
 * relations (ProjectMaterial, Bug, ProjectAssignment) demand a buildId. Legacy
 * projects with no build row therefore need somewhere for that data to live,
 * so every project gets a default build — created from the project's own
 * fields and marked `isDefault`. It is not invented data: it is the same data,
 * relocated to where the new schema keeps it.
 */

/** Cached per run: legacy lookup tables read once. */
const appTypes = new Map<string, string>()
const testTypes = new Map<string, string>()

async function loadLookup(
  table: string,
  idCol: string,
  nameCol: string,
  into: Map<string, string>,
): Promise<void> {
  into.clear()
  try {
    const rows = await query<Record<string, unknown>>(
      `SELECT \`${idCol}\`, \`${nameCol}\` FROM \`${table}\``,
    )
    for (const r of rows) {
      const name = text(r[nameCol])
      if (name) into.set(String(r[idCol]), name)
    }
  } catch {
    // Absent lookup tables degrade to "unresolved", reported per row.
  }
}

/** The default build's deterministic key, so a re-run finds it again. */
function defaultBuildKey(projectLegacyId: string): string {
  return `project:${projectLegacyId}:default`
}

// ── projects → Project (+ default Build) ─────────────────────────────────────

export const projectLoader: Loader = {
  table: 'projects',
  target: 'Project',
  dependsOn: [
    { table: 'organisation', model: 'Organisation' },
    { table: 'users', model: 'User' },
  ],

  async prepare() {
    await loadLookup('app_types', 'at_id', 'at_name', appTypes)
    await loadLookup('test_types', 'tt_id', 'tt_name', testTypes)
  },

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.project_id)

    const organisationId = await ctx.idMap.resolve(
      'organisation',
      legacyRef(row.org_id),
      'Organisation',
    )
    if (!organisationId) {
      ctx.reporter.orphan({
        legacyTable: 'projects',
        legacyId,
        field: 'org_id',
        referencedTable: 'organisation',
        referencedId: String(row.org_id ?? ''),
      })
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'Project has no migrated organisation; Project.organisationId is required.',
      }
    }

    /*
      createdById is required. When the legacy creator did not migrate we fall
      back to the organisation's owner rather than dropping the project — the
      project is real business history, and attributing it to the org's owner
      is both truthful at the org level and reported.
    */
    let createdById = await ctx.idMap.resolve('users', legacyRef(row.project_created_by), 'User')
    if (!createdById) {
      const owner = await tx.organisationMember.findFirst({
        where: { organisationId, orgRole: 'OWNER' },
        select: { userId: true },
      })
      createdById = owner?.userId ?? null
      if (createdById) {
        ctx.reporter.problem({
          legacyTable: 'projects',
          legacyId,
          targetModel: 'Project',
          code: 'SUBSTITUTED_REFERENCE',
          field: 'project_created_by',
          value: String(row.project_created_by ?? ''),
          message: 'Creator not migrated; attributed to the organisation owner.',
          action: 'REVIEW_REQUIRED',
        })
      }
    }
    if (!createdById) {
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'No migrated creator and no organisation owner to attribute the project to.',
      }
    }

    const createdAt = timestampOr(row.project_created_date)
    const updatedAt = timestamp(row.project_update_date) ?? createdAt

    /*
      The legacy `projects` table has NO status column — status was implied by
      whether builds existed and had been tested. Rather than invent one, every
      migrated project lands as COMPLETED: it is historical data from a
      decommissioned platform, and marking a decade-old project IN_PROGRESS
      would put it back into active queues and tester dashboards.
    */
    const status: ProjectStatus = ProjectStatus.COMPLETED

    const appTypeId = legacyRef(row.project_app_type_id)
    const platformTargets = appTypeId
      ? [appTypes.get(appTypeId)].filter((v): v is string => Boolean(v))
      : []

    const existingId = await ctx.idMap.resolve('projects', legacyId, 'Project')
    const existing = existingId
      ? await tx.project.findUnique({ where: { id: existingId }, select: { id: true } })
      : await tx.project.findUnique({ where: { legacyId }, select: { id: true } })

    const data = {
      title: requiredText(row.project_title, `Legacy project ${legacyId}`),
      summary: text(row.project_desc),
      instructions:
        [text(row.project_scope), text(row.project_outof_scope)]
          .filter(Boolean)
          .join('\n\nOut of scope:\n') || null,
      status,
      priority: ProjectPriority.NORMAL,
      platformTargets,
      targetCountries: [] as string[],
      targetLanguages: list(row.project_test_lang),
      maxTesters: int(row.project_testers),
      completedAt: updatedAt,
      createdAt,
      updatedAt,
    }

    const project = existing
      ? await tx.project.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.project.create({
          data: {
            ...data,
            legacyId,
            organisationId,
            createdById,
            // A stable, collision-free reference derived from the legacy id
            // rather than a sequence, so a re-run does not mint a new number.
            reference: `C4T-LEG-${legacyId.padStart(6, '0')}`,
          },
          select: { id: true },
        })

    await ctx.idMap.remember(tx, 'projects', legacyId, 'Project', project.id)

    // ── The default build ───────────────────────────────────────────────────
    const buildKey = defaultBuildKey(legacyId)
    const existingBuildId = await ctx.idMap.resolve('projects', buildKey, 'Build')
    const buildData = {
      name: 'Legacy build',
      isDefault: true,
      status: BuildStatus.CLOSED,
      testType: legacyRef(row.project_test_type_id)
        ? (testTypes.get(String(legacyRef(row.project_test_type_id))) ?? null)
        : null,
      description: text(row.project_desc),
      instructions: text(row.project_testdata),
      targetDevices: list(row.project_devices),
      targetBrowsers: list(row.project_browsers),
      targetOperatingSystems: [] as string[],
      targetCountries: [] as string[],
      targetLanguages: list(row.project_test_lang),
      maxTesters: int(row.project_testers),
      createdAt,
      updatedAt,
    }

    const build = existingBuildId
      ? await tx.build.update({
          where: { id: existingBuildId },
          data: buildData,
          select: { id: true },
        })
      : await tx.build.create({
          data: { ...buildData, projectId: project.id },
          select: { id: true },
        })

    await ctx.idMap.remember(tx, 'projects', buildKey, 'Build', build.id)

    for (const field of ['project_cycle_type', 'project_pricing_model_id', 'export_project_key'] as const) {
      if (text(row[field])) {
        ctx.reporter.problem({
          legacyTable: 'projects',
          legacyId,
          targetModel: 'Project',
          code: 'NO_DESTINATION',
          field,
          value: String(row[field]),
          message: 'No equivalent in the new schema.',
          action: 'REVIEW_REQUIRED',
        })
      }
    }

    return { kind: 'written', created: !existing }
  },
}

// ── builds → Build ───────────────────────────────────────────────────────────

export const buildLoader: Loader = {
  table: 'builds',
  target: 'Build',
  dependsOn: [{ table: 'projects', model: 'Project' }],

  async prepare() {
    await loadLookup('test_types', 'tt_id', 'tt_name', testTypes)
  },

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.build_id)

    const projectLegacy = legacyRef(row.build_project_id ?? row.project_id)
    const projectId = await ctx.idMap.resolve('projects', projectLegacy, 'Project')
    if (!projectId) {
      ctx.reporter.orphan({
        legacyTable: 'builds',
        legacyId,
        field: 'build_project_id',
        referencedTable: 'projects',
        referencedId: String(projectLegacy ?? ''),
      })
      return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'Build has no migrated project.' }
    }

    const createdAt = timestampOr(row.build_created_date, row.build_add_date)
    const testTypeId = legacyRef(row.build_test_type_id)

    const data = {
      name: requiredText(row.build_name ?? row.build_title, `Build ${legacyId}`),
      isDefault: false,
      status: BuildStatus.CLOSED,
      testType: testTypeId ? (testTypes.get(testTypeId) ?? null) : null,
      description: text(row.build_desc ?? row.build_description),
      appUrl: text(row.build_url ?? row.build_app_url),
      releaseNotes: text(row.build_release_notes),
      instructions: text(row.build_instructions ?? row.build_testdata),
      specialRequirements: text(row.build_special_req ?? row.build_special_requirements),
      targetDevices: list(row.build_devices),
      targetBrowsers: list(row.build_browsers),
      targetOperatingSystems: list(row.build_os),
      targetCountries: list(row.build_countries),
      targetLanguages: list(row.build_language ?? row.build_test_lang),
      maxTesters: int(row.build_testers),
      bugCustomizationEnabled: bool(row.build_customize_bug, false),
      startDate: timestamp(row.build_start_date),
      endDate: timestamp(row.build_end_date),
      createdAt,
      updatedAt: timestamp(row.build_update_date) ?? createdAt,
    }

    const mapped = await ctx.idMap.resolve('builds', legacyId, 'Build')
    const existing = mapped
      ? await tx.build.findUnique({ where: { id: mapped }, select: { id: true } })
      : null

    const build = existing
      ? await tx.build.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.build.create({ data: { ...data, projectId }, select: { id: true } })

    await ctx.idMap.remember(tx, 'builds', legacyId, 'Build', build.id)
    return { kind: 'written', created: !existing }
  },
}

// ── assigned_tests → ProjectAssignment (+ Rating) ────────────────────────────

export const assignmentLoader: Loader = {
  table: 'assigned_tests',
  target: 'ProjectAssignment',
  dependsOn: [
    { table: 'builds', model: 'Build' },
    { table: 'users', model: 'User' },
  ],

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.ast_id)

    const buildId = await ctx.idMap.resolve('builds', legacyRef(row.ast_build_id), 'Build')
    const testerId = await ctx.idMap.resolve('users', legacyRef(row.ast_tester_id), 'User')

    if (!buildId || !testerId) {
      ctx.reporter.orphan({
        legacyTable: 'assigned_tests',
        legacyId,
        field: buildId ? 'ast_tester_id' : 'ast_build_id',
        referencedTable: buildId ? 'users' : 'builds',
        referencedId: String(buildId ? row.ast_tester_id : row.ast_build_id),
      })
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'Assignment references a build or tester that was not migrated.',
      }
    }

    const build = await tx.build.findUnique({
      where: { id: buildId },
      select: { projectId: true },
    })
    if (!build) {
      return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'Build vanished mid-run.' }
    }

    const invitedAt = timestampOr(row.ast_add_date)
    const status = enumValue(
      row.ast_test_status_id,
      ASSIGNMENT_STATUS,
      // A legacy assignment is finished history by definition.
      'COMPLETED',
      'ast_test_status_id',
    )

    const data = {
      status: status.value,
      invitedAt,
      respondedAt: invitedAt,
      completedAt: status.value === 'COMPLETED' ? invitedAt : null,
      notes: text(row.feedback),
    }

    const existing = await tx.projectAssignment.findUnique({
      where: {
        projectId_buildId_testerId: { projectId: build.projectId, buildId, testerId },
      },
      select: { id: true },
    })

    const assignment = existing
      ? await tx.projectAssignment.update({
          where: { id: existing.id },
          data,
          select: { id: true },
        })
      : await tx.projectAssignment.create({
          data: { ...data, projectId: build.projectId, buildId, testerId },
          select: { id: true },
        })

    await ctx.idMap.remember(tx, 'assigned_tests', legacyId, 'ProjectAssignment', assignment.id)

    /*
      The legacy row carries the customer's rating of the tester in `rate` /
      `rate_by` / `feedback`. Those are a separate model now, so the one row
      splits in two. Rating.legacyId keys on the assignment it came from.
    */
    const score = int(row.rate)
    const authorId = await ctx.idMap.resolve('users', legacyRef(row.rate_by), 'User')
    if (score !== null && score > 0 && authorId) {
      const ratingLegacyId = `assigned_tests:${legacyId}`
      const existingRating = await tx.rating.findUnique({
        where: { legacyId: ratingLegacyId },
        select: { id: true },
      })
      const ratingData = {
        score: Math.min(Math.max(score, 1), 5),
        comment: text(row.feedback),
        subjectType: 'TESTER' as const,
        subjectUserId: testerId,
        projectId: build.projectId,
        createdAt: invitedAt,
        updatedAt: invitedAt,
      }
      if (existingRating) {
        await tx.rating.update({ where: { id: existingRating.id }, data: ratingData })
      } else {
        await tx.rating.create({
          data: { ...ratingData, legacyId: ratingLegacyId, authorId },
        })
      }
    }

    return { kind: 'written', created: !existing }
  },
}

// ── test_case → TestCase ─────────────────────────────────────────────────────

export const testCaseLoader: Loader = {
  table: 'test_case',
  target: 'TestCase',
  dependsOn: [
    { table: 'builds', model: 'Build' },
    { table: 'users', model: 'User' },
  ],

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.case_id)

    const buildId = await ctx.idMap.resolve('builds', legacyRef(row.case_build_id), 'Build')
    if (!buildId) {
      ctx.reporter.orphan({
        legacyTable: 'test_case',
        legacyId,
        field: 'case_build_id',
        referencedTable: 'builds',
        referencedId: String(row.case_build_id ?? ''),
      })
      return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'Test case has no migrated build.' }
    }

    const createdById =
      (await ctx.idMap.resolve('users', legacyRef(row.case_created_by), 'User')) ??
      (await firstAdminId(ctx, tx))
    if (!createdById) {
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'No migrated author and no admin to attribute the test case to.',
      }
    }

    const createdAt = timestampOr(row.case_created_date)
    const data = {
      title: requiredText(row.case_title, `Test case ${legacyId}`),
      description: requiredText(row.case_desc, ''),
      steps: requiredText(row.case_steps, ''),
      expectedResult: requiredText(row.case_expected, ''),
      feature: text(row.case_feature),
      createdAt,
      updatedAt: createdAt,
    }

    const mapped = await ctx.idMap.resolve('test_case', legacyId, 'TestCase')
    const existing = mapped
      ? await tx.testCase.findUnique({ where: { id: mapped }, select: { id: true } })
      : null

    const testCase = existing
      ? await tx.testCase.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.testCase.create({ data: { ...data, buildId, createdById }, select: { id: true } })

    await ctx.idMap.remember(tx, 'test_case', legacyId, 'TestCase', testCase.id)
    return { kind: 'written', created: !existing }
  },
}

// ── test_report → TestReport ─────────────────────────────────────────────────

export const testReportLoader: Loader = {
  table: 'test_report',
  target: 'TestReport',
  dependsOn: [
    { table: 'test_case', model: 'TestCase' },
    { table: 'users', model: 'User' },
  ],

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.trep_id)

    const testCaseId = await ctx.idMap.resolve('test_case', legacyRef(row.trep_case_id), 'TestCase')
    const testerId = await ctx.idMap.resolve('users', legacyRef(row.trep_tester_id), 'User')
    if (!testCaseId || !testerId) {
      ctx.reporter.orphan({
        legacyTable: 'test_report',
        legacyId,
        field: testCaseId ? 'trep_tester_id' : 'trep_case_id',
        referencedTable: testCaseId ? 'users' : 'test_case',
        referencedId: String(testCaseId ? row.trep_tester_id : row.trep_case_id),
      })
      return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'Report has no migrated case or tester.' }
    }

    const testCase = await tx.testCase.findUnique({
      where: { id: testCaseId },
      select: { buildId: true },
    })
    if (!testCase) {
      return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'Test case vanished mid-run.' }
    }

    const result = enumValue(row.trep_result ?? row.trep_status, TEST_CASE_RESULT, 'NOT_TESTED', 'trep_result')

    /*
      `trep_defect_id` is what makes a bug the OUTCOME of executing a test case
      rather than a free-floating report — the single most load-bearing column
      in the legacy testing workflow. Bugs migrate in phase 5, after this, so
      the link is resolved by `linkTestReportsToBugs` once both sides exist.
    */
    const createdAt = timestampOr(row.trep_created_date, row.trep_add_date)
    const data = {
      result: result.value,
      notes: text(row.trep_notes ?? row.trep_comment),
      devices: text(row.trep_devices),
      browsers: text(row.trep_browsers),
      createdAt,
      updatedAt: createdAt,
    }

    const mapped = await ctx.idMap.resolve('test_report', legacyId, 'TestReport')
    const existing = mapped
      ? await tx.testReport.findUnique({ where: { id: mapped }, select: { id: true } })
      : null

    const report = existing
      ? await tx.testReport.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.testReport.create({
          data: { ...data, testCaseId, buildId: testCase.buildId, testerId },
          select: { id: true },
        })

    await ctx.idMap.remember(tx, 'test_report', legacyId, 'TestReport', report.id)

    // Remembered so phase 5 can resolve it without re-reading MySQL.
    const defectId = legacyRef(row.trep_defect_id)
    if (defectId) {
      await ctx.idMap.remember(tx, 'test_report_defect', legacyId, 'PendingBugLink', defectId)
    }

    return { kind: 'written', created: !existing }
  },
}

// ── test_review → TestReview ─────────────────────────────────────────────────

export const testReviewLoader: Loader = {
  table: 'test_review',
  target: 'TestReview',
  dependsOn: [
    { table: 'builds', model: 'Build' },
    { table: 'users', model: 'User' },
  ],

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.rvw_id)

    const buildId = await ctx.idMap.resolve('builds', legacyRef(row.rvw_build_id), 'Build')
    if (!buildId) {
      ctx.reporter.orphan({
        legacyTable: 'test_review',
        legacyId,
        field: 'rvw_build_id',
        referencedTable: 'builds',
        referencedId: String(row.rvw_build_id ?? ''),
      })
      return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'Review has no migrated build.' }
    }

    const createdById =
      (await ctx.idMap.resolve('users', legacyRef(row.rvw_created_by), 'User')) ??
      (await firstAdminId(ctx, tx))
    if (!createdById) {
      return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'No author for the review.' }
    }

    const createdAt = timestampOr(row.rvw_created_date)
    const data = {
      summary: requiredText(row.rvw_summary ?? row.rvw_comment, `Legacy review ${legacyId}`),
      rating: int(row.rvw_val),
      createdAt,
    }

    const mapped = await ctx.idMap.resolve('test_review', legacyId, 'TestReview')
    const existing = mapped
      ? await tx.testReview.findUnique({ where: { id: mapped }, select: { id: true } })
      : null

    const review = existing
      ? await tx.testReview.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.testReview.create({ data: { ...data, buildId, createdById }, select: { id: true } })

    await ctx.idMap.remember(tx, 'test_review', legacyId, 'TestReview', review.id)
    return { kind: 'written', created: !existing }
  },
}

// ── assign_testCase → TestCaseAssignment ─────────────────────────────────────

export const testCaseAssignmentLoader: Loader = {
  // Spelled camelCase in the dump; not a typo here.
  table: 'assign_testCase',
  target: 'TestCaseAssignment',
  dependsOn: [
    { table: 'test_case', model: 'TestCase' },
    { table: 'users', model: 'User' },
  ],

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.Sno)

    const testCaseId = await ctx.idMap.resolve('test_case', legacyRef(row.case_id), 'TestCase')
    const testerId = await ctx.idMap.resolve(
      'users',
      legacyRef(row.tester_id ?? row.user_id),
      'User',
    )
    if (!testCaseId || !testerId) {
      ctx.reporter.orphan({
        legacyTable: 'assign_testCase',
        legacyId,
        field: testCaseId ? 'tester_id' : 'case_id',
        referencedTable: testCaseId ? 'users' : 'test_case',
        referencedId: String(testCaseId ? (row.tester_id ?? row.user_id) : row.case_id),
      })
      return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'Missing test case or tester.' }
    }

    const existing = await tx.testCaseAssignment.findUnique({
      where: { testCaseId_testerId: { testCaseId, testerId } },
      select: { id: true },
    })

    const assignment =
      existing ??
      (await tx.testCaseAssignment.create({
        data: { testCaseId, testerId, assignedAt: timestampOr(row.assigned_date) },
        select: { id: true },
      }))

    await ctx.idMap.remember(
      tx,
      'assign_testCase',
      legacyId,
      'TestCaseAssignment',
      assignment.id,
    )
    return { kind: 'written', created: !existing }
  },
}

/** Fallback author when the legacy one did not migrate. Cached per run. */
let adminId: string | null | undefined
async function firstAdminId(
  ctx: LoadContext,
  tx: Prisma.TransactionClient,
): Promise<string | null> {
  if (adminId !== undefined) return adminId
  const admin = await tx.user.findFirst({
    where: { role: 'ADMIN', deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  adminId = admin?.id ?? null
  if (!adminId) {
    ctx.reporter.review(
      'users',
      'No ADMIN user exists to attribute orphaned authorship to; those rows will be skipped.',
    )
  }
  return adminId
}

export const projectLoaders: Loader[] = [
  projectLoader,
  buildLoader,
  assignmentLoader,
  testCaseLoader,
  testCaseAssignmentLoader,
  testReportLoader,
  testReviewLoader,
]
