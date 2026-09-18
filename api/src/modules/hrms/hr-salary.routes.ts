import { Router } from 'express'
import { param } from '../../lib/http.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { hrAuthenticate, requireHrRole, HR_ADMIN_ROLES } from './hr-auth.middleware.js'
import { recordHrAudit } from '../../lib/hrms/hr-audit.js'
import * as service from './hr-salary.service.js'
import {
  employeeIdParam,
  employeeSubResourceParam,
  financialYearQuery,
  upsertSalaryStructureSchema,
  createOldSalarySchema,
  createMonthlyIncentiveSchema,
  type UpsertSalaryStructureInput,
} from './hr-salary.schema.js'

/**
 * Salary Details — mounted at `/hrms/employees/:id/...` alongside
 * `hr-employees.routes.ts`'s own router (Express tries both in registration
 * order). ADMIN-only for now: the Employee Portal's own read-only "Salary
 * details" view is a follow-up once that portal's pages are built, and it
 * will need an ownership check (self OR admin) rather than reusing this
 * router's blanket admin gate.
 */
export const hrSalaryRouter = Router()

hrSalaryRouter.use(hrAuthenticate, requireHrRole(...HR_ADMIN_ROLES))

hrSalaryRouter.get(
  '/:id/salary-structure',
  validate({ params: employeeIdParam, query: financialYearQuery }),
  async (req, res) => {
    const { financialYear } = validatedQuery<{ financialYear: string }>(res)
    res.json({ data: await service.getSalaryStructure(param(req, 'id'), financialYear) })
  },
)

hrSalaryRouter.put(
  '/:id/salary-structure',
  validate({ params: employeeIdParam, body: upsertSalaryStructureSchema }),
  async (req, res) => {
    const input = req.body as UpsertSalaryStructureInput
    const structure = await service.upsertSalaryStructure(param(req, 'id'), input)
    await recordHrAudit({
      req,
      action: 'hr.salary_structure.upserted',
      entityType: 'HrSalaryStructure',
      entityId: param(req, 'id'),
      after: { financialYear: input.financialYear },
    })
    res.json({ data: structure })
  },
)

hrSalaryRouter.get('/:id/old-salaries', validate({ params: employeeIdParam }), async (req, res) => {
  res.json({ data: await service.listOldSalaries(param(req, 'id')) })
})

hrSalaryRouter.post(
  '/:id/old-salaries',
  validate({ params: employeeIdParam, body: createOldSalarySchema }),
  async (req, res) => {
    const created = await service.createOldSalary(param(req, 'id'), req.body)
    await recordHrAudit({
      req,
      action: 'hr.old_salary.created',
      entityType: 'HrOldSalary',
      entityId: created.id,
    })
    res.status(201).json({ data: created })
  },
)

hrSalaryRouter.delete(
  '/:id/old-salaries/:subId',
  validate({ params: employeeSubResourceParam }),
  async (req, res) => {
    await service.deleteOldSalary(param(req, 'id'), param(req, 'subId'))
    await recordHrAudit({
      req,
      action: 'hr.old_salary.deleted',
      entityType: 'HrOldSalary',
      entityId: param(req, 'subId'),
    })
    res.status(204).end()
  },
)

hrSalaryRouter.get(
  '/:id/monthly-incentives',
  validate({ params: employeeIdParam, query: financialYearQuery }),
  async (req, res) => {
    const { financialYear } = validatedQuery<{ financialYear: string }>(res)
    res.json({ data: await service.listMonthlyIncentives(param(req, 'id'), financialYear) })
  },
)

hrSalaryRouter.post(
  '/:id/monthly-incentives',
  validate({ params: employeeIdParam, body: createMonthlyIncentiveSchema }),
  async (req, res) => {
    const created = await service.createMonthlyIncentive(param(req, 'id'), req.body)
    await recordHrAudit({
      req,
      action: 'hr.monthly_incentive.created',
      entityType: 'HrMonthlyIncentive',
      entityId: created.id,
    })
    res.status(201).json({ data: created })
  },
)

hrSalaryRouter.delete(
  '/:id/monthly-incentives/:subId',
  validate({ params: employeeSubResourceParam }),
  async (req, res) => {
    await service.deleteMonthlyIncentive(param(req, 'id'), param(req, 'subId'))
    await recordHrAudit({
      req,
      action: 'hr.monthly_incentive.deleted',
      entityType: 'HrMonthlyIncentive',
      entityId: param(req, 'subId'),
    })
    res.status(204).end()
  },
)
