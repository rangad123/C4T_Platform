import { Router } from 'express'
import { param } from '../../lib/http.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { hrAuthenticate, requireHrRole, HR_ADMIN_ROLES } from './hr-auth.middleware.js'
import { recordHrAudit } from '../../lib/hrms/hr-audit.js'
import * as service from './hr-tax.service.js'
import {
  employeeIdParam,
  financialYearQuery,
  upsertTaxSlabSchema,
  taxSlabIdParam,
} from './hr-tax.schema.js'

/**
 * Tax slab admin config (`/hrms/tax-slabs`) and the per-employee computed
 * calculation (`/hrms/employees/:id/tax-calculation`). ADMIN-only for now —
 * same follow-up note as hr-salary.routes.ts about the Employee Portal's
 * own read-only view.
 */
export const hrTaxRouter = Router()
export const hrEmployeeTaxRouter = Router()

hrTaxRouter.use(hrAuthenticate, requireHrRole(...HR_ADMIN_ROLES))
hrEmployeeTaxRouter.use(hrAuthenticate, requireHrRole(...HR_ADMIN_ROLES))

hrTaxRouter.get('/', async (req, res) => {
  const financialYear =
    typeof req.query.financialYear === 'string' ? req.query.financialYear : undefined
  res.json({ data: await service.listTaxSlabs(financialYear) })
})

hrTaxRouter.put('/', validate({ body: upsertTaxSlabSchema }), async (req, res) => {
  const slab = await service.upsertTaxSlab(req.body)
  await recordHrAudit({
    req,
    action: 'hr.tax_slab.upserted',
    entityType: 'HrTaxSlab',
    entityId: slab.id,
    after: { financialYear: slab.financialYear, regime: slab.regime },
  })
  res.json({ data: slab })
})

hrTaxRouter.delete('/:id', validate({ params: taxSlabIdParam }), async (req, res) => {
  await service.deleteTaxSlab(param(req, 'id'))
  await recordHrAudit({
    req,
    action: 'hr.tax_slab.deleted',
    entityType: 'HrTaxSlab',
    entityId: param(req, 'id'),
  })
  res.status(204).end()
})

hrEmployeeTaxRouter.get(
  '/:id/tax-calculation',
  validate({ params: employeeIdParam, query: financialYearQuery }),
  async (req, res) => {
    const { financialYear } = validatedQuery<{ financialYear: string }>(res)
    res.json({ data: await service.computeEmployeeTax(param(req, 'id'), financialYear) })
  },
)
