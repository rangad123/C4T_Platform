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
  setTemporaryPasswordSchema,
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

/**
 * Adding an employee IS inviting them. There is no separate "send invitation"
 * step: the person is created from the four details HR types and emailed a link
 * to choose their own password, after which they fill in the rest themselves.
 *
 * The invitation is sent after the audit entry for the creation, not before: if
 * the mail step were to fail hard the record of who created this account would
 * still exist. It cannot fail hard — `sendMail` logs and returns — which is the
 * right trade, since an employee created but not emailed can ask for a fresh
 * link from "Forgot password" on the sign-in page, whereas a failed create
 * would lose the whole form.
 */
hrEmployeesRouter.post('/', validate({ body: createEmployeeSchema }), async (req, res) => {
  const employee = await service.createEmployee(req.body)
  await recordHrAudit({
    req,
    action: 'hr.employee.created',
    entityType: 'HrEmployee',
    entityId: employee.id,
    after: { email: employee.email, role: employee.role },
  })

  await inviteEmployee(employee.id, req.hrEmployee!.id)
  await recordHrAudit({
    req,
    action: 'hr.employee.invited',
    entityType: 'HrEmployee',
    entityId: employee.id,
    after: { email: employee.email },
  })

  res.status(201).json({ data: employee })
})

/**
 * Sets a temporary password and returns it once. Never cached and never logged:
 * the audit entry records that it happened, not what it was.
 */
hrEmployeesRouter.post(
  '/:id/temporary-password',
  validate({ params: employeeIdParam, body: setTemporaryPasswordSchema }),
  async (req, res) => {
    const id = param(req, 'id')
    const { password } = await service.setTemporaryPassword(
      id,
      req.hrEmployee!.id,
      req.body.password,
    )
    await recordHrAudit({
      req,
      action: 'hr.employee.temporary_password_set',
      entityType: 'HrEmployee',
      entityId: id,
      after: { chosenByAdmin: req.body.password !== undefined },
    })
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: { password } })
  },
)

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
