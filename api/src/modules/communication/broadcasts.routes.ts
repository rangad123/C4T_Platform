import { Router } from 'express'
import { z } from 'zod'
import { BroadcastStatus, ThreadType, NotificationType, type Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { param } from '../../lib/http.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { buildMeta, paginationQuery, toSkipTake } from '../../lib/pagination.js'
import { NotFoundError, BadRequestError } from '../../lib/errors.js'
import { recordAudit } from '../../lib/audit.js'
import { createNotifications } from '../notifications/notifications.service.js'
import { PERMISSIONS } from '../../config/permissions.js'

/**
 * Broadcasts — one composed message sent to many testers.
 *
 * ── WHY THIS IS A MODULE AND NOT JUST A THREAD LOOP
 *
 * The fan-out still creates one private `Thread` per recipient. That is
 * deliberate and unchanged: nobody should see who else received a message or
 * how they replied, and the tester's side stays an ordinary two-way
 * conversation they can answer.
 *
 * What was missing was any record of the SEND. The composed subject and body
 * existed only as N copies, so "what did I send, to whom, and have they read
 * it" could not be answered without guessing which threads belonged together
 * by timestamp. `Broadcast` owns the threads it created and answers it
 * directly — and makes drafts possible, since a draft is simply a broadcast
 * with no threads behind it yet.
 *
 * ── WHAT IS DELIBERATELY NOT HERE
 *
 * No "delivered" or "pending" state. Nothing in this platform observes
 * either, and inventing them would put numbers on screen that mean nothing.
 * The states that exist are the ones that are real: DRAFT, SENT, a genuine
 * per-recipient failure, and read — the last derived from
 * `ThreadParticipant.lastReadAt` rather than copied, so it cannot drift from
 * what the tester actually did.
 */
export const broadcastsRouter = Router()

broadcastsRouter.use(authenticate)

const listQuery = paginationQuery.extend({
  status: z.nativeEnum(BroadcastStatus).optional(),
  search: z.string().trim().max(160).optional(),
})

const broadcastBody = z.object({
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1).max(10_000),
  templateId: z.string().cuid().nullable().optional(),
  recipientIds: z.array(z.string().cuid()).max(500).default([]),
})

const idParam = z.object({ id: z.string().cuid() })

const broadcastSelect = {
  id: true,
  subject: true,
  body: true,
  status: true,
  sentAt: true,
  createdAt: true,
  updatedAt: true,
  sender: { select: { id: true, firstName: true, lastName: true, email: true } },
  template: { select: { id: true, name: true } },
  _count: { select: { recipients: true } },
} satisfies Prisma.BroadcastSelect

/**
 * Rejects recipient ids that name nobody, before anything is written.
 *
 * Same reasoning as thread creation: without it a caller could submit
 * cuid-shaped ids and read the resulting error to tell "real account" from
 * "no such account" — a small but real account-enumeration oracle.
 */
async function assertRealUsers(ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  const found = await prisma.user.findMany({
    where: { id: { in: unique }, deletedAt: null },
    select: { id: true },
  })
  if (found.length !== unique.length) {
    throw new BadRequestError('One or more recipients do not exist')
  }
  return unique
}

/**
 * How many recipients have actually opened their copy.
 *
 * Derived, never stored. One query for the whole page rather than per row.
 * Only the RECIPIENT's own participant row counts — the sender is a
 * participant too, and their own read would otherwise mark every broadcast
 * as fully read the moment they sent it.
 */
async function readCountsFor(broadcastIds: readonly string[]): Promise<Map<string, number>> {
  if (broadcastIds.length === 0) return new Map()
  const rows = await prisma.broadcastRecipient.findMany({
    where: { broadcastId: { in: [...broadcastIds] }, threadId: { not: null } },
    select: {
      broadcastId: true,
      userId: true,
      thread: { select: { participants: { select: { userId: true, lastReadAt: true } } } },
    },
  })
  const counts = new Map<string, number>()
  for (const row of rows) {
    const theirs = row.thread?.participants.find((p) => p.userId === row.userId)
    if (theirs?.lastReadAt) counts.set(row.broadcastId, (counts.get(row.broadcastId) ?? 0) + 1)
  }
  return counts
}

/**
 * The caller's own broadcasts.
 *
 * Scoped to the sender rather than to the permission: one admin's drafts are
 * an unfinished thought, not another admin's to read or send.
 */
