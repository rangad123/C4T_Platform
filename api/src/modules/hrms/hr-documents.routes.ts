import { Router } from 'express'
import type { Request } from 'express'
import { z } from 'zod'
import { param } from '../../lib/http.js'
import { ForbiddenError } from '../../lib/errors.js'
import { validate } from '../../middleware/validate.js'
import { recordHrAudit } from '../../lib/hrms/hr-audit.js'
import { hrAuthenticate, requireHrRole, HR_ADMIN_ROLES } from './hr-auth.middleware.js'
import * as service from './hr-documents.service.js'

/**
 * Documents held against an employee. Mounted under `/employees`, alongside
 * the other per-employee routers.
 *
 * Writes are ADMIN-only — a personnel file is HR's to curate, not the
 * employee's. Listing is open to an admin OR the employee themselves, which
 * is why that handler checks for the pairing rather than sitting behind
 * `requireHrRole`; the employee's own portal lists these through the same
 * route.
 *
 * There is deliberately no download endpoint here. The bytes come from
 * `/v1/hrms/uploads/:id/download-url`, which resolves a file's scope back to
 * the record owning it and applies the same admin-or-owner rule. A second
 * door to the same object would mean two copies of that rule to keep in step,
 * and the one that drifts is the one nobody is looking at.
 */
export const hrDocumentsRouter = Router()

hrDocumentsRouter.use(hrAuthenticate)

const employeeIdParam = z.object({ id: z.string().cuid() })
const documentParam = employeeIdParam.extend({ documentId: z.string().cuid() })

const attachDocumentSchema = z.object({
  kind: z.string().trim().min(1, 'Say what this document is').max(60),
  fileId: z.string().cuid(),
})

/** An admin, or the employee whose record this is. */
function assertMayRead(req: Request, employeeId: string): void {
  const viewer = req.hrEmployee!
  if (viewer.role === 'ADMIN') return
  if (viewer.id === employeeId) return
  throw new ForbiddenError('You do not have access to these documents')
}

hrDocumentsRouter.get('/:id/documents', validate({ params: employeeIdParam }), async (req, res) => {
  const employeeId = param(req, 'id')
  assertMayRead(req, employeeId)
  res.json({ data: await service.listDocuments(employeeId) })
})

hrDocumentsRouter.post(
  '/:id/documents',
  requireHrRole(...HR_ADMIN_ROLES),
  validate({ params: employeeIdParam, body: attachDocumentSchema }),
  async (req, res) => {
    const employeeId = param(req, 'id')
    const row = await service.attachDocument(employeeId, req.body, req.hrEmployee!.id)
    await recordHrAudit({
      req,
      action: 'hr.employee_document.added',
      entityType: 'HrEmployeeDocument',
      entityId: row.id,
      after: { employeeId, kind: req.body.kind },
    })
    res.status(201).json({ data: row })
  },
)

hrDocumentsRouter.delete(
  '/:id/documents/:documentId',
  requireHrRole(...HR_ADMIN_ROLES),
  validate({ params: documentParam }),
  async (req, res) => {
    const employeeId = param(req, 'id')
    const documentId = param(req, 'documentId')
    await service.deleteDocument(employeeId, documentId)
    await recordHrAudit({
      req,
      action: 'hr.employee_document.removed',
      entityType: 'HrEmployeeDocument',
      entityId: documentId,
      before: { employeeId },
    })
    res.status(204).end()
  },
)
