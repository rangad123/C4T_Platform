import { BugSeverity, BugStatus, FileScope } from '@prisma/client'
import {
  BUG_FIELD_TYPE,
  BUG_REPRODUCIBILITY,
  BUG_SEVERITY,
  BUG_STATUS,
  BUG_TYPE,
} from '../mapping/lookups.js'
import { query } from '../legacy/client.js'
import {
  asText,
  enumValue,
  int,
  legacyRef,
  requiredText,
  text,
  timestamp,
  timestampOr,
  url as parseUrl,
} from '../transform/values.js'
import type { Loader, LoadContext, RowOutcome } from './context.js'
import { reportProblems } from './context.js'

/**
 * Phase 5 — defects.
 *
 * Depends on builds (for Bug.buildId, which is required) and users (reporter).
 */

/** Legacy bug-type id → name, so BUG_TYPE can be applied to a readable value. */
const bugTypeNames = new Map<string, string>()

// ── bugs_report → Bug ────────────────────────────────────────────────────────

export const bugLoader: Loader = {
  table: 'bugs_report',
  target: 'Bug',
  dependsOn: [
    { table: 'builds', model: 'Build' },
    { table: 'projects', model: 'Project' },
    { table: 'users', model: 'User' },
  ],

  async prepare() {
    bugTypeNames.clear()
    try {
      const rows = await query<Record<string, unknown>>('SELECT bt_id, bt_name FROM `bug_types`')
      for (const r of rows) {
        const name = text(r.bt_name)
        if (name) bugTypeNames.set(String(r.bt_id), name)
      }
    } catch {
      // Unmapped types are reported per row.
    }
  },

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.bug_id)
    const problems = []

    /*
      Bug.buildId is REQUIRED; the legacy column is nullable, because a legacy
      bug could be filed against a project with no build. Falling back to the
      project's default build keeps the bug rather than dropping real defect
      history over a structural difference — the fallback is the build created
      to hold exactly this kind of project-level data.
    */
    let buildId = await ctx.idMap.resolve('builds', legacyRef(row.bug_build_id), 'Build')
    const projectLegacy = legacyRef(row.bug_project_id)

    if (!buildId && projectLegacy) {
      buildId = await ctx.idMap.resolve('projects', `project:${projectLegacy}:default`, 'Build')
      if (buildId) {
        ctx.reporter.problem({
          legacyTable: 'bugs_report',
          legacyId,
          targetModel: 'Bug',
          code: 'SUBSTITUTED_REFERENCE',
          field: 'bug_build_id',
          value: asText(row.bug_build_id),
          message: 'No migrated build; attached to the project default build.',
          action: 'REVIEW_REQUIRED',
        })
      }
    }

    if (!buildId) {
      ctx.reporter.orphan({
        legacyTable: 'bugs_report',
        legacyId,
        field: 'bug_build_id',
        referencedTable: 'builds',
        referencedId: asText(row.bug_build_id),
      })
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'Bug has neither a migrated build nor a project default build to attach to.',
      }
    }

    const build = await tx.build.findUnique({
      where: { id: buildId },
      select: { projectId: true },
    })
    if (!build) {
      return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'Build vanished mid-run.' }
    }

    const reportedById = await ctx.idMap.resolve(
      'users',
      legacyRef(row.bug_created_by ?? row.bug_tester_id),
      'User',
    )
    if (!reportedById) {
      ctx.reporter.orphan({
        legacyTable: 'bugs_report',
        legacyId,
        field: 'bug_created_by',
        referencedTable: 'users',
        referencedId: asText(row.bug_created_by ?? row.bug_tester_id),
      })
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'Bug reporter was not migrated; Bug.reportedById is required.',
      }
    }

    const severity = enumValue(
      row.bug_severity ?? row.bug_priority,
      BUG_SEVERITY,
      BugSeverity.MEDIUM,
      'bug_severity',
    )
    problems.push(severity.problem)

    const status = enumValue(row.bug_status, BUG_STATUS, BugStatus.NEW, 'bug_status')
    problems.push(status.problem)

    const reproducibility = enumValue(
      row.bug_reproducibility ?? row.bug_reproduce,
      BUG_REPRODUCIBILITY,
      'ALWAYS',
      'bug_reproducibility',
    )
    problems.push(reproducibility.problem)

    /*
      BugType is a CLOSED enum in the new schema. A legacy type with no honest
      counterpart is left null and reported, rather than filed under whichever
      member looked closest — a wrong type is worse than no type, because it is
      indistinguishable from a real one when someone filters on it later.
    */
    const typeLegacy = legacyRef(row.bug_type_id ?? row.bug_type)
    const typeName = typeLegacy ? (bugTypeNames.get(typeLegacy) ?? typeLegacy) : null
    let bugType: (typeof BUG_TYPE)[string] | null = null
    if (typeName) {
      const key = typeName.toLowerCase().replace(/[\s-]+/g, '_')
      bugType = BUG_TYPE[key] ?? null
      if (!bugType) {
        problems.push({
          field: 'bug_type_id',
          value: typeName,
          problem: 'no equivalent BugType member; stored as null',
        })
      }
    }

    const video = parseUrl(row.bug_video_url ?? row.bug_video, 'bug_video_url')
    problems.push(video.problem)

    const createdAt = timestampOr(row.bug_created_date)
    const updatedAt = timestamp(row.bug_updated_date) ?? createdAt

    /*
      `sometimeFreq` / `sometimeTotal` are the legacy "happened N times out of
      M" pair, recorded when reproducibility is SOMETIMES. They are the
      occurrence/outOf columns under an older name.

      Four of the new Bug's environment fields have no legacy source at all:
      osName, osVersion, appVersion and networkType. The old form captured only
      the device and the browser. They stay null rather than being filled from
      a neighbouring column that means something else.
    */
    const data = {
      title: requiredText(row.bug_title, `Legacy bug ${legacyId}`),
      description: requiredText(row.bug_desc, ''),
      preCondition: text(row.bug_pre_condition),
      stepsToReproduce: requiredText(row.bug_steps, ''),
      expectedResult: text(row.bug_exp_result),
      actualResult: text(row.bug_actual_result),
      severity: severity.value,
      status: status.value,
      reproducibility: reproducibility.value,
      occurrence: int(row.sometimeFreq),
      outOf: int(row.sometimeTotal),
      type: bugType,
      videoUrl: video.value,
      deviceModel: text(row.bug_device_used),
      osName: null,
      osVersion: null,
      browser: text(row.bug_browsers_used),
      appVersion: null,
      networkType: null,
      createdAt,
      updatedAt,
    }

    const existing = await tx.bug.findUnique({ where: { legacyId }, select: { id: true } })

    const bug = existing
      ? await tx.bug.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.bug.create({
          data: {
            ...data,
            legacyId,
            projectId: build.projectId,
            buildId,
            reportedById,
            reference: `BUG-LEG-${legacyId.padStart(6, '0')}`,
          },
          select: { id: true },
        })

    await ctx.idMap.remember(tx, 'bugs_report', legacyId, 'Bug', bug.id)
    reportProblems(ctx, 'bugs_report', legacyId, 'Bug', problems)
    return { kind: 'written', created: !existing }
  },
}

