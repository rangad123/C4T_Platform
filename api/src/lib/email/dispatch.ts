import type { NotificationType } from '@prisma/client'
import { UserStatus } from '@prisma/client'
import { env } from '../../config/env.js'
import { prisma } from '../prisma.js'
import { logger } from '../logger.js'
import { sendMail } from '../mailer.js'
import { renderEmail } from './layout.js'
import { EMAIL_POLICY, EMAIL_REASON } from './policy.js'
import { unsubscribeToken, unsubscribeUrl } from './unsubscribe.js'

/**
 * Turns notifications into email.
 *
 * ── DETACHED ON PURPOSE
 *
 * `dispatchNotificationEmails` returns void and is never awaited. Publishing
 * an announcement to every tester raises hundreds of notifications; if the
 * mail went out inside the request, the admin who pressed "Publish" would
 * watch a spinner for the length of an SMTP conversation per recipient, and a
 * provider hiccup would surface as a failed publish for an announcement that
 * was, in fact, published. The notification rows are the record. Email is a
 * best-effort nudge on top of them and is logged, not reported.
 *
 * ── AND RATE-LIMITED
 *
 * SES and every comparable provider cap sends per second and will start
 * refusing over the limit. `CONCURRENCY` keeps a fan-out to a large audience
 * inside a sane envelope; the work simply takes longer, which is free, because
 * nothing is waiting on it.
 */
const CONCURRENCY = 5

export interface NotificationEmailInput {
  userIds: string[]
  type: NotificationType
  title: string
  body?: string | null
  link?: string | null
  /**
   * Captured immediately BEFORE the notification rows were written.
   *
   * The throttle asks "did this person already have an unread nudge of this
   * kind?", and the notification we are emailing about is itself unread by
   * definition — so it has to be excluded, and a timestamp from before the
   * write is what separates it from the earlier ones.
   */
  cutoff: Date
}

/** An absolute URL for a link stored as an app-relative path. */
function absolute(link: string): string {
  if (/^https?:\/\//i.test(link)) return link
  return `${env.WEB_PUBLIC_URL}${link.startsWith('/') ? '' : '/'}${link}`
}

async function recipientsFor(input: NotificationEmailInput, essential: boolean) {
  const users = await prisma.user.findMany({
    where: {
      id: { in: input.userIds },
      deletedAt: null,
      // A deactivated or still-unverified account gets no mail: the first has
      // asked to be left alone, and the second has not yet proved the address
      // belongs to them, which is the one thing we must not assume.
      status: UserStatus.ACTIVE,
      ...(essential ? {} : { emailNotifications: true }),
    },
    select: { id: true, email: true, firstName: true },
  })
  return users
}

/**
 * Recipients who already had an unread notification of this type and link
 * before the current one landed — see `EmailPolicy.throttle`.
 */
async function alreadyNudged(input: NotificationEmailInput): Promise<Set<string>> {
  if (!input.link) return new Set()
  const rows = await prisma.notification.findMany({
    where: {
      userId: { in: input.userIds },
      type: input.type,
      link: input.link,
      readAt: null,
      createdAt: { lt: input.cutoff },
    },
    select: { userId: true },
    distinct: ['userId'],
  })
  return new Set(rows.map((row) => row.userId))
}

async function run(input: NotificationEmailInput): Promise<void> {
  const policy = EMAIL_POLICY[input.type]
  if (!policy) return
  if (input.userIds.length === 0) return

  const [users, muted] = await Promise.all([
    recipientsFor(input, policy.essential === true),
    policy.throttle ? alreadyNudged(input) : Promise.resolve(new Set<string>()),
  ])

  const targets = users.filter((user) => !muted.has(user.id))
  if (targets.length === 0) return

  const url = input.link ? absolute(input.link) : null
  /* An explicit length test, not `??`: a body of "   " trims to "" — which is
     not nullish, so nullish-coalescing would quote an empty block. */
  const trimmed = input.body?.trim()
  const body = trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const chunk = targets.slice(i, i + CONCURRENCY)
    await Promise.all(
      chunk.map(async (user) => {
        const greeting = user.firstName?.trim()
        /* Essential mail ignores the preference, so offering to turn it off
           here would be an offer we do not honour. */
        const optOut = policy.essential ? undefined : unsubscribeUrl(user.id)

        const { html, text } = renderEmail(
          {
            heading: input.title,
            paragraphs: greeting ? [`Hi ${greeting},`] : [],
            quote: body,
            ...(url ? { action: { label: policy.action, url } } : {}),
          },
          { reason: EMAIL_REASON, unsubscribeUrl: optOut },
        )

        await sendMail({
          to: user.email,
          subject: input.title,
          text,
          html,
          ...(optOut ? { unsubscribeToken: unsubscribeToken(user.id) } : {}),
        })
      }),
    )
  }
}

/** Fire-and-forget. See the note at the top of this file. */
export function dispatchNotificationEmails(input: NotificationEmailInput): void {
  void run(input).catch((error: unknown) => {
    logger.error(
      { err: error, type: input.type, count: input.userIds.length },
      'Notification email dispatch failed',
    )
  })
}
