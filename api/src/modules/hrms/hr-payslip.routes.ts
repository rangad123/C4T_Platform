import { Router } from 'express'
import { param } from '../../lib/http.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { hrAuthenticate, requireHrRole, HR_ADMIN_ROLES } from './hr-auth.middleware.js'
import { recordHrAudit } from '../../lib/hrms/hr-audit.js'
import * as service from './hr-payslip.service.js'
import {
  employeeIdParam,
  generatePayslipSchema,
  payslipQuery,
  type GeneratePayslipInput,
} from './hr-payslip.schema.js'

/**
 * Payslip generate/list/get — ADMIN-only for now, same follow-up note as
 * hr-salary.routes.ts about the Employee Portal's own read-only view.
 */
export const hrPayslipRouter = Router()

hrPayslipRouter.use(hrAuthenticate, requireHrRole(...HR_ADMIN_ROLES))

hrPayslipRouter.get('/:id/payslips', validate({ params: employeeIdParam }), async (req, res) => {
  res.json({ data: await service.listPayslips(param(req, 'id')) })
})

hrPayslipRouter.get(
  '/:id/payslips/one',
  validate({ params: employeeIdParam, query: payslipQuery }),
  async (req, res) => {
    const { financialYear, month } = validatedQuery<GeneratePayslipInput>(res)
    res.json({ data: await service.getPayslip(param(req, 'id'), financialYear, month) })
  },
)

hrPayslipRouter.post(
  '/:id/payslips',
  validate({ params: employeeIdParam, body: generatePayslipSchema }),
  async (req, res) => {
    const { financialYear, month } = req.body as GeneratePayslipInput
    const payslip = await service.generatePayslip(
      param(req, 'id'),
      financialYear,
      month,
      req.hrEmployee!.id,
    )
    await recordHrAudit({
      req,
      action: 'hr.payslip.generated',
      entityType: 'HrPayslip',
      entityId: payslip.id,
      after: { financialYear, month },
    })
    res.status(201).json({ data: payslip })
  },
)

/**
 * Cross-employee payslip endpoints, under `/payslips` rather than
 * `/employees/...`: a one-segment path there would be read as an employee id by
 * the employees router, which is mounted first.
 */
export const hrPayslipRunRouter = Router()

hrPayslipRunRouter.use(hrAuthenticate, requireHrRole(...HR_ADMIN_ROLES))

hrPayslipRunRouter.get('/run', validate({ query: payslipQuery }), async (_req, res) => {
  const { financialYear, month } = validatedQuery<GeneratePayslipInput>(res)
  res.json({ data: await service.previewPayslipRun(financialYear, month) })
})