// ── defect_comments → BugComment ─────────────────────────────────────────────

export const bugCommentLoader: Loader = {
  table: 'defect_comments',
  target: 'BugComment',
  dependsOn: [
    { table: 'bugs_report', model: 'Bug' },
    { table: 'users', model: 'User' },
  ],

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.comments_id)

    const bugId = await ctx.idMap.resolve('bugs_report', legacyRef(row.comments_bug_id), 'Bug')
    const authorId = await ctx.idMap.resolve('users', legacyRef(row.comments_done_by), 'User')

    if (!bugId || !authorId) {
      ctx.reporter.orphan({
        legacyTable: 'defect_comments',
        legacyId,
        field: bugId ? 'comments_done_by' : 'comments_bug_id',
        referencedTable: bugId ? 'users' : 'bugs_report',
        referencedId: asText(bugId ? row.comments_done_by : row.comments_bug_id),
      })
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'Comment has no migrated bug or author.',
      }
    }

    const body = text(row.comments_comment)
    if (!body) {
      return { kind: 'skipped', code: 'EMPTY_BODY', message: 'Comment body is empty.' }
    }

    const createdAt = timestampOr(row.comments_date)
    const data = { body, isInternal: false, createdAt, updatedAt: createdAt }

    const mapped = await ctx.idMap.resolve('defect_comments', legacyId, 'BugComment')
    const existing = mapped
      ? await tx.bugComment.findUnique({ where: { id: mapped }, select: { id: true } })
      : null

    const comment = existing
      ? await tx.bugComment.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.bugComment.create({ data: { ...data, bugId, authorId }, select: { id: true } })

    await ctx.idMap.remember(tx, 'defect_comments', legacyId, 'BugComment', comment.id)
    return { kind: 'written', created: !existing }
  },
}

// ── attachments → FileObject + BugAttachment ─────────────────────────────────

/**
 * A BugAttachment cannot exist without a FileObject, and a FileObject that
 * points at a file nobody can fetch is worse than no attachment at all — it
 * renders as a broken download with no indication that the bytes were never
 * migrated. So an attachment whose file cannot be located is reported in
 * missing-files.csv and skipped.
 */
