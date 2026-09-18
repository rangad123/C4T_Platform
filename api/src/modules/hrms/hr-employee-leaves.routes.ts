import { Router } from 'express'
import { param } from '../../lib/http.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { hrAuthenticate, requireHrRole, HR_ADMIN_ROLES } from './hr-auth.middleware.js'
import { recordHrAudit } from '../../lib/hrms/hr-audit.js'
import * as service from './hr-leaves.service.js'
import {
  employeeIdParam,
  employeeLeaveRequestParam,
  financialYearQuery,
  decideLeaveRequestSchema,
  type FinancialYearQuery,
} from './hr-leaves.schema.js'

/**
 * The ADMIN side of Leaves — viewing a specific employee's balance/history
 * and deciding their pending requests, from that employee's own detail
 * page. Mirrors hr-salary.routes.ts's "mounted alongside hr-employees.routes.ts
 * at /hrms/employees" pattern; the employee's OWN apply/cancel routes live
 * in hr-leaves.routes.ts instead, since those act on the caller, not on a
 * `:id` param.
 */
export const hrEmployeeLeavesRouter = Router()

hrEmployeeLeavesRouter.use(hrAuthenticate, requireHrRole(...HR_ADMIN_ROLES))

hrEmployeeLeavesRouter.get(
  '/:id/leaves/balances',
  validate({ params: employeeIdParam, query: financialYearQuery }),
  async (req, res) => {
    const { financialYear } = validatedQuery<FinancialYearQuery>(res)
    res.json({ data: await service.getBalances(param(req, 'id'), financialYear) })
  },
)

hrEmployeeLeavesRouter.get(
  '/:id/leaves/requests',
  validate({ params: employeeIdParam }),
  async (req, res) => {
    res.json({ data: await service.listRequests(param(req, 'id')) })
  },
)

hrEmployeeLeavesRouter.post(
  '/:id/leaves/requests/:reqId/decide',
  validate({ params: employeeLeaveRequestParam, body: decideLeaveRequestSchema }),
  async (req, res) => {
    const request = await service.decideLeaveRequest(
      param(req, 'id'),
      param(req, 'reqId'),
      req.hrEmployee!.id,
      req.body.status,
    )
    await recordHrAudit({
      req,
      action: 'hr.leave_request.decided',
      entityType: 'HrLeaveRequest',
      entityId: request.id,
      after: { status: request.status },
    })
    res.json({ data: request })
  },
)
