import { HrFileScope, type Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError, BadRequestError } from '../../lib/errors.js'
import { createDownloadUrl, deleteObject } from '../../lib/storage.js'
import type { CreateTemplateInput } from './hr-templates.schema.js'

const templateSelect = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
  file: {
    select: { id: true, storageKey: true, originalName: true, mimeType: true, sizeBytes: true },
  },
  uploadedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.HrTemplateSelect

async function toPublicTemplate(
  row: Prisma.HrTemplateGetPayload<{ select: typeof templateSelect }>,
) {
  const { file, ...rest } = row
  return {
    ...rest,
    file: {
      id: file.id,
      originalName: file.originalName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
    },
    downloadUrl: await createDownloadUrl(file.storageKey, file.originalName),
  }
}

export async function listTemplates() {
  const rows = await prisma.hrTemplate.findMany({
    select: templateSelect,
    orderBy: { createdAt: 'desc' },
  })
  return Promise.all(rows.map(toPublicTemplate))
}

/** Strips the extension from a filename for use as a default template name. */
function nameFromFile(originalName: string): string {
  const withoutExtension = originalName.replace(/\.[^.]+$/, '')
  return withoutExtension.trim() || originalName
}

export async function createTemplate(uploadedById: string, input: CreateTemplateInput) {
  const file = await prisma.hrFile.findUnique({
    where: { id: input.fileId },
    select: { id: true, scope: true, isComplete: true, uploadedById: true, originalName: true },
  })
  if (!file?.isComplete) throw new NotFoundError('Uploaded file')
  if (file.scope !== HrFileScope.TEMPLATE) {
    throw new BadRequestError('That file was not uploaded as a template')
  }
  if (file.uploadedById !== uploadedById) {
    throw new BadRequestError('That upload belongs to someone else')
  }

  const row = await prisma.hrTemplate.create({
    data: {
      name: input.name ?? nameFromFile(file.originalName),
      description: input.description ?? null,
      fileId: input.fileId,
      uploadedById,
    },
    select: templateSelect,
  })
  return toPublicTemplate(row)
}

export async function deleteTemplate(id: string): Promise<void> {
  const existing = await prisma.hrTemplate.findUnique({
    where: { id },
    select: { fileId: true, file: { select: { storageKey: true } } },
  })
  if (!existing) throw new NotFoundError('Template')

  await prisma.hrTemplate.delete({ where: { id } })
  await prisma.hrFile.delete({ where: { id: existing.fileId } }).catch(() => undefined)
  await deleteObject(existing.file.storageKey).catch(() => undefined)
}