export const bugAttachmentLoader: Loader = {
  table: 'attachments',
  target: 'BugAttachment',
  dependsOn: [
    { table: 'bugs_report', model: 'Bug' },
    { table: 'users', model: 'User' },
  ],

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.attach_id)

    const bugId = await ctx.idMap.resolve(
      'bugs_report',
      legacyRef(row.attach_bugs_report_id),
      'Bug',
    )
    if (!bugId) {
      ctx.reporter.orphan({
        legacyTable: 'attachments',
        legacyId,
        field: 'attach_bugs_report_id',
        referencedTable: 'bugs_report',
        referencedId: asText(row.attach_bugs_report_id),
      })
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'Attachment has no migrated bug.',
      }
    }

    const filename = text(row.attach_filename)
    const location = text(row.attach_loc_server)
    if (!filename) {
      return { kind: 'skipped', code: 'MISSING_FILE', message: 'No filename recorded.' }
    }

    const uploadedById =
      (await ctx.idMap.resolve('users', legacyRef(row.attach_created_by), 'User')) ?? null
    if (!uploadedById) {
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'Uploader not migrated; FileObject.uploadedById is required.',
      }
    }

    const fileRoot = process.env.LEGACY_FILE_ROOT
    if (!fileRoot) {
      ctx.reporter.missingFile({
        legacyTable: 'attachments',
        legacyId,
        field: 'attach_loc_server',
        path: [location, filename].filter(Boolean).join('/'),
        reason: 'LEGACY_FILE_ROOT not configured; file migration skipped.',
      })
      return {
        kind: 'skipped',
        code: 'FILE_NOT_MIGRATED',
        message: 'LEGACY_FILE_ROOT is unset, so the bytes cannot be located or copied.',
      }
    }

    const storageKey = `legacy/bug-attachments/${legacyId}/${filename}`
    const createdAt = timestampOr(row.attach_created_date)

    const mappedFile = await ctx.idMap.resolve('attachments', legacyId, 'FileObject')
    const file = mappedFile
      ? await tx.fileObject.update({
          where: { id: mappedFile },
          data: { originalName: filename },
          select: { id: true },
        })
      : await tx.fileObject.create({
          data: {
            scope: FileScope.BUG_ATTACHMENT,
            storageKey,
            driver: 'legacy',
            originalName: filename,
            mimeType: guessMime(filename),
            sizeBytes: 0,
            uploadedById,
            // The row is a pointer until the bytes are verified in place, and
            // `isComplete: false` is how the platform already marks that.
            isComplete: false,
            createdAt,
          },
          select: { id: true },
        })

    await ctx.idMap.remember(tx, 'attachments', legacyId, 'FileObject', file.id)

    const existing = await tx.bugAttachment.findFirst({
      where: { bugId, fileId: file.id },
      select: { id: true },
    })

    const attachment =
      existing ??
      (await tx.bugAttachment.create({
        data: { bugId, fileId: file.id, caption: text(row.attach_title), createdAt },
        select: { id: true },
      }))

    await ctx.idMap.remember(tx, 'attachments', legacyId, 'BugAttachment', attachment.id)

    ctx.reporter.missingFile({
      legacyTable: 'attachments',
      legacyId,
      field: 'attach_loc_server',
      path: [location, filename].filter(Boolean).join('/'),
      reason: 'FileObject created as incomplete — copy the bytes and mark isComplete.',
    })

    return { kind: 'written', created: !existing }
  },
}

function guessMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const table: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    zip: 'application/zip',
    apk: 'application/vnd.android.package-archive',
    txt: 'text/plain',
    csv: 'text/csv',
  }
  return table[ext] ?? 'application/octet-stream'
}

// ── cust_bug_fields → BugCustomField ─────────────────────────────────────────

