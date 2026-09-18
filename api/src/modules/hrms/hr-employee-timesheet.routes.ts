import { Router } from 'express'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { hrAuthenticate, requireHrRole, HR_ADMIN_ROLES } from './hr-auth.middleware.js'
import * as service from './hr-timesheet.service.js'
import {
  employeeIdParam,
  financialYearMonthQuery,
  type FinancialYearMonthQuery,
} from './hr-timesheet.schema.js'
import { param } from '../../lib/http.js'

/** The ADMIN read-only view of a specific employee's timesheet — no write routes: timesheets are self-logged. */
export const hrEmployeeTimesheetRouter = Router()

hrEmployeeTimesheetRouter.use(hrAuthenticate, requireHrRole(...HR_ADMIN_ROLES))

hrEmployeeTimesheetRouter.get(
  '/:id/timesheet/entries',
  validate({ params: employeeIdParam, query: financialYearMonthQuery }),
  async (req, res) => {
    const { financialYear, month } = validatedQuery<FinancialYearMonthQuery>(res)
    res.json({ data: await service.listEntries(param(req, 'id'), financialYear, month) })
  },
)

hrEmployeeTimesheetRouter.get(
  '/:id/timesheet/summary',
  validate({ params: employeeIdParam, query: financialYearMonthQuery }),
  async (req, res) => {
    const { financialYear, month } = validatedQuery<FinancialYearMonthQuery>(res)
    res.json({ data: await service.getMonthSummary(param(req, 'id'), financialYear, month) })
  },
)
