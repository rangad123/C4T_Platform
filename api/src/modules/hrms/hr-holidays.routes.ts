import { Router } from 'express'
import { param } from '../../lib/http.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { hrAuthenticate, requireHrRole, HR_ADMIN_ROLES } from './hr-auth.middleware.js'
import { recordHrAudit } from '../../lib/hrms/hr-audit.js'
import * as service from './hr-holidays.service.js'
import {
  createHolidaySchema,
  yearQuery,
  holidayIdParam,
  type YearQuery,
} from './hr-holidays.schema.js'

/**
 * Holidays — reads open to any signed-in HR employee (both portals list
 * "Holidays list" in their own sidebar); writes ADMIN-only.
 */
export const hrHolidaysRouter = Router()

hrHolidaysRouter.use(hrAuthenticate)

hrHolidaysRouter.get('/', validate({ query: yearQuery }), async (req, res) => {
  const { year } = validatedQuery<YearQuery>(res)
  res.json({ data: await service.listHolidays(year) })
})

hrHolidaysRouter.post(
  '/',
  requireHrRole(...HR_ADMIN_ROLES),
  validate({ body: createHolidaySchema }),
  async (req, res) => {
    const holiday = await service.createHoliday(req.body)
    await recordHrAudit({
      req,
      action: 'hr.holiday.created',
      entityType: 'HrHoliday',
      entityId: holiday.id,
      after: { date: holiday.date, name: holiday.name },
    })
    res.status(201).json({ data: holiday })
  },
)

hrHolidaysRouter.delete(
  '/:id',
  requireHrRole(...HR_ADMIN_ROLES),
  validate({ params: holidayIdParam }),
  async (req, res) => {
    await service.deleteHoliday(param(req, 'id'))
    await recordHrAudit({
      req,
      action: 'hr.holiday.deleted',
      entityType: 'HrHoliday',
      entityId: param(req, 'id'),
    })
    res.status(204).end()
  },
)
