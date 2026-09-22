import { HrFileScope } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { BadRequestError, NotFoundError } from '../../lib/errors.js'

/**
 * Documents held against one employee — CV, offer letter, increment letter.
 *
 * `attachDocument` is called from two routers: the admin one (`hr-documents
 * .routes.ts`, any kind, any employee) and the self one (`hr-self.routes.ts`,
 * a fixed low-risk kind, the caller's own record only) — this function has no
 * opinion on which; the kind restriction and the "whose record" question are
 * each router's own job. `deleteDocument` is only ever reached from the admin
 * router — there is deliberately no self equivalent, so a document, once
 * added, is HR's to retire, not the employee's.
 *
 * Capped per employee rather than unlimited: the request was "up to 10 max",
 * and a cap also keeps a personnel file from quietly becoming a dumping
 * ground. The check is here rather than in the schema because it is a count of
 * existing rows, not a property of the request.
 */
export const MAX_DOCUMENTS_PER_EMPLOYEE = 10

const documentSelect = {
  id: true,
  kind: true,
  fileId: true,
  createdAt: true,
  file: { select: { originalName: true, sizeBytes: true, mimeType: true, isComplete: true } },
  uploadedBy: { select: { firstName: true, lastName: true } },
} as const

export async function listDocuments(employeeId: string) {
  const rows = await prisma.hrEmployeeDocument.findMany({
    where: { employeeId },
    select: documentSelect,
    orderBy: { createdAt: 'desc' },
  })
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    fileId: row.fileId,
    createdAt: row.createdAt,
    originalName: row.file.originalName,
    sizeBytes: row.file.sizeBytes,
    // Surfaced so the UI can say "no longer available" instead of offering a
    // link that resolves to a 404.
    available: row.file.isComplete,
    uploadedBy: `${row.uploadedBy.firstName} ${row.uploadedBy.lastName}`.trim(),
  }))
}

export async function attachDocument(
  employeeId: string,
  input: { kind: string; fileId: string },
  uploadedById: string,
) {
  const employee = await prisma.hrEmployee.findFirst({
    where: { id: employeeId, deletedAt: null },
    select: { id: true },
  })
  if (!employee) throw new NotFoundError('Employee')

  const count = await prisma.hrEmployeeDocument.count({ where: { employeeId } })
  if (count >= MAX_DOCUMENTS_PER_EMPLOYEE) {
    throw new BadRequestError(
      `This employee already has ${MAX_DOCUMENTS_PER_EMPLOYEE} documents. Remove one before adding another.`,
    )
  }

  // The file must exist, be finished uploading, and be of this scope — a
  // completed upload of some other scope must not be re-pointed at a person.
  const file = await prisma.hrFile.findFirst({
    where: { id: input.fileId, scope: HrFileScope.EMPLOYEE_DOCUMENT, isComplete: true },
    select: { id: true },
  })
  if (!file) throw new BadRequestError('That upload could not be found or did not finish')

  return prisma.hrEmployeeDocument.create({
    data: { employeeId, kind: input.kind, fileId: input.fileId, uploadedById },
    select: { id: true },
  })
}

/**
 * Removes the link and the file row together. `HrFile` is Restrict-deleted
 * from the document, so the document has to go first; the stored object itself
 * is left in S3 rather than deleted, which is deliberate — an accidental
 * removal here should not destroy the only copy of somebody's offer letter.
 */
export async function deleteDocument(employeeId: string, id: string): Promise<void> {
  const existing = await prisma.hrEmployeeDocument.findFirst({
    where: { id, employeeId },
    select: { id: true },
  })
  if (!existing) throw new NotFoundError('Document')
  await prisma.hrEmployeeDocument.delete({ where: { id } })
}
