import { Router } from 'express'
import { raw } from 'body-parser'
import { param } from '../../lib/http.js'
import { z } from 'zod'
import { FileScope } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { authenticate } from '../../middleware/authenticate.js'
import { isAdminSide } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { uploadLimiter } from '../../middleware/rateLimit.js'
import { NotFoundError, ForbiddenError, BadRequestError } from '../../lib/errors.js'
import { env } from '../../config/env.js'
import { bugRelations, projectRelations, threadRelations } from '../../lib/access/relations.js'
import { authorize } from '../../lib/access/policy.js'
import {
  createUploadUrl,
  createDownloadUrl,
  writeLocalObject,
  readLocalObject,
  assertUploadAllowed,
} from '../../lib/storage.js'

/**
 * Two-step upload:
 *   1. POST /uploads/presign  → returns a signed PUT URL and a fileId
 *   2. client PUTs the bytes straight to S3
 *   3. POST /uploads/:id/complete → marks the row usable
 *
 * Bytes never pass through this API, which matters for the screenshot and video
 * attachments §2.3 allows on bug reports.
 */
export const uploadsRouter = Router()

const presignSchema = z.object({
  scope: z.nativeEnum(FileScope),
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(160),
  sizeBytes: z.coerce.number().int().positive(),
})

uploadsRouter.post(
  '/presign',
  authenticate,
  uploadLimiter,
  validate({ body: presignSchema }),
  async (req, res) => {
    const input = req.body as z.infer<typeof presignSchema>

    const presigned = await createUploadUrl(input)

    const file = await prisma.fileObject.create({
      data: {
        scope: input.scope,
        storageKey: presigned.storageKey,
        driver: presigned.driver,
        originalName: input.originalName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        uploadedById: req.user!.id,
        isComplete: false,
      },
      select: { id: true, storageKey: true, scope: true },
    })

    res.status(201).json({
      data: {
        fileId: file.id,
        uploadUrl: presigned.uploadUrl,
        requiredHeaders: presigned.requiredHeaders,
        expiresInSeconds: presigned.expiresInSeconds,
      },
    })
  },
)

uploadsRouter.post(
  '/:id/complete',
  authenticate,
  validate({ params: z.object({ id: z.string().cuid() }) }),
  async (req, res) => {
    const file = await prisma.fileObject.findUnique({
      where: { id: param(req, 'id') },
      select: { id: true, uploadedById: true, isComplete: true },
    })
    if (!file) throw new NotFoundError('File')
    if (file.uploadedById !== req.user!.id) {
      throw new ForbiddenError('That upload belongs to someone else')
    }

    const updated = await prisma.fileObject.update({
      where: { id: file.id },
      data: { isComplete: true },
      select: { id: true, originalName: true, mimeType: true, sizeBytes: true, isComplete: true },
    })

    res.json({ data: updated })
  },
)

/**
 * Resolves whether the caller may download this file, by walking to whatever
 * it's actually attached to and reusing that resource's own visibility rule
 * — the same `bugRelations`/`projectRelations`/`threadRelations` + `authorize`
 * pattern every other module uses. Admin-side roles bypass, matching how they
 * already read bugs/projects/threads platform-wide elsewhere.
 *
 * Avatars and organisation logos are treated as viewable by any authenticated
 * user: they render unscoped in list rows across the admin panel (a tester
 * row shows the tester's avatar regardless of the viewer's specific
 * relationship to that tester), so gating them per-viewer would just break
 * those lists for no confidentiality gain — they are profile pictures, not
 * sensitive documents.
 *
 * A file with no matching join row (e.g. TESTER_DOCUMENT, OTHER, or an
 * attachment whose parent was deleted) falls back to uploader-only.
 */
async function assertCanDownload(
  user: Express.AuthenticatedUser,
  file: { id: string; scope: FileScope; uploadedById: string },
): Promise<void> {
  if (isAdminSide(user)) return

  if (file.scope === FileScope.AVATAR || file.scope === FileScope.ORG_LOGO) return

  if (file.scope === FileScope.BUG_ATTACHMENT) {
    const attachment = await prisma.bugAttachment.findFirst({
      where: { fileId: file.id },
      select: { bugId: true },
    })
    if (attachment) {
      const ctx = await bugRelations(user, attachment.bugId)
      if (!ctx) throw new NotFoundError('File')
      authorize(user, 'bug.read', ctx.relations)
      return
    }
  }

  if (file.scope === FileScope.PROJECT_MATERIAL) {
    const material = await prisma.projectMaterial.findFirst({
      where: { fileId: file.id },
      select: { projectId: true },
    })
    if (material) {
      const ctx = await projectRelations(user, material.projectId)
      if (!ctx) throw new NotFoundError('File')
      authorize(user, 'project.read', ctx.relations)
      return
    }
  }

  if (file.scope === FileScope.MESSAGE_ATTACHMENT) {
    const attachment = await prisma.messageAttachment.findFirst({
      where: { fileId: file.id },
      select: { message: { select: { threadId: true } } },
    })
    if (attachment) {
      const ctx = await threadRelations(user, attachment.message.threadId)
      if (!ctx) throw new NotFoundError('File')
      authorize(user, 'thread.read', ctx.relations)
      return
    }
  }

  // TESTER_DOCUMENT, OTHER, or an attachment row that no longer resolves —
  // only the person who uploaded it may fetch it.
  if (file.uploadedById !== user.id) {
    throw new ForbiddenError('You do not have access to this file')
  }
}

/** Short-lived signed download URL. Objects are never publicly readable. */
uploadsRouter.get(
  '/:id/download-url',
  authenticate,
  validate({ params: z.object({ id: z.string().cuid() }) }),
  async (req, res) => {
    const file = await prisma.fileObject.findUnique({
      where: { id: param(req, 'id') },
      select: {
        id: true,
        scope: true,
        storageKey: true,
        originalName: true,
        isComplete: true,
        uploadedById: true,
      },
    })
    if (!file?.isComplete) throw new NotFoundError('File')

    await assertCanDownload(req.user!, file)

    res.json({ data: { url: await createDownloadUrl(file.storageKey, file.originalName) } })
  },
)

// ─── Local driver endpoints (development only) ───────────────────────────────

if (env.STORAGE_DRIVER === 'local') {
  uploadsRouter.put(
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

  uploadsRouter.get('/local/:key', async (req, res) => {
    const key = decodeURIComponent(param(req, 'key'))
    const file = await prisma.fileObject.findUnique({
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
