import { Router } from 'express'
import { z } from 'zod'
import { param } from '../../lib/http.js'
import { recordAudit } from '../../lib/audit.js'
import { authenticate } from '../../middleware/authenticate.js'
import { validate } from '../../middleware/validate.js'
import * as service from './bug-tracker.service.js'

/**
 * Bug tracker export (Jira Cloud). Authorisation is relationship-based and
 * made in the service: an organisation's owners and the platform side manage
 * the connection; the customer and the platform side export; testers never.
 */
export const bugTrackerRouter = Router()

bugTrackerRouter.use(authenticate)

const cuid = z.string().cuid()
const orgParam = z.object({ orgId: cuid })
const bugParam = z.object({ bugId: cuid })

const connectionBody = z.object({
  siteUrl: z.string().trim().min(1).max(200),
  accountEmail: z.string().trim().email().max(254),
  projectKey: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9_]{0,19}$/, 'Project key is letters and digits, starting with a letter'),
  issueType: z.string().trim().min(1).max(60).default('Bug'),
  apiToken: z.string().trim().min(8).max(500).optional(),
})

bugTrackerRouter.get('/organisations/:orgId', validate({ params: orgParam }), async (req, res) => {
  res.json({ data: await service.getConnection(req.user!, param(req, 'orgId')) })
})

bugTrackerRouter.put(
  '/organisations/:orgId',
  validate({ params: orgParam, body: connectionBody }),
  async (req, res) => {
    const orgId = param(req, 'orgId')
    const data = await service.saveConnection(req.user!, orgId, req.body)
    await recordAudit({
      req,
      action: 'bug_tracker.connection_saved',
      entityType: 'Organisation',
      entityId: orgId,
      // Never the token.
      after: {
        siteUrl: data.siteUrl,
        projectKey: data.projectKey,
        tokenChanged: Boolean(req.body.apiToken),
      },
    })
    res.json({ data })
  },
)

bugTrackerRouter.delete(
  '/organisations/:orgId',
  validate({ params: orgParam }),
  async (req, res) => {
    const orgId = param(req, 'orgId')
    await service.deleteConnection(req.user!, orgId)
    await recordAudit({
      req,
      action: 'bug_tracker.connection_removed',
      entityType: 'Organisation',
      entityId: orgId,
    })
    res.status(204).end()
  },
)

bugTrackerRouter.post(
  '/organisations/:orgId/test',
  validate({ params: orgParam }),
  async (req, res) => {
    res.json({ data: await service.testConnection(req.user!, param(req, 'orgId')) })
  },
)

bugTrackerRouter.get('/bugs/:bugId', validate({ params: bugParam }), async (req, res) => {
  res.json({ data: await service.getBugExport(req.user!, param(req, 'bugId')) })
})

bugTrackerRouter.post('/bugs/:bugId/export', validate({ params: bugParam }), async (req, res) => {
  const bugId = param(req, 'bugId')
  const data = await service.exportBug(req.user!, bugId)
  await recordAudit({
    req,
    action: 'bug.exported',
    entityType: 'Bug',
    entityId: bugId,
    after: { key: data.key },
  })
  res.status(201).json({ data })
})

bugTrackerRouter.post(
  '/bugs/bulk-export',
  validate({ body: z.object({ ids: z.array(cuid).min(1).max(50) }) }),
  async (req, res) => {
    const data = await service.bulkExport(req.user!, req.body.ids)
    await recordAudit({
      req,
      action: 'bug.bulk_exported',
      entityType: 'Bug',
      after: { exported: data.exported.map((e) => e.key), skipped: data.skipped.length },
    })
    res.json({ data })
  },
)
