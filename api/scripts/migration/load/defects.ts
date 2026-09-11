import { BugSeverity, BugStatus, FileScope } from '@prisma/client'
import type { Prisma } from '@prisma/client'
import {
  BUG_FIELD_TYPE,
  BUG_REPRODUCIBILITY,
  BUG_SEVERITY,
  BUG_STATUS_BY_LEGACY_ID,
  BUG_TYPE,
} from '../mapping/lookups.js'
import { query } from '../legacy/client.js'
import { loadLegacyLabels, type LegacyLabels } from '../mapping/legacy-labels.js'
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
import { recordLegacyFile, reportProblems } from './context.js'

/**
 * Phase 5 — defects.
 *
 * Depends on builds (for Bug.buildId, which is required) and users (reporter).
 */

/** Legacy bug-type id → name, so BUG_TYPE can be applied to a readable value. */
const bugTypeNames = new Map<string, string>()

/** Device and browser labels for this run — see `mapping/legacy-labels.ts`. */
let labels: LegacyLabels | null = null

/**
 * A title for a bug that was never given one.
 *
 * `bug_title` is empty on 21,214 of the 21,768 legacy bugs — the old platform
 * did not require it, and the reporter put the whole defect in `bug_desc`.
 * Falling back to "Legacy bug 22857" left 97% of the platform's bug list
 * unreadable: every row identical except a number, with the actual content one
 * click away.
 *
 * The first line of the description is used instead. That invents nothing — it
 * is the bug's own words, and the description is still stored in full — and it
 * is what a person skimming the list needs to see. 21,753 bugs have a
 * description; the 14 with neither keep the numbered fallback.
 */
function titleFromDescription(description: string | null): string | null {
  if (!description) return null
  const firstLine = (description.split(/[\r\n]/)[0] ?? '').replace(/\s+/g, ' ').trim()
  if (!firstLine) return null
  if (firstLine.length <= 110) return firstLine

  // Cut on a word boundary so a title does not end mid-word.
  const cut = firstLine.slice(0, 110)
  const lastSpace = cut.lastIndexOf(' ')
  return `${lastSpace > 60 ? cut.slice(0, lastSpace) : cut}…`
}

interface InlineFile {
  field: string
  filename: string | null
}

interface InlineAttachmentArgs {
  legacyTable: string
  legacyId: string
  bugId: string
  uploadedById: string
  createdAt: Date
  files: InlineFile[]
}

/**
 * Attaches files that the legacy schema stored as bare filenames on the row
 * itself rather than in a join table.
 *
 * The filenames carry no directory — "1434206420Screenshot_2015-06-13.png" —
 * because the old PHP knew the upload root and the database never recorded it.
 * So without `LEGACY_FILE_ROOT` there is nothing to point a FileObject at, and
 * inventing a storage key for bytes nobody has located would create rows that
 * look like attachments and resolve to nothing. They are reported to
 * `missing-files.csv` instead, which is the manifest the file-copying job
 * needs and, until now, was empty.
 *
 * With the root configured the FileObject is written `isComplete: false`,
 * exactly as the table-driven attachment loader does — the row is a pointer
 * until the bytes are verified in place.
 */
