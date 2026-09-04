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
 * clears. Read and write, so the settings page can show the current state
 * rather than a checkbox that always starts checked.
 */
notificationsRouter.get('/preferences', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { emailNotifications: true },
  })
  res.json({ data: { emailNotifications: user?.emailNotifications ?? true } })
})

const preferencesSchema = z.object({ emailNotifications: z.boolean() }).strict()

notificationsRouter.patch(
  '/preferences',
  validate({ body: preferencesSchema }),
  async (req, res) => {
    const input = req.body as z.infer<typeof preferencesSchema>
    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: { emailNotifications: input.emailNotifications },
      select: { emailNotifications: true },
    })
    res.json({ data: updated })
  },
)
