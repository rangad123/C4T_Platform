import { Router } from 'express'
import { param } from '../../lib/http.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { hrAuthenticate, requireHrRole, HR_ADMIN_ROLES } from './hr-auth.middleware.js'
import { recordHrAudit } from '../../lib/hrms/hr-audit.js'
import * as service from './hr-leaves.service.js'
import {
  listAllLeaveRequestsQuery,
  type ListAllLeaveRequestsQuery,
  financialYearQuery,
  createLeaveRequestSchema,
  leaveRequestIdParam,
  type CreateLeaveRequestInput,
  type FinancialYearQuery,
} from './hr-leaves.schema.js'

/**
 * Leaves — self-service. Unlike the compensation modules, every employee
 * (not just ADMIN) genuinely needs to reach this: applying for leave is an
 * employee-initiated action, so gating the whole router to ADMIN would make
 * the feature not work at all. Every route acts on `req.hrEmployee.id` —
 * there is no `:id` param here, matching `/hrms/auth/me`'s own shape.
 */
export const hrLeavesRouter = Router()

hrLeavesRouter.use(hrAuthenticate)

/**
 * The one admin-only route in this otherwise self-service router: every
 * employee's requests, for the Leaves screen. Declared before anything with a
 * path parameter so it is never read as an id, and gated on its own because
 * `hrAuthenticate` above only proves someone is signed in.
 */
hrLeavesRouter.get(
  '/all',
  requireHrRole(...HR_ADMIN_ROLES),
  validate({ query: listAllLeaveRequestsQuery }),
  async (_req, res) => {
    const query = validatedQuery<ListAllLeaveRequestsQuery>(res)
    const { items, meta } = await service.listAllRequests(query)
    res.json({ data: items, meta })
  },
)

hrLeavesRouter.get('/balances', validate({ query: financialYearQuery }), async (req, res) => {
  const { financialYear } = validatedQuery<FinancialYearQuery>(res)
  res.json({ data: await service.getBalances(req.hrEmployee!.id, financialYear) })
})

hrLeavesRouter.get('/requests', async (req, res) => {
  res.json({ data: await service.listRequests(req.hrEmployee!.id) })
})

hrLeavesRouter.post('/requests', validate({ body: createLeaveRequestSchema }), async (req, res) => {
  const input = req.body as CreateLeaveRequestInput
  const request = await service.createLeaveRequest(req.hrEmployee!.id, input)
  await recordHrAudit({
    req,
    action: 'hr.leave_request.created',
    entityType: 'HrLeaveRequest',
    entityId: request.id,
  })
  res.status(201).json({ data: request })
})

hrLeavesRouter.post(
  '/requests/:id/cancel',
  validate({ params: leaveRequestIdParam }),
  async (req, res) => {
    const request = await service.cancelLeaveRequest(req.hrEmployee!.id, param(req, 'id'))
    await recordHrAudit({
      req,
      action: 'hr.leave_request.cancelled',
      entityType: 'HrLeaveRequest',
      entityId: request.id,
    })
    res.json({ data: request })
  },
)
