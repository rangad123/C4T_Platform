import { Router } from 'express'
import { param } from '../../lib/http.js'
import { z } from 'zod'
import {
  ThreadType,
  AnnouncementAudience,
  Role,
  AssignmentStatus,
  NotificationType,
  UserStatus,
  type Prisma,
} from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission, isAdminSide } from '../../middleware/authorize.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { buildMeta, paginationQuery, toSkipTake } from '../../lib/pagination.js'
import { ForbiddenError, NotFoundError, BadRequestError } from '../../lib/errors.js'
import { recordAudit } from '../../lib/audit.js'
import { createNotifications } from '../notifications/notifications.service.js'
import { PERMISSIONS } from '../../config/permissions.js'
import { threadScope, projectScope } from '../../lib/access/scopes.js'

/**
 * §2.2 "Communication" — message threads between Customers, Testers and
 * Admin/Sub-Admin, plus platform announcements.
 *
 * Access rule: you can see a thread if you are a participant. The admin side
 * can additionally see any thread, which is what "manage/oversee communication"
 * in §2.2 requires.
 */
export const communicationRouter = Router()

communicationRouter.use(authenticate)

const threadSelect = {
  id: true,
  type: true,
  subject: true,
  isClosed: true,
  lastMessageAt: true,
  createdAt: true,
  project: { select: { id: true, reference: true, title: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true, role: true } },
  participants: {
    select: {
      lastReadAt: true,
      user: { select: { id: true, firstName: true, lastName: true, role: true } },
    },
  },
  _count: { select: { messages: true } },
} satisfies Prisma.ThreadSelect

/** Delegates to the shared scope so thread visibility has one definition. */
const threadVisibility = threadScope

// ─── Threads ─────────────────────────────────────────────────────────────────

const listThreadsQuery = paginationQuery.extend({
  projectId: z.string().cuid().optional(),
  type: z.nativeEnum(ThreadType).optional(),
  includeClosed: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
})

communicationRouter.get('/threads', validate({ query: listThreadsQuery }), async (req, res) => {
  const query = validatedQuery<z.infer<typeof listThreadsQuery>>(res)

  const where: Prisma.ThreadWhereInput = {
    ...threadVisibility(req.user!),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.includeClosed ? {} : { isClosed: false }),
  }

  const [items, total] = await Promise.all([
    prisma.thread.findMany({
      where,
      select: threadSelect,
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      ...toSkipTake(query),
    }),
    prisma.thread.count({ where }),
  ])

  res.json({ data: items, meta: buildMeta(query, total) })
})

const createThreadSchema = z.object({
  type: z.nativeEnum(ThreadType).default(ThreadType.PROJECT),
  subject: z.string().trim().max(200).optional(),
  projectId: z.string().cuid().optional(),
  participantIds: z.array(z.string().cuid()).min(1).max(50),
  message: z.string().trim().min(1).max(5000),
})

