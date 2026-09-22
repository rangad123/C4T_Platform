import { Router } from 'express'
import { z } from 'zod'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { hrAuthenticate } from './hr-auth.middleware.js'
import { recordHrAudit } from '../../lib/hrms/hr-audit.js'
import { updateOwnDetailsSchema } from './hr-employees.schema.js'
import * as employeesService from './hr-employees.service.js'
import * as salaryService from './hr-salary.service.js'
import * as taxService from './hr-tax.service.js'
import * as investmentsService from './hr-investments.service.js'
import * as payslipService from './hr-payslip.service.js'
import * as documentsService from './hr-documents.service.js'
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
 * Mostly read-only by design: pay, tax and the verified side of a declaration
 * are HR's to set, not the employee's. Employee-submitted investment
 * declarations would be a genuine feature on top of this, not a loosened
 * permission. Documents are the one real write here — see the bottom of this
 * file — and even that is narrower than the admin route it sits beside: an
 * employee may only ADD one of a fixed, low-risk set of kinds to their own
 * record, never remove one (admin-uploaded or their own), and never touch
 * anyone else's.
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

/**
 * The employee filling in their own details — the step after accepting an
 * invitation. Personal details, and PAN and bank details; the last group needs
 * the current password. Nothing about employment: that stays with HR.
 *
 * The audit entry names the fields changed and never their values.
 */
hrSelfRouter.patch('/profile', validate({ body: updateOwnDetailsSchema }), async (req, res) => {
  const id = req.hrEmployee!.id
  const employee = await employeesService.updateOwnDetails(id, req.body)
  await recordHrAudit({
    req,
    action: 'hr.employee.self_updated',
    entityType: 'HrEmployee',
    entityId: id,
    after: { fields: Object.keys(req.body).filter((key) => key !== 'currentPassword') },
  })
  res.json({ data: employee })
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

// ─── Documents ───────────────────────────────────────────────────────────────
//
// Reads the same rows the admin route does (`hr-documents.service.ts` has no
// idea which router called it) — an employee sees every document on their own
// record, including whatever HR attached, not only what they added themselves.
//
// Writes are deliberately narrower than the admin route's: `kind` is a closed
// enum instead of free text, so an employee cannot label an upload "Offer
// letter" or "Increment letter" and cannot remove anything at all. A personnel
// file is still HR's to curate; this is a small, safe carve-out for the
// documents an employee would otherwise have to email HR to add.

const SELF_DOCUMENT_KINDS = ['CV', 'Identity proof', 'Other'] as const

const attachOwnDocumentSchema = z.object({
  kind: z.enum(SELF_DOCUMENT_KINDS),
  fileId: z.string().cuid(),
})

hrSelfRouter.get('/documents', async (req, res) => {
  res.json({ data: await documentsService.listDocuments(req.hrEmployee!.id) })
})

hrSelfRouter.post('/documents', validate({ body: attachOwnDocumentSchema }), async (req, res) => {
  const id = req.hrEmployee!.id
  const row = await documentsService.attachDocument(id, req.body, id)
  await recordHrAudit({
    req,
    action: 'hr.employee_document.self_added',
    entityType: 'HrEmployeeDocument',
    entityId: row.id,
    after: { kind: req.body.kind },
  })
  res.status(201).json({ data: row })
})
