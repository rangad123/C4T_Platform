import { type Prisma, BugStatus, type BugSeverity, OrgMemberRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError, ForbiddenError, BadRequestError, ConflictError } from '../../lib/errors.js'
import { buildMeta, buildOrderBy, toSkipTake } from '../../lib/pagination.js'
import { bugScope } from '../../lib/access/scopes.js'
import { bugRelations, projectRelations, type RelationSet } from '../../lib/access/relations.js'
import {
  authorize,
  can,
  bugActors,
  allowedTransitions,
  canTransition,
  canReporterDelete,
  canReporterEdit,
} from '../../lib/access/policy.js'
import { nextReference } from '../../lib/reference.js'
import { createNotification, createNotifications } from '../notifications/notifications.service.js'
import { refreshTesterAggregates } from '../testers/testers.service.js'
import { createDownloadUrl } from '../../lib/storage.js'
import { resolveBuildId } from '../projects/projects.service.js'
import { BUG_SORT_FIELDS, type ListBugsQuery } from './bugs.schema.js'

const bugSelect = {
  id: true,
  reference: true,
  title: true,
  description: true,
  stepsToReproduce: true,
  expectedResult: true,
  actualResult: true,
  severity: true,
  status: true,
  reproducibility: true,
  type: true,
  featureId: true,
  feature: { select: { id: true, name: true } },
  deviceModel: true,
  osName: true,
  osVersion: true,
  browser: true,
  appVersion: true,
  networkType: true,
  duplicateOfId: true,
  triagedAt: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
  project: { select: { id: true, reference: true, title: true, organisationId: true } },
  reportedBy: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      testerProfile: { select: { countryCode: true } },
    },
  },
  _count: { select: { attachments: true, comments: true } },
} satisfies Prisma.BugSelect

