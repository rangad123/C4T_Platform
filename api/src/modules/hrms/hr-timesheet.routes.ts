import { Router } from 'express'
import { param } from '../../lib/http.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { hrAuthenticate } from './hr-auth.middleware.js'
import { recordHrAudit } from '../../lib/hrms/hr-audit.js'
import * as service from './hr-timesheet.service.js'
import {
  financialYearMonthQuery,
  upsertTimesheetEntrySchema,
  entryIdParam,
  type FinancialYearMonthQuery,
} from './hr-timesheet.schema.js'

/** Timesheet — self-service, same "acts on the caller" shape as hr-leaves.routes.ts. */
export const hrTimesheetRouter = Router()

hrTimesheetRouter.use(hrAuthenticate)

hrTimesheetRouter.get(
  '/entries',
  validate({ query: financialYearMonthQuery }),
  async (req, res) => {
    const { financialYear, month } = validatedQuery<FinancialYearMonthQuery>(res)
    res.json({ data: await service.listEntries(req.hrEmployee!.id, financialYear, month) })
  },
)

hrTimesheetRouter.put(
  '/entries',
  validate({ body: upsertTimesheetEntrySchema }),
  async (req, res) => {
    const entry = await service.upsertEntry(req.hrEmployee!.id, req.body)
    await recordHrAudit({
      req,
      action: 'hr.timesheet_entry.upserted',
      entityType: 'HrTimesheetEntry',
      entityId: entry.id,
    })
    res.json({ data: entry })
  },
)

hrTimesheetRouter.delete('/entries/:id', validate({ params: entryIdParam }), async (req, res) => {
  await service.deleteEntry(req.hrEmployee!.id, param(req, 'id'))
  await recordHrAudit({
    req,
    action: 'hr.timesheet_entry.deleted',
    entityType: 'HrTimesheetEntry',
    entityId: param(req, 'id'),
  })
  res.status(204).end()
})

hrTimesheetRouter.get(
  '/summary',
  validate({ query: financialYearMonthQuery }),
  async (req, res) => {
    const { financialYear, month } = validatedQuery<FinancialYearMonthQuery>(res)
    res.json({ data: await service.getMonthSummary(req.hrEmployee!.id, financialYear, month) })
  },
)