communicationRouter.post('/threads', validate({ body: createThreadSchema }), async (req, res) => {
  const input = req.body as z.infer<typeof createThreadSchema>

  if (input.type === ThreadType.PROJECT && !input.projectId) {
    throw new BadRequestError('projectId is required for a project thread')
  }

  // A non-admin may only start a thread on a project they can already see.
  if (input.projectId && !isAdminSide(req.user!)) {
    const allowed = await prisma.project.findFirst({
      where: { id: input.projectId, deletedAt: null, ...projectScope(req.user!) },
      select: { id: true },
    })
    if (!allowed) throw new ForbiddenError('You do not have access to that project')
  }

  // Resolve the participantIds down to real user ids, and reject the
  // request before INSERT if any of them are bogus. Without this, a non-admin
  // could submit a thread with arbitrary cuid-shaped ids and read the
  // resulting 409 to discriminate "valid user" from "no such user" — a
  // small but real account-enumeration oracle.
  const requested = [...new Set([...input.participantIds, req.user!.id])]
  const found = await prisma.user.findMany({
    where: { id: { in: requested }, deletedAt: null },
    select: { id: true },
  })
  const foundIds = new Set(found.map((u) => u.id))
  const missing = requested.filter((id) => !foundIds.has(id))
  if (missing.length > 0) {
    throw new BadRequestError('One or more participants do not exist')
  }
  const participantIds = requested

  const thread = await prisma.$transaction(async (tx) => {
    const created = await tx.thread.create({
      data: {
        type: input.type,
        subject: input.subject ?? null,
        projectId: input.projectId ?? null,
        createdById: req.user!.id,
        lastMessageAt: new Date(),
        participants: { create: participantIds.map((userId) => ({ userId })) },
        messages: { create: { senderId: req.user!.id, body: input.message } },
      },
      select: threadSelect,
    })
    return created
  })

  await createNotifications(
    participantIds.filter((id) => id !== req.user!.id),
    {
      type: 'MESSAGE_RECEIVED',
      title: input.subject ? `New conversation: ${input.subject}` : 'You have a new message',
      link: `/app/messages/${thread.id}`,
    },
  )

  res.status(201).json({ data: thread })
})

const threadIdParam = z.object({ id: z.string().cuid() })

communicationRouter.get('/threads/:id', validate({ params: threadIdParam }), async (req, res) => {
  const thread = await prisma.thread.findFirst({
    where: { id: param(req, 'id'), ...threadVisibility(req.user!) },
    select: {
      ...threadSelect,
      messages: {
        where: { deletedAt: null },
        select: {
          id: true,
          body: true,
          createdAt: true,
          editedAt: true,
          sender: { select: { id: true, firstName: true, lastName: true, role: true } },
          attachments: {
            select: {
              file: { select: { id: true, originalName: true, mimeType: true, sizeBytes: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  })
  if (!thread) throw new NotFoundError('Conversation')

  // Mark read for the caller if they are a participant.
  await prisma.threadParticipant.updateMany({
    where: { threadId: thread.id, userId: req.user!.id },
    data: { lastReadAt: new Date() },
  })

  res.json({ data: thread })
})

const postMessageSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  attachmentFileIds: z.array(z.string().cuid()).max(10).default([]),
})

communicationRouter.post(
  '/threads/:id/messages',
  validate({ params: threadIdParam, body: postMessageSchema }),
  async (req, res) => {
    const input = req.body as z.infer<typeof postMessageSchema>

    const thread = await prisma.thread.findFirst({
      where: { id: param(req, 'id'), ...threadVisibility(req.user!) },
      select: {
        id: true,
        isClosed: true,
        subject: true,
        participants: { select: { userId: true } },
      },
    })
    if (!thread) throw new NotFoundError('Conversation')
    if (thread.isClosed) throw new ForbiddenError('This conversation is closed')

    if (input.attachmentFileIds.length > 0) {
      const files = await prisma.fileObject.findMany({
        where: {
          id: { in: input.attachmentFileIds },
          uploadedById: req.user!.id,
          isComplete: true,
        },
        select: { id: true },
      })
      if (files.length !== input.attachmentFileIds.length) {
        throw new BadRequestError('One or more attachments are missing or unfinished')
      }
    }

    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          threadId: thread.id,
          senderId: req.user!.id,
          body: input.body,
          ...(input.attachmentFileIds.length > 0
            ? { attachments: { create: input.attachmentFileIds.map((fileId) => ({ fileId })) } }
            : {}),
        },
        select: {
          id: true,
          body: true,
          createdAt: true,
          sender: { select: { id: true, firstName: true, lastName: true, role: true } },
          attachments: { select: { file: { select: { id: true, originalName: true } } } },
        },
      })
      await tx.thread.update({ where: { id: thread.id }, data: { lastMessageAt: new Date() } })
      return created
    })

    await createNotifications(
      thread.participants.map((p) => p.userId).filter((id) => id !== req.user!.id),
      {
        type: 'MESSAGE_RECEIVED',
        title: thread.subject ? `New message in "${thread.subject}"` : 'You have a new message',
        link: `/app/messages/${thread.id}`,
      },
    )

    res.status(201).json({ data: message })
  },
)