/** True when the only thing granting access is having reported it. */
function isReporterOnly(relations: RelationSet): boolean {
  return (
    relations.has('bug:reporter') &&
    !relations.has('platform:admin') &&
    !relations.has('platform:subadmin') &&
    !relations.has('project:manager')
  )
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function listBugs(user: Express.AuthenticatedUser, query: ListBugsQuery) {
  const where: Prisma.BugWhereInput = {
    deletedAt: null,
    ...bugScope(user),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.buildId ? { buildId: query.buildId } : {}),
    ...(query.buildIds?.length ? { buildId: { in: query.buildIds } } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.severity ? { severity: query.severity } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.featureId ? { featureId: query.featureId } : {}),
    ...(query.reportedById ? { reportedById: query.reportedById } : {}),
    ...(query.startDate || query.endDate
      ? {
          createdAt: {
            ...(query.startDate ? { gte: query.startDate } : {}),
            ...(query.endDate ? { lte: query.endDate } : {}),
          },
        }
      : {}),
    ...(query.search
      ? {
          OR: [
            { title: { contains: query.search, mode: 'insensitive' } },
            { reference: { contains: query.search, mode: 'insensitive' } },
            { description: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    prisma.bug.findMany({
      where,
      select: bugSelect,
      orderBy: buildOrderBy(query.sort, query.order, BUG_SORT_FIELDS, 'createdAt'),
      ...toSkipTake(query),
    }),
    prisma.bug.count({ where }),
  ])

  return { items, meta: buildMeta(query, total) }
}

/**
 * CSV export of the same row set the list endpoint returns, minus pagination.
 * Reuses the exact `where` clause from `listBugs` so the access scope, filters,
 * and search term are identical — exporting never bypasses RBAC.
 *
 * Columns are picked to be useful in a spreadsheet — the descriptive ones from
 * `bugSelect` plus a synthesised "Reporter" name rather than the raw id. The
 * original nested `id`s are kept as separate columns so downstream joins still
 * work.
 */
export async function exportBugsCSV(
  user: Express.AuthenticatedUser,
  query: ListBugsQuery,
): Promise<string> {
  const where: Prisma.BugWhereInput = {
    deletedAt: null,
    ...bugScope(user),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.buildId ? { buildId: query.buildId } : {}),
    ...(query.buildIds?.length ? { buildId: { in: query.buildIds } } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.severity ? { severity: query.severity } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.featureId ? { featureId: query.featureId } : {}),
    ...(query.reportedById ? { reportedById: query.reportedById } : {}),
    ...(query.startDate || query.endDate
      ? {
          createdAt: {
            ...(query.startDate ? { gte: query.startDate } : {}),
            ...(query.endDate ? { lte: query.endDate } : {}),
          },
        }
      : {}),
    ...(query.search
      ? {
          OR: [
            { title: { contains: query.search, mode: 'insensitive' } },
            { reference: { contains: query.search, mode: 'insensitive' } },
            { description: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const items = await prisma.bug.findMany({
    where,
    select: bugSelect,
    orderBy: buildOrderBy(query.sort, query.order, BUG_SORT_FIELDS, 'createdAt'),
  })

  const rows = items.map((b) => [
    b.reference,
    b.title,
    b.severity,
    b.status,
    b.type ?? '',
    b.feature?.name ?? '',
    b.project?.reference ?? '',
    b.project?.title ?? '',
    [
      b.reportedBy?.firstName,
      b.reportedBy?.lastName,
    ]
      .filter(Boolean)
      .join(' '),
    b.reportedBy?.email ?? '',
    b.reportedBy?.testerProfile?.countryCode ?? '',
    b.deviceModel ?? '',
    b.osName ?? '',
    b.osVersion ?? '',
    b.browser ?? '',
    b.appVersion ?? '',
    b.networkType ?? '',
    b.reproducibility,
    b._count.attachments,
    b._count.comments,
    b.triagedAt,
    b.resolvedAt,
    b.createdAt,
    b.updatedAt,
  ])

  const { toCsv } = await import('../../lib/csv.js')
  return toCsv(
    [
      'Reference',
      'Title',
      'Severity',
      'Status',
      'Type',
      'Feature',
      'Project reference',
      'Project title',
      'Reporter',
      'Reporter email',
      'Reporter country',
      'Device',
      'OS',
      'OS version',
      'Browser',
      'App version',
      'Network',
      'Reproducibility',
      'Attachments',
      'Comments',
      'Triaged at',
      'Resolved at',
      'Created at',
      'Updated at',
    ],
    rows,
  )
}

export async function getBug(user: Express.AuthenticatedUser, id: string) {
  const resolved = await bugRelations(user, id)
  if (!resolved) throw new NotFoundError('Bug')

  const { relations } = resolved
  // 404 rather than 403 — a 403 would confirm the bug exists.
  if (!can(user, 'bug.read', relations)) throw new NotFoundError('Bug')

  const seesInternal = can(user, 'bug.comment_internal', relations)

  const bug = await prisma.bug.findFirst({
    where: { id, deletedAt: null },
    select: {
      ...bugSelect,
      attachments: {
        select: {
          id: true,
          caption: true,
          createdAt: true,
          file: {
            select: {
              id: true,
              originalName: true,
              mimeType: true,
              sizeBytes: true,
              storageKey: true,
            },
          },
        },
      },
      comments: {
        where: seesInternal ? {} : { isInternal: false },
        select: {
          id: true,
          body: true,
          isInternal: true,
          createdAt: true,
          author: { select: { id: true, firstName: true, lastName: true, role: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
      statusHistory: {
        select: {
          id: true,
          fromStatus: true,
          toStatus: true,
          note: true,
          createdAt: true,
          changedBy: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
      duplicateOf: { select: { id: true, reference: true, title: true, status: true } },
    },
  })

  if (!bug) throw new NotFoundError('Bug')

  // Attachments are private objects; hand back short-lived signed URLs.
  const attachments = await Promise.all(
    bug.attachments.map(async (a) => ({
      id: a.id,
      caption: a.caption,
      createdAt: a.createdAt,
      file: {
        id: a.file.id,
        originalName: a.file.originalName,
        mimeType: a.file.mimeType,
        sizeBytes: a.file.sizeBytes,
        downloadUrl: await createDownloadUrl(a.file.storageKey, a.file.originalName),
      },
    })),
  )

  /**
   * Tell the client exactly what this user may do next.
   *
   * Without this every frontend re-implements the transition matrix and they
   * drift — the tester portal offers "Verify" on a bug the API will refuse.
   */
  const actors = bugActors(relations)
  const reporterOnly = isReporterOnly(relations)

  return {
    ...bug,
    attachments,
    capabilities: {
      canEdit: can(user, 'bug.update', relations) && (!reporterOnly || canReporterEdit(bug.status)),
      canDelete:
        can(user, 'bug.delete', relations) && (!reporterOnly || canReporterDelete(bug.status)),
      canComment: can(user, 'bug.comment', relations),
      canCommentInternally: seesInternal,
      canAttach: can(user, 'bug.attach', relations),
      canChangeSeverity: actors.includes('platform'),
      availableTransitions: can(user, 'bug.change_status', relations)
        ? allowedTransitions(bug.status, actors)
        : [],
    },
  }
}

// ─── Create ──────────────────────────────────────────────────────────────────

export async function createBug(
  user: Express.AuthenticatedUser,
  input: Record<string, unknown> & { projectId: string; buildId?: string; attachmentFileIds: string[] },
) {
  const { projectId, buildId: requestedBuildId, attachmentFileIds, ...data } = input

  const resolved = await projectRelations(user, projectId)
  if (!resolved) throw new NotFoundError('Project')

  // Only a tester with an accepted/active assignment may log a defect.
  authorize(user, 'bug.create', resolved.relations)

  if (['COMPLETED', 'CANCELLED', 'DRAFT'].includes(resolved.project.status)) {
    throw new ConflictError('This project is not currently accepting bug reports')
  }

  // The tester portal has no build switcher — a report always lands on the
  // project's default build unless a build-aware caller (the admin panel)
  // names one explicitly.
  const buildId = await resolveBuildId(projectId, requestedBuildId)

  if (attachmentFileIds.length > 0) {
    const files = await prisma.fileObject.findMany({
      where: { id: { in: attachmentFileIds }, uploadedById: user.id, isComplete: true },
      select: { id: true },
    })
    if (files.length !== attachmentFileIds.length) {
      throw new BadRequestError('One or more attachments are missing or not finished uploading')
    }
  }

  if (typeof data.featureId === 'string') {
    const feature = await prisma.feature.findFirst({
      where: { id: data.featureId, projectId, buildId },
      select: { id: true },
    })
    if (!feature) throw new BadRequestError('That feature does not belong to this build')
  }

  const bug = await prisma.bug.create({
    data: {
      ...(data as Prisma.BugCreateInput),
      reference: await nextReference('bug'),
      project: { connect: { id: projectId } },
      build: { connect: { id: buildId } },
      reportedBy: { connect: { id: user.id } },
      status: BugStatus.NEW,
      ...(attachmentFileIds.length > 0
        ? { attachments: { create: attachmentFileIds.map((fileId) => ({ fileId })) } }
        : {}),
      statusHistory: {
        create: {
          changedById: user.id,
          fromStatus: null,
          toStatus: BugStatus.NEW,
          note: 'Reported',
        },
      },
    },
    select: bugSelect,
  })

  await refreshTesterAggregates(user.id)
  await notifyProjectSide(projectId, resolved.project.organisationId, {
    type: 'BUG_REPORTED',
    title: `${bug.severity} bug reported on "${bug.project.title}"`,
    body: bug.title,
    link: `/app/bugs/${bug.id}`,
  })

  return bug
}

/** Fan-out to the customer's owners and the project's managers. */
async function notifyProjectSide(
  projectId: string,
  organisationId: string,
  payload: Parameters<typeof createNotifications>[1],
  excludeUserId?: string,
) {
  const [owners, managers] = await Promise.all([
    prisma.organisationMember.findMany({
      where: { organisationId, orgRole: OrgMemberRole.OWNER },
      select: { userId: true },
    }),
    prisma.managerAssignment.findMany({ where: { projectId }, select: { managerId: true } }),
  ])

  const recipients = [...owners.map((o) => o.userId), ...managers.map((m) => m.managerId)].filter(
    (id) => id !== excludeUserId,
  )

  await createNotifications(recipients, payload)
}

// ─── Update content ──────────────────────────────────────────────────────────

export async function updateBug(
  user: Express.AuthenticatedUser,
  id: string,
  input: Record<string, unknown>,
) {
  const resolved = await bugRelations(user, id)
  if (!resolved) throw new NotFoundError('Bug')

  const { relations, bug } = resolved
  if (!can(user, 'bug.read', relations)) throw new NotFoundError('Bug')
  authorize(user, 'bug.update', relations)

  // A reporter may correct their own report only before anyone has acted on it.
  if (isReporterOnly(relations) && !canReporterEdit(bug.status as BugStatus)) {
    throw new ForbiddenError(
      'This report has already been triaged and can no longer be edited. Add a comment instead.',
    )
  }

  if (typeof input.featureId === 'string') {
    const feature = await prisma.feature.findFirst({
      where: { id: input.featureId, projectId: bug.projectId, buildId: bug.buildId },
      select: { id: true },
    })
    if (!feature) throw new BadRequestError('That feature does not belong to this build')
  }

  return prisma.bug.update({
    where: { id },
    data: input,
    select: bugSelect,
  })
}

// ─── Status change ───────────────────────────────────────────────────────────

const RESOLVED_STATUSES: BugStatus[] = [
  BugStatus.FIXED,
  BugStatus.VERIFIED,
  BugStatus.WONT_FIX,
  BugStatus.REJECTED,
  BugStatus.DUPLICATE,
  BugStatus.FEATURE_REQUEST,
]

/**
 * The single entry point for moving a bug through its lifecycle.
 *
 * Replaces the old admin-only `triage`: a customer marking a defect fixed and
 * an admin confirming one are the same operation, differing only in which
 * transitions each is permitted. See the matrix in access/policy.ts.
 */
export async function changeBugStatus(
  user: Express.AuthenticatedUser,
  id: string,
  input: {
    status?: BugStatus
    severity?: BugSeverity
    duplicateOfId?: string | null
    note?: string
  },
) {
  const resolved = await bugRelations(user, id)
  if (!resolved) throw new NotFoundError('Bug')

  const { relations, bug } = resolved
  if (!can(user, 'bug.read', relations)) throw new NotFoundError('Bug')
  authorize(user, 'bug.change_status', relations)

  const current = bug.status as BugStatus
  const actors = bugActors(relations)

  // Severity is a triage judgement, not a customer one.
  if (input.severity !== undefined && !actors.includes('platform')) {
    throw new ForbiddenError('Only an administrator or project manager can change severity')
  }

  if (input.status && input.status !== current && !canTransition(current, input.status, actors)) {
    const allowed = allowedTransitions(current, actors)
    throw new ConflictError(
      allowed.length > 0
        ? `Cannot move this bug from ${current} to ${input.status}. Available: ${allowed.join(', ')}.`
        : `You cannot change the status of a bug that is ${current}.`,
    )
  }

  if (input.duplicateOfId) {
    if (input.duplicateOfId === id) throw new BadRequestError('A bug cannot duplicate itself')
    const target = await prisma.bug.findFirst({
      where: { id: input.duplicateOfId, deletedAt: null },
      select: { id: true, projectId: true },
    })
    if (!target) throw new BadRequestError('The bug it duplicates does not exist')
    if (target.projectId !== bug.projectId) {
      throw new BadRequestError('A duplicate must be on the same project')
    }
  }

  const nextStatus = input.status ?? current

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.bug.update({
      where: { id },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.severity ? { severity: input.severity } : {}),
        ...(input.duplicateOfId !== undefined ? { duplicateOfId: input.duplicateOfId } : {}),
        ...(current === BugStatus.NEW && input.status && input.status !== BugStatus.NEW
          ? { triagedAt: new Date() }
          : {}),
        // Clear the resolution timestamp when a bug comes back to life.
        ...(RESOLVED_STATUSES.includes(nextStatus)
          ? { resolvedAt: new Date() }
          : { resolvedAt: null }),
      },
      select: bugSelect,
    })

    if (input.status && input.status !== current) {
      await tx.bugStatusHistory.create({
        data: {
          bugId: id,
          changedById: user.id,
          fromStatus: current,
          toStatus: input.status,
          note: input.note ?? null,
        },
      })
    }

    return result
  })

  // Accepted/rejected counts feed the tester's public profile.
  await refreshTesterAggregates(bug.reportedById)

  if (input.status && input.status !== current) {
    const label = input.status.toLowerCase().replace(/_/g, ' ')

    // The reporter always wants to know, unless they made the change.
    if (bug.reportedById !== user.id) {
      await createNotification({
        userId: bug.reportedById,
        type: 'BUG_STATUS_CHANGED',
        title: `${updated.reference} is now ${label}`,
        body: input.note,
        link: `/app/bugs/${id}`,
        // A fix is the one state that needs the reporter to act.
        metadata: {
          from: current,
          to: input.status,
          needsVerification: input.status === BugStatus.FIXED,
        },
      })
    }

    // The customer side cares about verification and regressions.
    if (input.status === BugStatus.VERIFIED || input.status === BugStatus.REOPENED) {
      await notifyProjectSide(
        bug.projectId,
        bug.organisationId,
        {
          type: 'BUG_STATUS_CHANGED',
          title: `${updated.reference} is now ${label}`,
          body: input.note,
          link: `/app/bugs/${id}`,
        },
        user.id,
      )
    }
  }

  return updated
}

/**
 * Bulk status change for a batch of bugs.
 *
 * Per-row checks against the transition matrix and the actor's relations —
 * one row that fails does NOT abort the batch; the response lists which ids
 * were updated and which were skipped, with a reason for the skips. This is
 * what makes a bulk operation survivable on a real queue where every row is
 * likely at a different stage of triage.
 *
 * Returns `{ updated: string[], skipped: { id: string, reason: string }[] }`.
 */
export async function bulkChangeBugStatus(
  user: Express.AuthenticatedUser,
  input: {
    ids: string[]
    status?: BugStatus
    severity?: BugSeverity
    note?: string
  },
): Promise<{ updated: string[]; skipped: { id: string; reason: string }[] }> {
  if (!input.status && !input.severity) {
    throw new BadRequestError('Provide at least one of status or severity')
  }

  const updated: string[] = []
  const skipped: { id: string; reason: string }[] = []

  // Sequential rather than concurrent — the per-row auth check is cheap, but
  // hammering the transition matrix and aggregate refresh in parallel is a
  // recipe for surprising lock contention. 200 rows serialised is still
  // sub-second on a real Postgres.
  for (const id of input.ids) {
    try {
      const resolved = await bugRelations(user, id)
      if (!resolved) {
        skipped.push({ id, reason: 'Bug not found' })
        continue
      }
      const { relations, bug } = resolved
      if (!can(user, 'bug.read', relations)) {
        skipped.push({ id, reason: 'Not found' })
        continue
      }
      authorize(user, 'bug.change_status', relations)

      const current = bug.status as BugStatus
      const actors = bugActors(relations)

      if (input.severity !== undefined && !actors.includes('platform')) {
        skipped.push({ id, reason: 'Only platform staff can change severity' })
        continue
      }

      if (input.status && input.status !== current) {
        if (!canTransition(current, input.status, actors)) {
          const allowed = allowedTransitions(current, actors)
          skipped.push({
            id,
            reason:
              allowed.length > 0
                ? `Cannot move from ${current} to ${input.status}`
                : `No transitions allowed from ${current}`,
          })
          continue
        }
      }

      const nextStatus = input.status ?? current

      await prisma.$transaction(async (tx) => {
        await tx.bug.update({
          where: { id },
          data: {
            ...(input.status ? { status: input.status } : {}),
            ...(input.severity ? { severity: input.severity } : {}),
            ...(current === BugStatus.NEW && input.status && input.status !== BugStatus.NEW
              ? { triagedAt: new Date() }
              : {}),
            ...(RESOLVED_STATUSES.includes(nextStatus)
              ? { resolvedAt: new Date() }
              : { resolvedAt: null }),
          },
        })

        if (input.status && input.status !== current) {
          await tx.bugStatusHistory.create({
            data: {
              bugId: id,
              changedById: user.id,
              fromStatus: current,
              toStatus: input.status,
              note: input.note ?? null,
            },
          })
        }
      })

      await refreshTesterAggregates(bug.reportedById)
      updated.push(id)
    } catch (err) {
      // A single row failing should not abort the batch.
      skipped.push({ id, reason: err instanceof Error ? err.message : 'Unknown error' })
    }
  }

  return { updated, skipped }
}

// ─── Delete ──────────────────────────────────────────────────────────────────

export async function deleteBug(user: Express.AuthenticatedUser, id: string) {
  const resolved = await bugRelations(user, id)
  if (!resolved) throw new NotFoundError('Bug')

  const { relations, bug } = resolved
  if (!can(user, 'bug.read', relations)) throw new NotFoundError('Bug')
  authorize(user, 'bug.delete', relations)

  // A reporter may withdraw their own report only before it has been triaged.
  if (isReporterOnly(relations) && !canReporterDelete(bug.status as BugStatus)) {
    throw new ForbiddenError(
      'This report has already been triaged and cannot be withdrawn. Ask an administrator.',
    )
  }

  const result = await prisma.bug.update({
    where: { id },
    data: { deletedAt: new Date() },
    select: { id: true, deletedAt: true },
  })

  await refreshTesterAggregates(bug.reportedById)
  return result
}

// ─── Comments ────────────────────────────────────────────────────────────────

export async function addComment(
  user: Express.AuthenticatedUser,
  bugId: string,
  input: { body: string; isInternal: boolean },
) {
  const resolved = await bugRelations(user, bugId)
  if (!resolved) throw new NotFoundError('Bug')

  const { relations, bug } = resolved
  if (!can(user, 'bug.read', relations)) throw new NotFoundError('Bug')
  authorize(user, 'bug.comment', relations)

  if (input.isInternal) authorize(user, 'bug.comment_internal', relations)

  const comment = await prisma.bugComment.create({
    data: { bugId, authorId: user.id, body: input.body, isInternal: input.isInternal },
    select: {
      id: true,
      body: true,
      isInternal: true,
      createdAt: true,
      author: { select: { id: true, firstName: true, lastName: true, role: true } },
    },
  })

  if (!input.isInternal) {
    const detail = await prisma.bug.findUnique({
      where: { id: bugId },
      select: { reference: true },
    })

    const recipients = new Set<string>()
    if (bug.reportedById !== user.id) recipients.add(bug.reportedById)

    const owners = await prisma.organisationMember.findMany({
      where: { organisationId: bug.organisationId, orgRole: OrgMemberRole.OWNER },
      select: { userId: true },
    })
    for (const owner of owners) if (owner.userId !== user.id) recipients.add(owner.userId)

    await createNotifications([...recipients], {
      type: 'MESSAGE_RECEIVED',
      title: `New comment on ${detail?.reference ?? 'a bug'}`,
      link: `/app/bugs/${bugId}`,
    })
  }

  return comment
}

// ─── Attachments ─────────────────────────────────────────────────────────────

export async function addAttachment(
  user: Express.AuthenticatedUser,
  bugId: string,
  input: { fileId: string; caption?: string },
) {
  const resolved = await bugRelations(user, bugId)
  if (!resolved) throw new NotFoundError('Bug')

  const { relations } = resolved
  if (!can(user, 'bug.read', relations)) throw new NotFoundError('Bug')
  authorize(user, 'bug.attach', relations)

  const file = await prisma.fileObject.findFirst({
    where: { id: input.fileId, uploadedById: user.id, isComplete: true },
    select: { id: true },
  })
  if (!file) throw new BadRequestError('That file is missing or has not finished uploading')

  return prisma.bugAttachment.create({
    data: { bugId, fileId: input.fileId, caption: input.caption ?? null },
    select: {
      id: true,
      caption: true,
      file: { select: { id: true, originalName: true, mimeType: true, sizeBytes: true } },
    },
  })
}

export async function removeAttachment(
  user: Express.AuthenticatedUser,
  bugId: string,
  attachmentId: string,
) {
  const resolved = await bugRelations(user, bugId)
  if (!resolved) throw new NotFoundError('Bug')

  const { relations, bug } = resolved
  if (!can(user, 'bug.read', relations)) throw new NotFoundError('Bug')
  authorize(user, 'bug.attach', relations)

  const attachment = await prisma.bugAttachment.findFirst({
    where: { id: attachmentId, bugId },
    select: { id: true },
  })
  if (!attachment) throw new NotFoundError('Attachment')

  if (isReporterOnly(relations) && !canReporterEdit(bug.status as BugStatus)) {
    throw new ForbiddenError(
      'This report has been triaged; its attachments are now part of the record',
    )
  }

  await prisma.bugAttachment.delete({ where: { id: attachmentId } })
}
