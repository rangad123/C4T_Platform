import { Router } from 'express'
import { param } from '../../lib/http.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { hrAuthenticate, requireHrRole, HR_ADMIN_ROLES } from './hr-auth.middleware.js'
import { recordHrAudit } from '../../lib/hrms/hr-audit.js'
import * as service from './hr-employees.service.js'
import { inviteEmployee } from './hr-auth.service.js'
import {
  listEmployeesQuery,
  createEmployeeSchema,
  updateEmployeeSchema,
  changeEmployeeStatusSchema,
  revealFinancialDetailsSchema,
  employeeIdParam,
  type ListEmployeesQuery,
} from './hr-employees.schema.js'

/**
 * Employees CRUD — Admin Portal only. Every route here is ADMIN-gated; the
 * Employee Portal's own "Basic details" (an employee reading/editing THEIR
 * OWN record) is a separate, narrower route added alongside that portal's
 * module, not this one.
 */
export const hrEmployeesRouter = Router()

hrEmployeesRouter.use(hrAuthenticate, requireHrRole(...HR_ADMIN_ROLES))

// Declared before `/:id` so "managers" is never parsed as an employee id.
hrEmployeesRouter.get('/managers', async (_req, res) => {
  res.json({ data: await service.listManagers() })
})

hrEmployeesRouter.get('/', validate({ query: listEmployeesQuery }), async (_req, res) => {
  const query = validatedQuery<ListEmployeesQuery>(res)
  const { items, meta } = await service.listEmployees(query)
  res.json({ data: items, meta })
})

hrEmployeesRouter.get('/:id', validate({ params: employeeIdParam }), async (req, res) => {
  res.json({ data: await service.getEmployee(param(req, 'id')) })
})

hrEmployeesRouter.post('/', validate({ body: createEmployeeSchema }), async (req, res) => {
  const invite = !req.body.password
  const employee = await service.createEmployee(req.body)
  await recordHrAudit({
    req,
    action: 'hr.employee.created',
    entityType: 'HrEmployee',
    entityId: employee.id,
    after: { email: employee.email, role: employee.role, invited: invite },
  })

  /**
   * Sent after the audit entry, not before: if the mail step were to fail
   * hard the record of who created this account would still exist. It cannot
   * fail hard — `sendMail` logs and returns — which is the right trade here,
   * since an employee created but not emailed is fixed with Resend invitation,
   * whereas a failed create would lose the whole form.
   */
  if (invite) {
    await inviteEmployee(employee.id, req.hrEmployee!.id)
    await recordHrAudit({
      req,
      action: 'hr.employee.invited',
      entityType: 'HrEmployee',
      entityId: employee.id,
      after: { email: employee.email },
    })
  }

  res.status(201).json({ data: { ...employee, invited: invite } })
})

hrEmployeesRouter.post('/:id/invite', validate({ params: employeeIdParam }), async (req, res) => {
  const { email } = await inviteEmployee(param(req, 'id'), req.hrEmployee!.id)
  await recordHrAudit({
    req,
    action: 'hr.employee.invited',
    entityType: 'HrEmployee',
    entityId: param(req, 'id'),
    after: { email },
  })
  res.json({ data: { email } })
})

hrEmployeesRouter.patch(
  '/:id',
  validate({ params: employeeIdParam, body: updateEmployeeSchema }),
  async (req, res) => {
    const employee = await service.updateEmployee(param(req, 'id'), req.body)
    await recordHrAudit({
      req,
      action: 'hr.employee.updated',
      entityType: 'HrEmployee',
      entityId: param(req, 'id'),
    })
    res.json({ data: employee })
  },
)

hrEmployeesRouter.post(
  '/:id/status',
  validate({ params: employeeIdParam, body: changeEmployeeStatusSchema }),
  async (req, res) => {
    const employee = await service.changeEmployeeStatus(
      param(req, 'id'),
      req.body.status,
      req.body.relievingDate,
    )
    await recordHrAudit({
      req,
      action: 'hr.employee.status_changed',
      entityType: 'HrEmployee',
      entityId: param(req, 'id'),
      after: { status: req.body.status },
    })
    res.json({ data: employee })
  },
)

hrEmployeesRouter.post(
  '/:id/financial-details/reveal',
  validate({ params: employeeIdParam, body: revealFinancialDetailsSchema }),
  async (req, res) => {
    const { plain, fieldsRevealed } = await service.revealFinancialDetails(
      req.hrEmployee!.id,
      param(req, 'id'),
      req.body.password,
    )
    await recordHrAudit({
      req,
      action: 'hr.employee.financial_details_revealed',
      entityType: 'HrEmployee',
      entityId: param(req, 'id'),
      after: { fieldsRevealed },
    })
    res.json({ data: plain })
  },
)