broadcastsRouter.get(
  '/',
  requirePermission(PERMISSIONS.COMMUNICATION_READ),
  validate({ query: listQuery }),
  async (req, res) => {
    const query = validatedQuery<z.infer<typeof listQuery>>(res)

    const where: Prisma.BroadcastWhereInput = {
      senderId: req.user!.id,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { subject: { contains: query.search, mode: 'insensitive' } },
              { body: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    }

    const [items, total] = await Promise.all([
      prisma.broadcast.findMany({
        where,
        select: broadcastSelect,
        orderBy: [{ sentAt: 'desc' }, { updatedAt: 'desc' }],
        ...toSkipTake(query),
      }),
      prisma.broadcast.count({ where }),
    ])

    const reads = await readCountsFor(items.map((b) => b.id))
    res.json({
      data: items.map((b) => ({ ...b, readCount: reads.get(b.id) ?? 0 })),
      meta: buildMeta(query, total),
    })
  },
)

broadcastsRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.COMMUNICATION_READ),
  validate({ params: idParam }),
  async (req, res) => {
    const broadcast = await prisma.broadcast.findFirst({
      where: { id: param(req, 'id'), senderId: req.user!.id },
      select: {
        ...broadcastSelect,
        recipients: {
          select: {
            id: true,
            userId: true,
            threadId: true,
            failedAt: true,
            failureReason: true,
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                avatarFileId: true,
              },
            },
            thread: { select: { participants: { select: { userId: true, lastReadAt: true } } } },
          },
        },
      },
    })
    if (!broadcast) throw new NotFoundError('Broadcast')

    const { recipients, ...rest } = broadcast
    res.json({
      data: {
        ...rest,
        readCount: recipients.filter((r) =>
          r.thread?.participants.some((p) => p.userId === r.userId && p.lastReadAt),
        ).length,
        recipients: recipients.map((r) => ({
          id: r.id,
          threadId: r.threadId,
          user: r.user,
          failedAt: r.failedAt,
          failureReason: r.failureReason,
          /** Real, from `ThreadParticipant.lastReadAt`. Null means not opened yet. */
          readAt: r.thread?.participants.find((p) => p.userId === r.userId)?.lastReadAt ?? null,
        })),
      },
    })
  },
)

/** Create a draft. Sending is always a separate, explicit step. */
broadcastsRouter.post(
  '/',
  requirePermission(PERMISSIONS.COMMUNICATION_WRITE),
  validate({ body: broadcastBody }),
  async (req, res) => {
    const input = req.body as z.infer<typeof broadcastBody>
    const recipientIds = await assertRealUsers(input.recipientIds)

    const broadcast = await prisma.broadcast.create({
      data: {
        senderId: req.user!.id,
        subject: input.subject ?? null,
        body: input.body,
        templateId: input.templateId ?? null,
        status: BroadcastStatus.DRAFT,
        recipients: { create: recipientIds.map((userId) => ({ userId })) },
      },
      select: broadcastSelect,
    })
    res.status(201).json({ data: { ...broadcast, readCount: 0 } })
  },
)

/** Update a draft. A sent broadcast is the record of what went out — immutable. */
broadcastsRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.COMMUNICATION_WRITE),
  validate({ params: idParam, body: broadcastBody.partial() }),
  async (req, res) => {
    const input = req.body as Partial<z.infer<typeof broadcastBody>>
    const existing = await prisma.broadcast.findFirst({
      where: { id: param(req, 'id'), senderId: req.user!.id },
      select: { id: true, status: true },
    })
    if (!existing) throw new NotFoundError('Broadcast')
    if (existing.status === BroadcastStatus.SENT) {
      throw new BadRequestError('A sent communication cannot be edited')
    }

    const recipientIds = input.recipientIds ? await assertRealUsers(input.recipientIds) : undefined

    const broadcast = await prisma.$transaction(async (tx) => {
      if (recipientIds) {
        // Replaced wholesale: the composer posts its full selection every
        // time, so diffing here would only invent a second source of truth.
        await tx.broadcastRecipient.deleteMany({ where: { broadcastId: existing.id } })
        if (recipientIds.length > 0) {
          await tx.broadcastRecipient.createMany({
            data: recipientIds.map((userId) => ({ broadcastId: existing.id, userId })),
          })
        }
      }
      return tx.broadcast.update({
        where: { id: existing.id },
        data: {
          ...(input.subject !== undefined ? { subject: input.subject || null } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
        },
        select: broadcastSelect,
      })
    })
    res.json({ data: { ...broadcast, readCount: 0 } })
  },
)

broadcastsRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.COMMUNICATION_WRITE),
  validate({ params: idParam }),
  async (req, res) => {
    const existing = await prisma.broadcast.findFirst({
      where: { id: param(req, 'id'), senderId: req.user!.id },
      select: { id: true, status: true },
    })
    if (!existing) throw new NotFoundError('Broadcast')
    if (existing.status === BroadcastStatus.SENT) {
      throw new BadRequestError('A sent communication cannot be deleted')
    }
    await prisma.broadcast.delete({ where: { id: existing.id } })
    res.status(204).send()
  },
)

/**
 * Send a draft.
 *
 * The fan-out runs here, on the server, one recipient at a time — which is
 * what replaces the browser firing a request per recipient. A recipient whose
 * thread cannot be created is recorded as failed and the batch continues: a
 * broadcast that reached 118 of 120 people is a success with two exceptions,
 * not a failure, and the two are named rather than lost.
 */
broadcastsRouter.post(
  '/:id/send',
  requirePermission(PERMISSIONS.COMMUNICATION_WRITE),
  validate({ params: idParam }),
  async (req, res) => {
    const broadcast = await prisma.broadcast.findFirst({
      where: { id: param(req, 'id'), senderId: req.user!.id },
      select: {
        id: true,
        status: true,
        subject: true,
        body: true,
        recipients: { select: { id: true, userId: true } },
      },
    })
    if (!broadcast) throw new NotFoundError('Broadcast')
    if (broadcast.status === BroadcastStatus.SENT) {
      throw new BadRequestError('This communication has already been sent')
    }
    if (broadcast.recipients.length === 0) {
      throw new BadRequestError('Add at least one recipient before sending')
    }

    const delivered: string[] = []
    for (const recipient of broadcast.recipients) {
      try {
        const thread = await prisma.thread.create({
          data: {
            type: ThreadType.DIRECT,
            subject: broadcast.subject,
            createdById: req.user!.id,
            lastMessageAt: new Date(),
            participants: { create: [{ userId: req.user!.id }, { userId: recipient.userId }] },
            messages: { create: { senderId: req.user!.id, body: broadcast.body } },
          },
          select: { id: true },
        })
        await prisma.broadcastRecipient.update({
          where: { id: recipient.id },
          data: { threadId: thread.id, failedAt: null, failureReason: null },
        })
        delivered.push(recipient.userId)
      } catch (error) {
        await prisma.broadcastRecipient.update({
          where: { id: recipient.id },
          data: {
            failedAt: new Date(),
            failureReason: error instanceof Error ? error.message.slice(0, 300) : 'Unknown error',
          },
        })
      }
    }

    const sent = await prisma.broadcast.update({
      where: { id: broadcast.id },
      data: { status: BroadcastStatus.SENT, sentAt: new Date() },
      select: broadcastSelect,
    })

    /**
     * Through the unified notification system, never a bespoke one. The link
     * is the portal-agnostic `/app/messages/:threadId`, which resolves to the
     * reader's own portal — see `web/src/lib/notifications/resolve-link.ts`.
     */
    const threads = await prisma.broadcastRecipient.findMany({
      where: { broadcastId: broadcast.id, threadId: { not: null } },
      select: { userId: true, threadId: true },
    })
    await Promise.all(
      threads.map((t) =>
        createNotifications([t.userId], {
          type: NotificationType.MESSAGE_RECEIVED,
          title: broadcast.subject ? `New message: ${broadcast.subject}` : 'You have a new message',
          link: `/app/messages/${t.threadId}`,
        }),
      ),
    )

    await recordAudit({
      req,
      action: 'broadcast.sent',
      entityType: 'Broadcast',
      entityId: broadcast.id,
      after: { recipients: broadcast.recipients.length, delivered: delivered.length },
    })

    res.json({
      data: {
        ...sent,
        readCount: 0,
        delivered: delivered.length,
        failed: broadcast.recipients.length - delivered.length,
      },
    })
  },
)
