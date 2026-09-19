import { Router } from 'express'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { hrAuthenticate } from './hr-auth.middleware.js'
import * as employeesService from './hr-employees.service.js'
import * as salaryService from './hr-salary.service.js'
import * as taxService from './hr-tax.service.js'
import * as investmentsService from './hr-investments.service.js'
import * as payslipService from './hr-payslip.service.js'
import { financialYearQuery } from './hr-investments.schema.js'
import { payslipQuery } from './hr-payslip.schema.js'
import type { GeneratePayslipInput } from './hr-payslip.schema.js'

/**
 * What an employee may see about themselves.
 *
 * Every handler passes `req.hrEmployee!.id` — there is no route here that
 * takes an employee id, so one employee cannot read another's salary by
 * changing a number in the URL. That is the whole reason this is a separate
 * router rather than relaxing the role gate on the admin ones, which are all
 * built around `/:id`.
 *
 * Read-only by design: pay, tax and the verified side of a declaration are
 * HR's to set, not the employee's. Employee-submitted investment declarations
 * would be a genuine feature on top of this, not a loosened permission.
 */
export const hrSelfRouter = Router()

hrSelfRouter.use(hrAuthenticate)

/**
 * The employee's own record. Identical shape to the admin detail endpoint,
 * including financial details masked rather than decrypted — reading the real
 * PAN or account number still goes through the admin reveal route, which
 * demands a password.
 */
hrSelfRouter.get('/profile', async (req, res) => {
  res.json({ data: await employeesService.getEmployee(req.hrEmployee!.id) })
})

hrSelfRouter.get('/salary', validate({ query: financialYearQuery }), async (req, res) => {
  const { financialYear } = validatedQuery<{ financialYear: string }>(res)
  res.json({ data: await salaryService.getSalaryStructure(req.hrEmployee!.id, financialYear) })
})

hrSelfRouter.get('/salary/old', async (req, res) => {
  res.json({ data: await salaryService.listOldSalaries(req.hrEmployee!.id) })
})

hrSelfRouter.get(
  '/salary/incentives',
  validate({ query: financialYearQuery }),
  async (req, res) => {
    const { financialYear } = validatedQuery<{ financialYear: string }>(res)
    res.json({ data: await salaryService.listMonthlyIncentives(req.hrEmployee!.id, financialYear) })
  },
)

hrSelfRouter.get('/tax', validate({ query: financialYearQuery }), async (req, res) => {
  const { financialYear } = validatedQuery<{ financialYear: string }>(res)
  res.json({ data: await taxService.computeEmployeeTax(req.hrEmployee!.id, financialYear) })
})

hrSelfRouter.get('/investments', validate({ query: financialYearQuery }), async (req, res) => {
  const { financialYear } = validatedQuery<{ financialYear: string }>(res)
  res.json({ data: await investmentsService.listDeclarations(req.hrEmployee!.id, financialYear) })
})

hrSelfRouter.get(
  '/investments/deductions',
  validate({ query: financialYearQuery }),
  async (req, res) => {
    const { financialYear } = validatedQuery<{ financialYear: string }>(res)
    res.json({
      data: await investmentsService.listMonthlyDeductions(req.hrEmployee!.id, financialYear),
    })
  },
)

hrSelfRouter.get('/payslips', async (req, res) => {
  res.json({ data: await payslipService.listPayslips(req.hrEmployee!.id) })
})

hrSelfRouter.get('/payslips/one', validate({ query: payslipQuery }), async (req, res) => {
  const { financialYear, month } = validatedQuery<GeneratePayslipInput>(res)
  res.json({ data: await payslipService.getPayslip(req.hrEmployee!.id, financialYear, month) })
})
