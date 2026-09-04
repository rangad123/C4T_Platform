import type { NotificationType, Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { buildMeta, toSkipTake } from '../../lib/pagination.js'
import { NotFoundError } from '../../lib/errors.js'
import { dispatchNotificationEmails } from '../../lib/email/dispatch.js'

/**
 * Notifications. Deliberately fire-and-forget: a notification failing to write
 * must never roll back the business action that triggered it.
 *
 * ── EMAIL
 *
 * Email fan-out IS wired here, and here only. Every module that raises a
 * notification already assembles exactly what an email needs — a title, an
 * optional body, a link to the thing — so putting the fan-out at this one
 * junction means a new notification is mailed by construction, and there is a
 * single place to answer "why did this person get an email?".
 *
 * `lib/email/policy.ts` decides which types actually send; a type absent from
 * that table stays in-app only. The dispatch is detached — see the note in
 * `lib/email/dispatch.ts` for why an announcement to a thousand testers must
 * not be sent inside the request that published it.
 */
export async function createNotification(input: {
  userId: string
  type: NotificationType
  title: string
  body?: string
  link?: string
  metadata?: Prisma.InputJsonValue
}): Promise<void> {
  // Captured before the write — the throttle needs to tell an EARLIER unread
  // nudge from the one being created right now. See `NotificationEmailInput`.
  const cutoff = new Date()

  try {
    await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        link: input.link ?? null,
        metadata: input.metadata ?? undefined,
      },
    })
  } catch (error) {
    logger.error(
      { err: error, userId: input.userId, type: input.type },
      'Failed to create notification',
    )
    // No row, no email. The two must agree.
    return
  }

  dispatchNotificationEmails({
    userIds: [input.userId],
    type: input.type,
    title: input.title,
    body: input.body,
    link: input.link,
    cutoff,
  })
}

/** Bulk variant for fan-out to every participant on a project or thread. */
export async function createNotifications(
  userIds: string[],
  input: Omit<Parameters<typeof createNotification>[0], 'userId'>,
): Promise<void> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return

  const cutoff = new Date()

  try {
    await prisma.notification.createMany({
      data: unique.map((userId) => ({
        userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        link: input.link ?? null,
        metadata: input.metadata ?? undefined,
      })),
    })
  } catch (error) {
    logger.error(
      { err: error, count: unique.length, type: input.type },
      'Failed to create notifications',
    )
    return
  }

  dispatchNotificationEmails({
    userIds: unique,
    type: input.type,
    title: input.title,
    body: input.body,
    link: input.link,
    cutoff,
  })
}

export async function listNotifications(
  userId: string,
  query: { page: number; limit: number; unreadOnly?: boolean },
) {
  const where: Prisma.NotificationWhereInput = {
    userId,
    ...(query.unreadOnly ? { readAt: null } : {}),
  }

  const [items, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...toSkipTake(query),
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ])

  return { items, meta: { ...buildMeta(query, total), unreadCount } }
}

export async function markRead(userId: string, notificationId: string) {
  const result = await prisma.notification.updateMany({
    where: { id: notificationId, userId, readAt: null },
    data: { readAt: new Date() },
  })
  if (result.count === 0) {
    const exists = await prisma.notification.findFirst({
      where: { id: notificationId, userId },
      select: { id: true },
    })
    if (!exists) throw new NotFoundError('Notification')
  }
  return prisma.notification.findUnique({ where: { id: notificationId } })
}

export async function markAllRead(userId: string): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  })
  return result.count
}

export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } })
}