/** Closing a thread is an admin-side moderation action (§2.2). */
communicationRouter.post(
  '/threads/:id/close',
  requirePermission(PERMISSIONS.COMMUNICATION_WRITE),
  validate({ params: threadIdParam }),
  async (req, res) => {
    const thread = await prisma.thread.update({
      where: { id: param(req, 'id') },
      data: { isClosed: true },
      select: { id: true, isClosed: true },
    })
    await recordAudit({ req, action: 'thread.closed', entityType: 'Thread', entityId: thread.id })
    res.json({ data: thread })
  },
)

// ─── Announcements ───────────────────────────────────────────────────────────

/** What the calling role is entitled to see. */
function announcementAudienceFor(role: Role): AnnouncementAudience[] {
  const map: Record<Role, AnnouncementAudience[]> = {
    [Role.CUSTOMER]: [AnnouncementAudience.ALL, AnnouncementAudience.CUSTOMERS],
    [Role.TESTER]: [AnnouncementAudience.ALL, AnnouncementAudience.TESTERS],
    [Role.ADMIN]: Object.values(AnnouncementAudience),
    [Role.SUB_ADMIN]: Object.values(AnnouncementAudience),
    [Role.USER]: [AnnouncementAudience.ALL],
  }
  return map[role]
}

/**
 * `projectId` / `buildId` narrow the list to one project or build. Neither
 * widens access: they are ANDed with the scope clause below, so a tester
 * passing someone else's build id gets an empty list, not a leak.
 */
const listAnnouncementsQuery = paginationQuery.extend({
  projectId: z.string().cuid().optional(),
  buildId: z.string().cuid().optional(),
})

/**
 * Everyone a published announcement should reach, as user ids.
 *
 * The mirror of the read scope in `GET /announcements`. It has to be a mirror
 * and not an approximation: notifying someone who then cannot open the thing
 * is worse than not notifying them, and missing someone the list would show
 * makes the bell a liar.
 *
 * The rules, per axis:
 *  - AUDIENCE picks the roles, exactly as `announcementAudienceFor` does in
 *    reverse.
 *  - NO PROJECT is platform-wide: every active user in those roles.
 *  - A PROJECT narrows testers to its live roster and customers to the owning
 *    organisation's members.
 *  - A BUILD narrows the testers further to that build's own roster, which is
 *    the same anchoring the read path uses. Customers are NOT narrowed by
 *    build, because the read path does not narrow them either — they see
 *    their organisation's project announcements whichever build carries them.
 *
 * The author is always dropped. Being told about your own announcement is
 * noise, and it is the one recipient guaranteed to have already read it.
 */
async function announcementRecipients(announcement: {
  id: string
  authorId: string
  audience: AnnouncementAudience
  projectId: string | null
  buildId: string | null
}): Promise<string[]> {
  const roles =
    announcement.audience === AnnouncementAudience.ALL
      ? [Role.CUSTOMER, Role.TESTER, Role.ADMIN, Role.SUB_ADMIN]
      : announcement.audience === AnnouncementAudience.CUSTOMERS
        ? [Role.CUSTOMER]
        : announcement.audience === AnnouncementAudience.TESTERS
          ? [Role.TESTER]
          : [Role.ADMIN, Role.SUB_ADMIN]

  const live = { deletedAt: null, status: UserStatus.ACTIVE }
  const where: Prisma.UserWhereInput[] = []

  if (roles.includes(Role.TESTER)) {
    const onRoster = {
      status: { in: [AssignmentStatus.ACCEPTED, AssignmentStatus.ACTIVE] },
      ...(announcement.buildId
        ? { buildId: announcement.buildId }
        : announcement.projectId
          ? { projectId: announcement.projectId }
          : {}),
    }
    where.push({
      ...live,
      role: Role.TESTER,
      ...(announcement.projectId ? { assignments: { some: onRoster } } : {}),
    })
  }

  if (roles.includes(Role.CUSTOMER)) {
    where.push({
      ...live,
      role: Role.CUSTOMER,
      ...(announcement.projectId
        ? {
            orgMemberships: {
              some: { organisation: { projects: { some: { id: announcement.projectId } } } },
            },
          }
        : {}),
    })
  }

  const adminRoles = roles.filter((r) => r === Role.ADMIN || r === Role.SUB_ADMIN)
  if (adminRoles.length > 0) {
    where.push({ ...live, role: { in: adminRoles } })
  }

  if (where.length === 0) return []

  const users = await prisma.user.findMany({ where: { OR: where }, select: { id: true } })
  return users.map((u) => u.id).filter((id) => id !== announcement.authorId)
}

