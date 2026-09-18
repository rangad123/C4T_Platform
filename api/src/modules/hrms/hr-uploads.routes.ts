import { Router } from 'express'
import { raw } from 'body-parser'
import { z } from 'zod'
import { HrFileScope, HrRole } from '@prisma/client'
import { param } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { validate } from '../../middleware/validate.js'
import { hrAuthenticate } from './hr-auth.middleware.js'
import { NotFoundError, ForbiddenError, BadRequestError } from '../../lib/errors.js'
import { env } from '../../config/env.js'
import {
  createUploadUrl,
  createDownloadUrl,
  writeLocalObject,
  readLocalObject,
  assertUploadAllowed,
} from '../../lib/storage.js'

/**
 * HRMS's own presign/complete/download-url flow — structural copy of
 * modules/uploads/uploads.routes.ts, storing into `HrFile` instead of
 * `FileObject` and gated by `hrAuthenticate` instead of the platform's
 * `authenticate`. `lib/storage.ts`'s presign helpers are reused directly:
 * they take plain scope/key/mime/size and know nothing about which auth
 * stack called them.
 */
export const hrUploadsRouter = Router()

hrUploadsRouter.use(hrAuthenticate)

const presignSchema = z.object({
  scope: z.nativeEnum(HrFileScope),
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(160),
  sizeBytes: z.coerce.number().int().positive(),
})

hrUploadsRouter.post('/presign', validate({ body: presignSchema }), async (req, res) => {
  const input = req.body as z.infer<typeof presignSchema>

  const presigned = await createUploadUrl(input)

  const file = await prisma.hrFile.create({
    data: {
      scope: input.scope,
      storageKey: presigned.storageKey,
      driver: presigned.driver,
      originalName: input.originalName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      uploadedById: req.hrEmployee!.id,
      isComplete: false,
    },
    select: { id: true },
  })

  res.status(201).json({
    data: {
      fileId: file.id,
      uploadUrl: presigned.uploadUrl,
      requiredHeaders: presigned.requiredHeaders,
      expiresInSeconds: presigned.expiresInSeconds,
    },
  })
})

hrUploadsRouter.post(
  '/:id/complete',
  validate({ params: z.object({ id: z.string().cuid() }) }),
  async (req, res) => {
    const file = await prisma.hrFile.findUnique({
      where: { id: param(req, 'id') },
      select: { id: true, uploadedById: true },
    })
    if (!file) throw new NotFoundError('File')
    if (file.uploadedById !== req.hrEmployee!.id) {
      throw new ForbiddenError('That upload belongs to someone else')
    }

    const updated = await prisma.hrFile.update({
      where: { id: file.id },
      data: { isComplete: true },
      select: { id: true, originalName: true, mimeType: true, sizeBytes: true, isComplete: true },
    })
    res.json({ data: updated })
  },
)

/**
 * PROFILE_PICTURE and TEMPLATE are open to any signed-in HR employee — same
 * reasoning as the platform's AVATAR: a profile picture renders unscoped in
 * the Employees list, so gating it per-viewer breaks that list for no
 * confidentiality gain, and a Template is an internal document, not personal
 * data. PAYSLIP is the one scope that IS personal: only an ADMIN or the
 * payslip's own employee may fetch it.
 */
async function assertCanDownload(
  employee: Express.AuthenticatedHrEmployee,
  file: { id: string; scope: HrFileScope },
): Promise<void> {
  if (file.scope !== HrFileScope.PAYSLIP) return
  if (employee.role === HrRole.ADMIN) return

  const payslip = await prisma.hrPayslip.findFirst({
    where: { fileId: file.id },
    select: { employeeId: true },
  })
  if (payslip?.employeeId === employee.id) return

  throw new ForbiddenError('You do not have access to this file')
}

hrUploadsRouter.get(
  '/:id/download-url',
  validate({ params: z.object({ id: z.string().cuid() }) }),
  async (req, res) => {
    const file = await prisma.hrFile.findUnique({
      where: { id: param(req, 'id') },
      select: { id: true, scope: true, storageKey: true, originalName: true, isComplete: true },
    })
    if (!file?.isComplete) throw new NotFoundError('File')

    await assertCanDownload(req.hrEmployee!, file)

    res.json({ data: { url: await createDownloadUrl(file.storageKey, file.originalName) } })
  },
)

// ─── Local driver endpoints (development only) ───────────────────────────────

if (env.STORAGE_DRIVER === 'local') {
  hrUploadsRouter.put(
    '/local/:key',
    raw({ type: '*/*', limit: env.UPLOAD_MAX_BYTES }),
    async (req, res) => {
      const key = decodeURIComponent(param(req, 'key'))
      const contentType = req.header('content-type') ?? 'application/octet-stream'
      const body = req.body as Buffer

      if (!Buffer.isBuffer(body)) throw new BadRequestError('Expected a binary body')
      assertUploadAllowed(contentType, body.length)

      await writeLocalObject(key, body)
      res.status(200).json({ data: { stored: true, bytes: body.length } })
    },
  )

  hrUploadsRouter.get('/local/:key', async (req, res) => {
    const key = decodeURIComponent(param(req, 'key'))
    const file = await prisma.hrFile.findUnique({
      where: { storageKey: key },
      select: { mimeType: true, originalName: true },
    })
    if (!file) throw new NotFoundError('File')

    const data = await readLocalObject(key)
    res.setHeader('content-type', file.mimeType)
    res.setHeader(
      'content-disposition',
      `inline; filename="${file.originalName.replace(/"/g, '')}"`,
    )
    res.send(data)
  })
}
