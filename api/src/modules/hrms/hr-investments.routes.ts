import { Router } from 'express'
import { param } from '../../lib/http.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { hrAuthenticate, requireHrRole, HR_ADMIN_ROLES } from './hr-auth.middleware.js'
import { recordHrAudit } from '../../lib/hrms/hr-audit.js'
import * as service from './hr-investments.service.js'
import { calculateMonthlyTds } from './hr-tax.service.js'
import {
  employeeIdParam,
  employeeSubResourceParam,
  financialYearQuery,
  createDeclarationSchema,
  updateDeclarationSchema,
  verifyDeclarationSchema,
  createMonthlyDeductionSchema,
  calculateTdsSchema,
} from './hr-investments.schema.js'

/**
 * Investments — declarations (employee side, admin-entered for now) and
 * monthly TDS already deducted. ADMIN-only, same follow-up note as
 * hr-salary.routes.ts.
 */
export const hrInvestmentsRouter = Router()

hrInvestmentsRouter.use(hrAuthenticate, requireHrRole(...HR_ADMIN_ROLES))

hrInvestmentsRouter.get(
  '/:id/investment-declarations',
  validate({ params: employeeIdParam, query: financialYearQuery }),
  async (req, res) => {
    const { financialYear } = validatedQuery<{ financialYear: string }>(res)
    res.json({ data: await service.listDeclarations(param(req, 'id'), financialYear) })
  },
)

hrInvestmentsRouter.post(
  '/:id/investment-declarations',
  validate({ params: employeeIdParam, body: createDeclarationSchema }),
  async (req, res) => {
    const created = await service.createDeclaration(param(req, 'id'), req.body)
    await recordHrAudit({
      req,
      action: 'hr.investment_declaration.created',
      entityType: 'HrInvestmentDeclaration',
      entityId: created.id,
    })
    res.status(201).json({ data: created })
  },
)

hrInvestmentsRouter.patch(
  '/:id/investment-declarations/:subId',
  validate({ params: employeeSubResourceParam, body: updateDeclarationSchema }),
  async (req, res) => {
    const updated = await service.updateDeclaration(param(req, 'id'), param(req, 'subId'), req.body)
    await recordHrAudit({
      req,
      action: 'hr.investment_declaration.updated',
      entityType: 'HrInvestmentDeclaration',
      entityId: param(req, 'subId'),
    })
    res.json({ data: updated })
  },
)

hrInvestmentsRouter.post(
  '/:id/investment-declarations/:subId/verify',
  validate({ params: employeeSubResourceParam, body: verifyDeclarationSchema }),
  async (req, res) => {
    const verified = await service.verifyDeclaration(
      param(req, 'id'),
      param(req, 'subId'),
      req.hrEmployee!.id,
      req.body.verifiedAmount,
    )
    await recordHrAudit({
      req,
      action: 'hr.investment_declaration.verified',
      entityType: 'HrInvestmentDeclaration',
      entityId: param(req, 'subId'),
      after: { verifiedAmount: req.body.verifiedAmount },
    })
    res.json({ data: verified })
  },
)

hrInvestmentsRouter.delete(
  '/:id/investment-declarations/:subId',
  validate({ params: employeeSubResourceParam }),
  async (req, res) => {
    await service.deleteDeclaration(param(req, 'id'), param(req, 'subId'))
    await recordHrAudit({
      req,
      action: 'hr.investment_declaration.deleted',
      entityType: 'HrInvestmentDeclaration',
      entityId: param(req, 'subId'),
    })
    res.status(204).end()
  },
)

hrInvestmentsRouter.get(
  '/:id/monthly-tax-deductions',
  validate({ params: employeeIdParam, query: financialYearQuery }),
  async (req, res) => {
    const { financialYear } = validatedQuery<{ financialYear: string }>(res)
    res.json({ data: await service.listMonthlyDeductions(param(req, 'id'), financialYear) })
  },
)

hrInvestmentsRouter.post(
  '/:id/monthly-tax-deductions',
  validate({ params: employeeIdParam, body: createMonthlyDeductionSchema }),
  async (req, res) => {
    const upserted = await service.upsertMonthlyDeduction(param(req, 'id'), req.body)
    await recordHrAudit({
      req,
      action: 'hr.monthly_tax_deduction.upserted',
      entityType: 'HrMonthlyTaxDeduction',
      entityId: upserted.id,
    })
    res.status(201).json({ data: upserted })
  },
)

/**
 * Declared before the `/:subId` route below so "calculate" is never read as an
 * id. POST, because it writes.
 */
hrInvestmentsRouter.post(
  '/:id/monthly-tax-deductions/calculate',
  validate({ params: employeeIdParam, body: calculateTdsSchema }),
  async (req, res) => {
    const { financialYear, month } = req.body as { financialYear: string; month: number }
    const result = await calculateMonthlyTds(param(req, 'id'), financialYear, month)
    await recordHrAudit({
      req,
      action: 'hr.monthly_tax_deduction.calculated',
      entityType: 'HrMonthlyTaxDeduction',
      entityId: param(req, 'id'),
      after: { financialYear, throughMonth: month, created: result.created },
    })
    res.json({ data: result })
  },
)

hrInvestmentsRouter.delete(
  '/:id/monthly-tax-deductions/:subId',
  validate({ params: employeeSubResourceParam }),
  async (req, res) => {
    await service.deleteMonthlyDeduction(param(req, 'id'), param(req, 'subId'))
    await recordHrAudit({
      req,
      action: 'hr.monthly_tax_deduction.deleted',
      entityType: 'HrMonthlyTaxDeduction',
      entityId: param(req, 'subId'),
    })
    res.status(204).end()
  },
)