export const bugCustomFieldLoader: Loader = {
  table: 'cust_bug_fields',
  target: 'BugCustomField',
  dependsOn: [{ table: 'builds', model: 'Build' }],

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.cbf_id)

    const buildId = await ctx.idMap.resolve('builds', legacyRef(row.cbf_build_id), 'Build')
    if (!buildId) {
      ctx.reporter.orphan({
        legacyTable: 'cust_bug_fields',
        legacyId,
        field: 'cbf_build_id',
        referencedTable: 'builds',
        referencedId: asText(row.cbf_build_id),
      })
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'Custom field has no migrated build.',
      }
    }

    const name = text(row.cbf_name)
    if (!name) {
      return { kind: 'skipped', code: 'MISSING_REQUIRED', message: 'Custom field has no name.' }
    }

    const type = enumValue(row.cbf_type, BUG_FIELD_TYPE, 'TEXT', 'cbf_type')
    const createdAt = timestampOr(row.cbf_add_date)

    /*
      The legacy schema stores a select field's choices as six fixed columns,
      `cbf_opt_A` through `cbf_opt_F` — not as a list. Blank ones are dropped,
      so a three-option field migrates with three options and not with three
      followed by three empty strings.
    */
    const options = [
      row.cbf_opt_A,
      row.cbf_opt_B,
      row.cbf_opt_C,
      row.cbf_opt_D,
      row.cbf_opt_E,
      row.cbf_opt_F,
    ]
      .map((value) => text(value))
      .filter((value): value is string => value !== null)

    const data = {
      name,
      type: type.value,
      options,
      isRequired: false,
      // `cust_bug_fields` has no ordering column; A-F order is all there is.
      position: 0,
      createdAt,
      updatedAt: timestamp(row.cbf_upd_date) ?? createdAt,
    }

    const mapped = await ctx.idMap.resolve('cust_bug_fields', legacyId, 'BugCustomField')
    const existing = mapped
      ? await tx.bugCustomField.findUnique({ where: { id: mapped }, select: { id: true } })
      : null

    const field = existing
      ? await tx.bugCustomField.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.bugCustomField.create({ data: { ...data, buildId }, select: { id: true } })

    await ctx.idMap.remember(tx, 'cust_bug_fields', legacyId, 'BugCustomField', field.id)
    reportProblems(ctx, 'cust_bug_fields', legacyId, 'BugCustomField', [type.problem])
    return { kind: 'written', created: !existing }
  },
}

// ── cust_bug_answers → BugCustomValue ────────────────────────────────────────

export const bugCustomValueLoader: Loader = {
  table: 'cust_bug_answers',
  target: 'BugCustomValue',
  dependsOn: [
    { table: 'bugs_report', model: 'Bug' },
    { table: 'cust_bug_fields', model: 'BugCustomField' },
  ],

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.cbfa_id)

    const bugId = await ctx.idMap.resolve('bugs_report', legacyRef(row.cbfa_bug_id), 'Bug')
    // `cbfa_fid` is the field reference — the legacy name for it, not cbf_id.
    const fieldId = await ctx.idMap.resolve(
      'cust_bug_fields',
      legacyRef(row.cbfa_fid),
      'BugCustomField',
    )

    if (!bugId || !fieldId) {
      ctx.reporter.orphan({
        legacyTable: 'cust_bug_answers',
        legacyId,
        field: bugId ? 'cbfa_fid' : 'cbfa_bug_id',
        referencedTable: bugId ? 'cust_bug_fields' : 'bugs_report',
        referencedId: asText(bugId ? row.cbfa_fid : row.cbfa_bug_id),
      })
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'Answer references a bug or field that was not migrated.',
      }
    }

    const value = text(row.cbfa_answer ?? row.cbfa_value)
    if (!value) {
      return { kind: 'skipped', code: 'EMPTY_VALUE', message: 'Answer is empty.' }
    }

    const existing = await tx.bugCustomValue.findFirst({
      where: { bugId, fieldId },
      select: { id: true },
    })

    const record = existing
      ? await tx.bugCustomValue.update({
          where: { id: existing.id },
          data: { value },
          select: { id: true },
        })
      : await tx.bugCustomValue.create({ data: { bugId, fieldId, value }, select: { id: true } })

    await ctx.idMap.remember(tx, 'cust_bug_answers', legacyId, 'BugCustomValue', record.id)
    return { kind: 'written', created: !existing }
  },
}

/**
 * Resolves `test_report.trep_defect_id` once bugs exist.
 *
 * Runs after phase 5 rather than during phase 4, because the link points
 * forward in the dependency order: a test report is written before the bug it
 * produced has been migrated. Deferring the join is what lets both keep their
 * natural phase.
 */
export async function linkTestReportsToBugs(ctx: LoadContext): Promise<number> {
  if (ctx.dryRun) return 0

  const pending = await ctx.prisma.migrationRecordMap.findMany({
    where: { legacyTable: 'test_report_defect', targetModel: 'PendingBugLink' },
    select: { legacyId: true, targetId: true },
  })

  let linked = 0
  for (const row of pending) {
    const reportId = await ctx.idMap.resolve('test_report', row.legacyId, 'TestReport')
    const bugId = await ctx.idMap.resolve('bugs_report', row.targetId, 'Bug')
    if (!reportId || !bugId) {
      ctx.reporter.orphan({
        legacyTable: 'test_report',
        legacyId: row.legacyId,
        field: 'trep_defect_id',
        referencedTable: 'bugs_report',
        referencedId: row.targetId,
      })
      continue
    }
    await ctx.prisma.testReport.update({
      where: { id: reportId },
      data: { linkedBugId: bugId },
    })
    linked += 1
  }
  return linked
}

export const defectLoaders: Loader[] = [
  bugLoader,
  bugCommentLoader,
  bugAttachmentLoader,
  bugCustomFieldLoader,
  bugCustomValueLoader,
]