async function attachInlineFiles(
  ctx: LoadContext,
  tx: Prisma.TransactionClient,
  args: InlineAttachmentArgs,
): Promise<void> {
  for (const entry of args.files) {
    const fileId = await recordLegacyFile(ctx, tx, {
      legacyTable: args.legacyTable,
      legacyId: args.legacyId,
      field: entry.field,
      filename: entry.filename,
      scope: FileScope.BUG_ATTACHMENT,
      keyPrefix: 'bug-attachments',
      uploadedById: args.uploadedById,
      createdAt: args.createdAt,
    })
    if (!fileId) continue

    const already = await tx.bugAttachment.findFirst({
      where: { bugId: args.bugId, fileId },
      select: { id: true },
    })
    if (!already) {
      await tx.bugAttachment.create({
        data: { bugId: args.bugId, fileId, createdAt: args.createdAt },
      })
    }
  }
}

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
      const rows = await query<Record<string, unknown>>('SELECT bt_id, bt_title FROM `bug_types`')
      for (const r of rows) {
        const name = text(r.bt_title)
        if (name) bugTypeNames.set(String(r.bt_id), name)
      }
    } catch {
      // Unmapped types are reported per row.
    }

    /*
      `bug_device_used` and `bug_browsers_used` are ids, not text — see
      `mapping/legacy-labels.ts`. Read once for the whole run.
    */
    try {
      labels = await loadLegacyLabels()
    } catch {
      // Without them the two fields stay null, which is better than a number.
      labels = null
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

    /*
      `bug_status` is an integer, not a name — see BUG_STATUS_BY_LEGACY_ID for
      how the codes were recovered from the transition comments the old
      application left on every bug.
    */
    const status = enumValue(row.bug_status, BUG_STATUS_BY_LEGACY_ID, BugStatus.NEW, 'bug_status')
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

      Two columns describe a bug's kind, and the useful one is not the foreign
      key. `bug_type_id` points at `bug_types`, which holds exactly two rows —
      "Defect" and "Crash" — and neither "Defect" nor null says anything worth
      migrating for the 12,939 bugs carrying id 1. `bug_typeofdefect` is free
      text and far richer: Functionality, UI, Usability, localisation, UX,
      compatibility, performance, crash. It is preferred, with the foreign key
      as the fallback.

      localisation and compatibility still have no BugType member and are left
      null and reported.
    */
    const typeLegacy = legacyRef(row.bug_type_id)
    const typeName =
      text(row.bug_typeofdefect) ??
      (typeLegacy ? (bugTypeNames.get(typeLegacy) ?? typeLegacy) : null)
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

      The old form captured a device and a browser, and stored both as ids —
      into `devices` and `user_browsers` respectively. Read as text they became
      the literal strings "588" and "512" on every bug that had them, which is
      what `mapping/legacy-labels.ts` exists to resolve.

      `osName` comes from the browser's own row, the only place a legacy bug's
      OS survives. `osVersion`, `appVersion` and `networkType` genuinely have
      no legacy source and stay null rather than borrowing a neighbouring
      column that means something else.
    */
    const browserUsed = labels?.browsers.get(String(text(row.bug_browsers_used))) ?? null

    const data = {
      // The code the old platform showed for this bug, kept so that searching
      // for "CR_CONF001" still finds it. Not unique — see the schema.
      legacyReference: text(row.bug_defect_id),
      title:
        text(row.bug_title) ?? titleFromDescription(text(row.bug_desc)) ?? `Legacy bug ${legacyId}`,
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
      deviceModel: labels?.devices.get(String(text(row.bug_device_used))) ?? null,
      /*
        Recovered from the browser, not invented: `user_browsers.os_id` names
        the OS the tester registered that browser on, and `bugs_report` has no
        OS column of its own.
      */
      osName: browserUsed?.osName ?? null,
      osVersion: null,
      browser: browserUsed?.label ?? null,
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

    /*
      `bug_feature` names the area of the product the defect was found in, on
      7,869 bugs, and the new schema models exactly that as `Feature` hanging
      off the build. Features are created on demand and shared by name within
      a build, so twenty bugs against "Checkout" point at one Feature row.
    */
    const featureName = text(row.bug_feature)
    if (featureName) {
      const feature =
        (await tx.feature.findFirst({
          where: { buildId, name: featureName },
          select: { id: true },
        })) ??
        (await tx.feature.create({
          data: { buildId, projectId: build.projectId, name: featureName, createdAt },
          select: { id: true },
        }))
      await tx.bug.update({ where: { id: bug.id }, data: { featureId: feature.id } })
    }

    /*
      The `attachments` table is EMPTY — all 66 tables were checked and it has
      no rows. Every bug attachment the old platform ever took is held inline
      instead, in three columns: bug_screen1 (13,945 rows), bug_screen2 (1,937)
      and bug_attachment (386). Reading only the empty table meant BugAttachment
      received nothing and `missing-files.csv` reported zero unresolved files,
      which was not true of a platform with ~16,000 of them.
    */
    await attachInlineFiles(ctx, tx, {
      legacyTable: 'bugs_report',
      legacyId,
      bugId: bug.id,
      uploadedById: reportedById,
      createdAt,
      files: [
        { field: 'bug_screen1', filename: text(row.bug_screen1) },
        { field: 'bug_screen2', filename: text(row.bug_screen2) },
        { field: 'bug_attachment', filename: text(row.bug_attachment) },
      ],
    })
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

    // Comment attachments are inline too — comments_attach1 (1,405 rows) and
    // comments_attach2 (244). They belong to the bug the comment is on.
    await attachInlineFiles(ctx, tx, {
      legacyTable: 'defect_comments',
      legacyId,
      bugId,
      uploadedById: authorId,
      createdAt,
      files: [
        { field: 'comments_attach1', filename: text(row.comments_attach1) },
        { field: 'comments_attach2', filename: text(row.comments_attach2) },
      ],
    })
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