/**
 * The deep link a notification carries for an announcement.
 *
 * Portal-agnostic, like every other link this API writes — the frontend's
 * `resolveNotificationHref` puts the reader's own portal in front of it. A
 * project-scoped announcement points at that project's Announcements tab,
 * carrying the build so the tab opens on the cycle the announcement is about.
 * A platform-wide one has no project to point at and goes to the reader's
 * announcements list instead.
 */
function announcementLink(announcement: {
  id: string
  projectId: string | null
  buildId: string | null
}) {
  // Platform-wide announcements are broadcast, and broadcast is what the
  // Communications inbox holds — there is no global announcements feed to
  // send anyone to.
  if (!announcement.projectId) return `/app/communication?announcement=${announcement.id}`
  const params = new URLSearchParams({ section: 'announcements' })
  if (announcement.buildId) params.set('buildId', announcement.buildId)
  return `/app/projects/${announcement.projectId}?${params.toString()}`
}

communicationRouter.get(
  '/announcements',
  validate({ query: listAnnouncementsQuery }),
  async (req, res) => {
    const query = validatedQuery<z.infer<typeof listAnnouncementsQuery>>(res)
    const now = new Date()

    // Project-scoped announcements are only visible to users with a seat
    // on that project. Admins / sub-admins always see everything — for them
    // the project filter is a no-op, so the OR clause collapses to a single
    // empty filter (`{}`) that matches every row.
    const projectScopeOr: Prisma.AnnouncementWhereInput[] = isAdminSide(req.user!)
      ? [{}]
      : [{ projectId: null }]
    if (req.user!.role === Role.TESTER) {
      /**
       * A live roster row for this tester. `ProjectAssignment` is unique on
       * `[projectId, testerId]` and carries the ONE build they were invited
       * under, so the same filter answers both "are they on this project"
       * and "are they on this build" depending on where it is anchored.
       */
      const assignedToTester = {
        testerId: req.user!.id,
        status: { in: [AssignmentStatus.ACCEPTED, AssignmentStatus.ACTIVE] },
      }

      projectScopeOr.push(
        // Project-wide: every tester with a live seat on the project.
        { buildId: null, project: { assignments: { some: assignedToTester } } },
        /**
         * Build-narrowed: only the testers actually on that build.
         *
         * Anchoring on `build.assignments` rather than `project.assignments`
         * is the whole point. The composer offers a build as an optional
         * narrowing of a project announcement, and until now the read path
         * ignored `buildId` entirely — so "iOS build 3 is paused" reached
         * every tester on the project, including those on the Android build
         * who then had nothing to act on. It also leaked build names to
         * testers who were never given that build.
         */
        { build: { assignments: { some: assignedToTester } } },
      )
    } else if (req.user!.role === Role.CUSTOMER) {
      projectScopeOr.push({
        project: {
          organisation: { members: { some: { userId: req.user!.id } } },
        },
      })
    }

    const where: Prisma.AnnouncementWhereInput = {
      audience: { in: announcementAudienceFor(req.user!.role) },
      publishedAt: { not: null, lte: now },
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        { OR: projectScopeOr },
        /**
         * `projectId` and `buildId` are CONTEXT filters, not equality filters:
         * each keeps the broader-scope rows that also apply here. Asking for
         * one build returns that build's announcements plus the project-wide
         * ones; asking for a project returns its own plus the platform-wide
         * ones.
         *
         * Strict equality would hide exactly the message a tester most needs
         * in a build workspace — "the project is paused" is stored with a null
         * `buildId`, so `buildId = Y` alone would drop it.
         *
         * Nothing needs strict equality yet. If an admin list ever wants
         * "this project only", that is a separate parameter, not a change of
         * meaning here.
         */
        ...(query.projectId ? [{ OR: [{ projectId: query.projectId }, { projectId: null }] }] : []),
        ...(query.buildId ? [{ OR: [{ buildId: query.buildId }, { buildId: null }] }] : []),
      ],
    }

    const [items, total] = await Promise.all([
      prisma.announcement.findMany({
        where,
        select: {
          id: true,
          title: true,
          body: true,
          audience: true,
          projectId: true,
          project: { select: { id: true, reference: true, title: true } },
          buildId: true,
          build: { select: { id: true, name: true } },
          publishedAt: true,
          expiresAt: true,
          author: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { publishedAt: 'desc' },
        ...toSkipTake(query),
      }),
      prisma.announcement.count({ where }),
    ])

    res.json({ data: items, meta: buildMeta(query, total) })
  },
)

