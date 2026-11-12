import { Router } from 'express'
import type { RequestHandler } from 'express'
import { param } from '../../lib/http.js'
import { z } from 'zod'
import { authenticate } from '../../middleware/authenticate.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { paginationQuery } from '../../lib/pagination.js'
import * as service from './notifications.service.js'
import { verifyUnsubscribeToken } from '../../lib/email/unsubscribe.js'
import { prisma } from '../../lib/prisma.js'
import { UnauthorizedError } from '../../lib/errors.js'
import { NotificationType } from '@prisma/client'

export const notificationsRouter = Router()

/**
 * One-click unsubscribe. Registered BEFORE `authenticate` on purpose: it is
 * followed from a mail client, which holds no session and — for the
 * `List-Unsubscribe-Post` form of it — is a machine pressing the link on the
 * recipient's behalf with no browser involved at all.
 *
 * The signed token is the credential. It says which user and nothing else: it
 * reads nothing, and the only write it authorises is this one flag. `enable`
 * lets the same link put the emails back on — someone who unsubscribes by
 * mistake, or from a mail client's own button, needs a way back that does not
 * begin with "sign in", and a token that only ever appears in that person's
 * own inbox is what they have to hand.
 *
 * Both verbs are accepted: a GET here is a person following a link, a POST is
 * Gmail's unsubscribe button pressing it for them.
 */
const unsubscribe: RequestHandler = async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : ''
  const userId = verifyUnsubscribeToken(token)
  if (!userId) throw new UnauthorizedError('That unsubscribe link is not valid')

  const emailNotifications = req.query.enable === 'true'

  await prisma.user.updateMany({
    where: { id: userId, deletedAt: null },
    data: { emailNotifications },
  })

  res.json({ data: { emailNotifications } })
}

notificationsRouter.get('/unsubscribe', unsubscribe)
notificationsRouter.post('/unsubscribe', unsubscribe)

notificationsRouter.use(authenticate)

const listQuery = paginationQuery.extend({
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
})

notificationsRouter.get('/', validate({ query: listQuery }), async (req, res) => {
  const query = validatedQuery<z.infer<typeof listQuery>>(res)
  const { items, meta } = await service.listNotifications(req.user!.id, query)
  res.json({ data: items, meta })
})

notificationsRouter.get('/unread-count', async (req, res) => {
  res.json({ data: { unreadCount: await service.unreadCount(req.user!.id) } })
})

notificationsRouter.post(
  '/:id/read',
  validate({ params: z.object({ id: z.string().cuid() }) }),
  async (req, res) => {
    res.json({ data: await service.markRead(req.user!.id, param(req, 'id')) })
  },
)

notificationsRouter.post('/read-all', async (req, res) => {
  res.json({ data: { marked: await service.markAllRead(req.user!.id) } })
})

/**
 * The account-settings toggle behind the same flag the unsubscribe link
 * clears, plus the per-type choices (in the app, by email). Read and write,
 * so the settings page can show the current state rather than a checkbox that
 * always starts checked. Essential types are listed but locked on.
 */
async function readPreferences(userId: string) {
  const [user, rows] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { emailNotifications: true } }),
    prisma.notificationPreference.findMany({ where: { userId } }),
  ])
  const byType = new Map(rows.map((row) => [row.type, row]))
  return {
    emailNotifications: user?.emailNotifications ?? true,
    types: Object.values(NotificationType).map((type) => {
      const essential = service.isEssential(type)
      const row = byType.get(type)
      return {
        type,
        essential,
        inApp: essential || (row?.inApp ?? true),
        email: essential || (row?.email ?? true),
      }
    }),
  }
}

notificationsRouter.get('/preferences', async (req, res) => {
  res.json({ data: await readPreferences(req.user!.id) })
})

const preferencesSchema = z
  .object({
    emailNotifications: z.boolean().optional(),
    types: z
      .array(
        z
          .object({ type: z.nativeEnum(NotificationType), inApp: z.boolean(), email: z.boolean() })
          .strict(),
      )
      .max(Object.values(NotificationType).length)
      .optional(),
  })
  .strict()
  .refine((d) => d.emailNotifications !== undefined || d.types !== undefined, {
    message: 'Nothing to change',
  })

notificationsRouter.patch(
  '/preferences',
  validate({ body: preferencesSchema }),
  async (req, res) => {
    const input = req.body as z.infer<typeof preferencesSchema>
    const userId = req.user!.id
    if (input.emailNotifications !== undefined) {
      await prisma.user.update({
        where: { id: userId },
        data: { emailNotifications: input.emailNotifications },
      })
    }
    // Essential types are not stored: they cannot be turned off.
    const choices = (input.types ?? []).filter((t) => !service.isEssential(t.type))
    if (choices.length > 0) {
      await prisma.$transaction(
        choices.map((t) =>
          prisma.notificationPreference.upsert({
            where: { userId_type: { userId, type: t.type } },
            create: { userId, type: t.type, inApp: t.inApp, email: t.email },
            update: { inApp: t.inApp, email: t.email },
          }),
        ),
      )
    }
    res.json({ data: await readPreferences(userId) })
  },
)
