import { BuildStatus, ProjectPriority, ProjectStatus } from '@prisma/client'
import type { Prisma } from '@prisma/client'
import { query } from '../legacy/client.js'
import { ASSIGNMENT_STATUS, BUILD_STATUS, TEST_CASE_RESULT } from '../mapping/lookups.js'
import {
  asText,
  enumValue,
  int,
  legacyRef,
  list,
  requiredText,
  text,
  timestamp,
  timestampOr,
  bool,
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
/** Legacy test_status id -> name, for assigned_tests.ast_test_status_id. */
const testStatuses = new Map<string, string>()

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
        referencedId: asText(row.org_id),
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
          value: asText(row.project_created_by),
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

    for (const field of [
      'project_cycle_type',
      'project_pricing_model_id',
      'export_project_key',
    ] as const) {
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
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'Build has no migrated project.',
      }
    }

    const createdAt = timestampOr(row.build_add_date)
    const testTypeId = legacyRef(row.build_test_type_id)
    const buildStatus = enumValue(
      row.build_test_status,
      BUILD_STATUS,
      BuildStatus.CLOSED,
      'build_test_status',
    )

    /*
      The legacy build carries a scope and an out-of-scope note; the new Build
      has neither field. They are folded into `specialRequirements` under their
      own labels rather than dropped — it is the one free-text field with a
      compatible meaning, and losing a project's stated scope would be a real
      loss of record. Labelled so a reader can tell what came from where.
    */
    const scope = text(row.build_scope)
    const outOfScope = text(row.build_outof_scope)
    const specialRequirements =
      [scope ? `Scope:\n${scope}` : null, outOfScope ? `Out of scope:\n${outOfScope}` : null]
        .filter(Boolean)
        .join('\n\n') || null

    const data = {
      // Legacy builds are labelled by version, not by name.
      name: requiredText(row.build_version_no ?? row.build_version_desc, `Build ${legacyId}`),
      isDefault: false,
      /*
        `build_test_status` — new / assigned / tested / closed — maps one to one
        onto BuildStatus. It used to be hardcoded CLOSED, which declared 687
        builds finished that the old platform still had open.
      */
      status: buildStatus.value,
      testType: testTypeId ? (testTypes.get(testTypeId) ?? null) : null,
      description: text(row.build_desc),
      appUrl: text(row.build_app_link),
      releaseNotes: text(row.build_release_notes),
      instructions: text(row.build_testdata),
      specialRequirements,
      targetDevices: list(row.build_devices),
      targetBrowsers: list(row.build_browsers),
      targetOperatingSystems: list(row.build_os),
      targetCountries: list(row.TestCountry),
      targetLanguages: list(row.build_languages),
      maxTesters: int(row.build_testers),
      bugCustomizationEnabled: bool(row.build_customize_bug, false),
      testersCanSeeOtherBugs: bool(row.others_bug_visibility, false),
      startDate: timestamp(row.build_start_date),
      endDate: timestamp(row.build_end_date),
      createdAt,
      updatedAt: timestamp(row.build_upd_date) ?? createdAt,
    }

    const mapped = await ctx.idMap.resolve('builds', legacyId, 'Build')
    const existing = mapped
      ? await tx.build.findUnique({ where: { id: mapped }, select: { id: true } })
      : null

    const build = existing
      ? await tx.build.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.build.create({ data: { ...data, projectId }, select: { id: true } })

    await ctx.idMap.remember(tx, 'builds', legacyId, 'Build', build.id)

    /*
      `build_feature_list` is the comma-separated list of features the build
      was to be tested against — "Login,Registration,Update Profile" — and the
      new schema models each as a Feature row on the build. Nothing read it.
      Shared by name with the features created from `bugs_report.bug_feature`,
      so a bug filed against "Login" points at the same row the build declared.
    */
    for (const featureName of list(row.build_feature_list)) {
      const already = await tx.feature.findFirst({
        where: { buildId: build.id, name: featureName },
        select: { id: true },
      })
      if (!already) {
        await tx.feature.create({
          data: { buildId: build.id, projectId, name: featureName, createdAt },
        })
      }
    }

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

  /*
    `ast_test_status_id` is an id into `test_status`, not a name — 1 Assigned,
    2 Tested, 3 Reviewed, 4 Closed, 5 invited, 6 joined. It was being handed
    straight to a name-keyed table, so every one of the 4,548 assignments
    missed and fell to the COMPLETED fallback. Resolved to its name first.
  */
  async prepare() {
    await loadLookup('test_status', 'ts_id', 'ts_name', testStatuses)
  },

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
    const statusId = legacyRef(row.ast_test_status_id)
    const status = enumValue(
      statusId ? (testStatuses.get(statusId) ?? statusId) : null,
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
    /*
      `rate` is stored as text and holds halves — "4", "3.5", "2.5" — while
      Rating.score is an Int 1-5, so it rounds rather than truncating. `int()`
      would have turned 3.5 into 3 silently.

      `rate_by` is NOT a user id. It holds the ROLE of whoever did the rating:
      "Admin" (762 rows), "Company" (76), "SubAdmin" (16). Resolving it through
      the id map returned null every time, so all 918 real ratings — with their
      feedback text — were being dropped. A role is not a person, so the rating
      is attributed to the nearest true one: the organisation's owner when the
      customer rated, otherwise the migrating admin. Recorded as a substitution
      so it is never mistaken for the original author.
    */
    const rawScore = text(row.rate)
    const scoreNumber = rawScore === null ? Number.NaN : Number(rawScore)
    const score = Number.isFinite(scoreNumber) && scoreNumber > 0 ? Math.round(scoreNumber) : null

    let authorId: string | null = null
    if (score !== null) {
      const raterRole = (text(row.rate_by) ?? '').toLowerCase()
      if (raterRole === 'company') {
        const project = await tx.project.findUnique({
          where: { id: build.projectId },
          select: { organisationId: true },
        })
        const owner = project
          ? await tx.organisationMember.findFirst({
              where: { organisationId: project.organisationId, orgRole: 'OWNER' },
              select: { userId: true },
            })
          : null
        authorId = owner?.userId ?? (await firstAdminId(ctx, tx))
      } else {
        authorId = await firstAdminId(ctx, tx)
      }

      if (authorId) {
        ctx.reporter.problem({
          legacyTable: 'assigned_tests',
          legacyId,
          targetModel: 'Rating',
          code: 'SUBSTITUTED_REFERENCE',
          field: 'rate_by',
          value: asText(row.rate_by),
          message: 'Legacy rate_by names a role, not a person; attributed to the nearest account.',
          action: 'REVIEW_REQUIRED',
        })
      }
    }

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
        /*
          Rating is unique on (author, subjectType, subject, project). Because
          the author is now a substituted account rather than the real rater,
          two assignments of the same tester to the same project collapse onto
          one key — which would abort the batch on a constraint violation. The
          first rating wins and the second is reported rather than lost
          silently.
        */
        const clash = await tx.rating.findFirst({
          where: {
            authorId,
            subjectType: 'TESTER',
            subjectUserId: testerId,
            projectId: build.projectId,
          },
          select: { id: true },
        })
        if (clash) {
          ctx.reporter.problem({
            legacyTable: 'assigned_tests',
            legacyId,
            targetModel: 'Rating',
            code: 'DUPLICATE_RATING',
            field: 'rate',
            value: asText(row.rate),
            message:
              'This tester is already rated on this project by the substituted author; second rating not migrated.',
            action: 'REVIEW_REQUIRED',
          })
        } else {
          await tx.rating.create({
            data: { ...ratingData, legacyId: ratingLegacyId, authorId },
          })
        }
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

    const buildId = await ctx.idMap.resolve('builds', legacyRef(row.build_id), 'Build')
    if (!buildId) {
      ctx.reporter.orphan({
        legacyTable: 'test_case',
        legacyId,
        field: 'build_id',
        referencedTable: 'builds',
        referencedId: asText(row.build_id),
      })
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'Test case has no migrated build.',
      }
    }

    /*
      `test_case` records no author and no timestamp — it has nine columns and
      none of them is a user or a date. So the case is attributed to an admin
      and dated from its parent build, which is the narrowest true statement
      available: this case belonged to that build, and cannot predate it.
      Stamping `now()` instead would date a 2019 test case to the migration.
    */
    const createdById = await firstAdminId(ctx, tx)
    if (!createdById) {
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'No admin to attribute the test case to.',
      }
    }

    const parent = await tx.build.findUnique({
      where: { id: buildId },
      select: { createdAt: true },
    })
    const createdAt = parent?.createdAt ?? timestampOr(null)

    /*
      `testCaseId` is the legacy human reference ("TC-014"), not a sentence —
      but it is the only per-case label the old schema carries, and the new
      TestCase.title is required. Description carries the real content.
    */
    const data = {
      title: requiredText(row.testCaseId, `Test case ${legacyId}`),
      description: requiredText(row.testCaseDesc, ''),
      steps: requiredText(row.testCaseSteps, ''),
      expectedResult: requiredText(row.expectedResult, ''),
      feature: text(row.testCaseFeature),
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

    /*
      Two columns point at the test case, and the obvious one is the worse one.
      `trep_case_id` resolves for 43,324 of the 53,014 reports; `test_case_id`,
      added later and populated on 50,507 rows, resolves for 50,467. Trying the
      better column first rescues about 7,100 reports that were being skipped
      as orphans. Both are kept: neither is a superset of the other.
    */
    const testCaseId =
      (await ctx.idMap.resolve('test_case', legacyRef(row.test_case_id), 'TestCase')) ??
      (await ctx.idMap.resolve('test_case', legacyRef(row.trep_case_id), 'TestCase'))
    const testerId = await ctx.idMap.resolve('users', legacyRef(row.trep_add_by), 'User')
    if (!testCaseId || !testerId) {
      ctx.reporter.orphan({
        legacyTable: 'test_report',
        legacyId,
        field: testCaseId ? 'trep_add_by' : 'trep_case_id',
        referencedTable: testCaseId ? 'users' : 'test_case',
        referencedId: String(testCaseId ? row.trep_add_by : row.trep_case_id),
      })
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'Report has no migrated case or tester.',
      }
    }

    const testCase = await tx.testCase.findUnique({
      where: { id: testCaseId },
      select: { buildId: true },
    })
    if (!testCase) {
      return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'Test case vanished mid-run.' }
    }

    const result = enumValue(row.trep_result, TEST_CASE_RESULT, 'NOT_TESTED', 'trep_result')

    /*
      `trep_defect_id` is what makes a bug the OUTCOME of executing a test case
      rather than a free-floating report — the single most load-bearing column
      in the legacy testing workflow. Bugs migrate in phase 5, after this, so
      the link is resolved by `linkTestReportsToBugs` once both sides exist.
    */
    const createdAt = timestampOr(row.trep_add_date)
    const data = {
      result: result.value,
      // `trep_desc` is the tester's write-up; `trep_steps` is what they did to
      // get there. Both are free text and the new schema has one notes field,
      // so they are joined rather than one being dropped.
      notes: [text(row.trep_desc), text(row.trep_steps)].filter(Boolean).join('\n\n') || null,
      devices: text(row.test_devices),
      browsers: text(row.test_browsers),
      createdAt,
      updatedAt: timestampOr(row.trep_upd_date ?? row.trep_add_date),
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
        referencedId: asText(row.rvw_build_id),
      })
      return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'Review has no migrated build.' }
    }

    const createdById =
      (await ctx.idMap.resolve('users', legacyRef(row.rvw_add_by), 'User')) ??
      (await firstAdminId(ctx, tx))
    if (!createdById) {
      return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'No author for the review.' }
    }

    const createdAt = timestampOr(row.rvw_add_date)
    const data = {
      // `rvw_summary` is the headline, `rvw_desc` the body. Summary is
      // required here, so the body stands in when the headline is blank.
      summary: requiredText(row.rvw_summary ?? row.rvw_desc, `Legacy review ${legacyId}`),
      rating: int(row.rvw_val),
      createdAt,
    }

    const mapped = await ctx.idMap.resolve('test_review', legacyId, 'TestReview')
    const existing = mapped
      ? await tx.testReview.findUnique({ where: { id: mapped }, select: { id: true } })
      : null

    const review = existing
      ? await tx.testReview.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.testReview.create({
          data: { ...data, buildId, createdById },
          select: { id: true },
        })

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

    /*
      One row here is not one assignment. `case_id` and `tester_id` are both
      comma-separated LISTS — a single row reads

        case_id  = "1559,1560, … ,1679"   (121 cases)
        tester_id = "600,690,1051"        (3 testers)

      and means every one of those testers was given every one of those cases.
      Read as scalars, `legacyRef` returns the whole string, nothing resolves,
      and only a row that happened to hold exactly one of each ever produced an
      assignment — one, out of 657 rows. So the row fans out to the cross
      product, which is what the old platform meant by it.

      A pair whose case or tester did not migrate is skipped individually
      rather than costing the whole row.
    */
    const caseIds = list(row.case_id)
    const testerIds = list(row.tester_id ?? row.user_id)
    if (caseIds.length === 0 || testerIds.length === 0) {
      ctx.reporter.orphan({
        legacyTable: 'assign_testCase',
        legacyId,
        field: caseIds.length ? 'tester_id' : 'case_id',
        referencedTable: caseIds.length ? 'users' : 'test_case',
        referencedId: asText(caseIds.length ? row.tester_id : row.case_id),
      })
      return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'Missing test case or tester.' }
    }

    const resolvedTesters: string[] = []
    for (const legacyTester of testerIds) {
      const id = await ctx.idMap.resolve('users', legacyTester, 'User')
      if (id) resolvedTesters.push(id)
      else
        ctx.reporter.orphan({
          legacyTable: 'assign_testCase',
          legacyId,
          field: 'tester_id',
          referencedTable: 'users',
          referencedId: legacyTester,
        })
    }

    let created = 0
    let matched = 0
    for (const legacyCase of caseIds) {
      const testCaseId = await ctx.idMap.resolve('test_case', legacyCase, 'TestCase')
      if (!testCaseId) {
        ctx.reporter.orphan({
          legacyTable: 'assign_testCase',
          legacyId,
          field: 'case_id',
          referencedTable: 'test_case',
          referencedId: legacyCase,
        })
        continue
      }

      /*
        `assign_testCase` is a bare join table — Sno, case_id, tester_id,
        build_id — with no date at all. The assignment is dated from the test
        case it points at rather than from `now()`, so a 2019 assignment does
        not arrive stamped with the migration's own clock.
      */
      const assignedCase = await tx.testCase.findUnique({
        where: { id: testCaseId },
        select: { createdAt: true },
      })

      for (const testerId of resolvedTesters) {
        const existing = await tx.testCaseAssignment.findUnique({
          where: { testCaseId_testerId: { testCaseId, testerId } },
          select: { id: true },
        })
        if (existing) {
          matched += 1
          continue
        }
        await tx.testCaseAssignment.create({
          data: { testCaseId, testerId, assignedAt: assignedCase?.createdAt ?? timestampOr(null) },
        })
        created += 1
      }
    }

    if (created === 0 && matched === 0) {
      return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'Missing test case or tester.' }
    }

    return { kind: 'written', created: created > 0 }
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