const announcementSchema = z.object({
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(10_000),
  audience: z.nativeEnum(AnnouncementAudience).default(AnnouncementAudience.ALL),
  /**
   * Optional project scope. When set, the announcement is only shown to
   * members of this project (its testers, customer members, and assigned
   * managers). When null, the audience enum alone decides who sees it.
   */
  projectId: z.string().cuid().nullable().optional(),
  /** Optional further narrowing to one build of `projectId`. Always optional. */
  buildId: z.string().cuid().nullable().optional(),
  publishNow: z.boolean().default(true),
  expiresAt: z.coerce.date().optional(),
})

communicationRouter.post(
  '/announcements',
  requirePermission(PERMISSIONS.ANNOUNCEMENT_WRITE),
  validate({ body: announcementSchema }),
  async (req, res) => {
    const input = req.body as z.infer<typeof announcementSchema>

    // Validate the project exists if one was supplied. No membership check
    // here — admin-side roles can post to any project; non-admin authors
    // would need a follow-up check in the service.
    if (input.projectId) {
      const exists = await prisma.project.findUnique({
        where: { id: input.projectId },
        select: { id: true },
      })
      if (!exists) throw new NotFoundError('Project')
    }

    // A build only makes sense alongside its own project.
    if (input.buildId) {
      if (!input.projectId) throw new BadRequestError('buildId requires projectId')
      const build = await prisma.build.findFirst({
        where: { id: input.buildId, projectId: input.projectId, deletedAt: null },
        select: { id: true },
      })
      if (!build) throw new NotFoundError('Build')
    }

    const announcement = await prisma.announcement.create({
      data: {
        authorId: req.user!.id,
        title: input.title,
        body: input.body,
        audience: input.audience,
        projectId: input.projectId ?? null,
        buildId: input.buildId ?? null,
        publishedAt: input.publishNow ? new Date() : null,
        expiresAt: input.expiresAt ?? null,
      },
    })

    await recordAudit({
      req,
      action: 'announcement.created',
      entityType: 'Announcement',
      entityId: announcement.id,
      after: { title: input.title, audience: input.audience, projectId: input.projectId ?? null },
    })

    /**
     * Publishing is what makes it visible, so publishing is what notifies.
     * A draft (`publishNow` false) reaches nobody and must not ring anyone's
     * bell; there is no separate publish endpoint today, so this is the only
     * moment an announcement can become visible.
     *
     * The notification IS the read state. `Announcement` has no per-user read
     * column and needs none — one unified notification system, exactly as the
     * enum's own ANNOUNCEMENT member always intended, and unread is simply
     * `readAt === null` on the row the reader already owns.
     */
    if (announcement.publishedAt) {
      const recipients = await announcementRecipients(announcement)
      await createNotifications(recipients, {
        type: NotificationType.ANNOUNCEMENT,
        title: announcement.title,
        body: announcement.body.slice(0, 300),
        link: announcementLink(announcement),
        metadata: {
          announcementId: announcement.id,
          projectId: announcement.projectId,
          buildId: announcement.buildId,
        },
      })
    }

    res.status(201).json({ data: announcement })
  },
)

communicationRouter.get(
  '/announcements/:id',
  validate({ params: threadIdParam }),
  async (req, res) => {
    const a = await prisma.announcement.findUnique({
      where: { id: param(req, 'id') },
      select: {
        id: true,
        title: true,
        body: true,
        audience: true,
        projectId: true,
        project: { select: { id: true, reference: true, title: true } },
        publishedAt: true,
        expiresAt: true,
        author: { select: { id: true, firstName: true, lastName: true } },
      },
    })
    if (!a) throw new NotFoundError('Announcement')
    res.json({ data: a })
  },
)

communicationRouter.delete(
  '/announcements/:id',
  requirePermission(PERMISSIONS.ANNOUNCEMENT_WRITE),
  validate({ params: threadIdParam }),
  async (req, res) => {
    await prisma.announcement.delete({ where: { id: param(req, 'id') } })
    await recordAudit({
      req,
      action: 'announcement.deleted',
      entityType: 'Announcement',
      entityId: param(req, 'id'),
    })
    res.status(204).send()
  },
)

// ─── Message templates (§23) ──────────────────────────────────────────────────
//
// Reusable subject/body pairs for the announcement and broadcast composers.
// No pagination — template counts are small (a handful to a few dozen), and
// both consuming UIs need the full set at once to populate a <select>.

const templateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1).max(10_000),
})

communicationRouter.get(
  '/templates',
  requirePermission(PERMISSIONS.COMMUNICATION_READ),
  async (_req, res) => {
    const templates = await prisma.messageTemplate.findMany({
      select: {
        id: true,
        name: true,
        subject: true,
        body: true,
        createdAt: true,
        createdBy: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { name: 'asc' },
    })
    res.json({ data: templates })
  },
)

communicationRouter.post(
  '/templates',
  requirePermission(PERMISSIONS.COMMUNICATION_WRITE),
  validate({ body: templateSchema }),
  async (req, res) => {
    const input = req.body as z.infer<typeof templateSchema>

    const existing = await prisma.messageTemplate.findUnique({
      where: { name: input.name },
      select: { id: true },
    })
    if (existing) throw new BadRequestError('A template with this name already exists')

    const template = await prisma.messageTemplate.create({
      data: {
        name: input.name,
        subject: input.subject ?? null,
        body: input.body,
        createdById: req.user!.id,
      },
    })

    await recordAudit({
      req,
      action: 'message_template.created',
      entityType: 'MessageTemplate',
      entityId: template.id,
      after: { name: input.name },
    })

    res.status(201).json({ data: template })
  },
)

communicationRouter.delete(
  '/templates/:id',
  requirePermission(PERMISSIONS.COMMUNICATION_WRITE),
  validate({ params: threadIdParam }),
  async (req, res) => {
    const existing = await prisma.messageTemplate.findUnique({
      where: { id: param(req, 'id') },
      select: { id: true, name: true },
    })
    if (!existing) throw new NotFoundError('Template')

    await prisma.messageTemplate.delete({ where: { id: param(req, 'id') } })
    await recordAudit({
      req,
      action: 'message_template.deleted',
      entityType: 'MessageTemplate',
      entityId: existing.id,
      before: { name: existing.name },
    })
    res.status(204).send()
  },
)
