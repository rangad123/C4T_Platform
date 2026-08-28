import { Router } from 'express'
import { z } from 'zod'
import { FileScope } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { BadRequestError } from '../../lib/errors.js'
import { recordAudit } from '../../lib/audit.js'
import { PERMISSIONS } from '../../config/permissions.js'

/**
 * Platform-wide settings an operator controls.
 *
 * Backed by the `PlatformSetting` key/value table. Reads are open to any
 * signed-in account because everything here is published TO users; writes need
 * an admin permission. Nothing user-specific belongs in this table.
 */
export const settingsRouter = Router()

settingsRouter.use(authenticate)

/**
 * The blank NDA a tester downloads, signs and uploads back.
 *
 * Stored as a setting pointing at a `FileObject` rather than as a file
 * committed to the repo: the wording is the client's to supply and will change
 * without a deploy, and a legal document should not be something an engineer
 * edits. Until an admin uploads one this reads as `null`, and the tester-facing
 * link simply does not render — which is the honest state, not a broken link.
 */
const NDA_TEMPLATE_KEY = 'nda_template_file_id'

async function readNdaTemplate() {
  const setting = await prisma.platformSetting.findUnique({
    where: { key: NDA_TEMPLATE_KEY },
    select: { value: true, updatedAt: true },
  })
  if (!setting) return null

  const file = await prisma.fileObject.findFirst({
    where: { id: setting.value, isComplete: true },
    select: { id: true, originalName: true, mimeType: true, sizeBytes: true },
  })
  if (!file) return null

  return {
    fileId: file.id,
    name: file.originalName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes.toString(),
    updatedAt: setting.updatedAt,
  }
}

/** Any signed-in account may read it — a tester needs it to sign the NDA. */
settingsRouter.get('/nda-template', async (_req, res) => {
  res.json({ data: await readNdaTemplate() })
})

const setNdaTemplateSchema = z.object({ fileId: z.string().cuid() })

settingsRouter.put(
  '/nda-template',
  requirePermission(PERMISSIONS.USER_WRITE),
  validate({ body: setNdaTemplateSchema }),
  async (req, res) => {
    const { fileId } = req.body as z.infer<typeof setNdaTemplateSchema>

    /**
     * The scope check is the security boundary, not a formality.
     * `assertCanDownload` lets any signed-in user fetch a PLATFORM_DOCUMENT,
     * so pointing this setting at a file of any other scope would publish
     * that file to the whole platform — a tester's private document, say.
     */
    const file = await prisma.fileObject.findFirst({
      where: { id: fileId, isComplete: true },
      select: { id: true, scope: true, originalName: true },
    })
    if (!file) throw new BadRequestError('That file could not be found')
    if (file.scope !== FileScope.PLATFORM_DOCUMENT) {
      throw new BadRequestError('The NDA template must be uploaded as a platform document')
    }

    await prisma.platformSetting.upsert({
      where: { key: NDA_TEMPLATE_KEY },
      create: { key: NDA_TEMPLATE_KEY, value: fileId, updatedById: req.user!.id },
      update: { value: fileId, updatedById: req.user!.id },
    })

    await recordAudit({
      req,
      action: 'settings.nda_template_updated',
      entityType: 'PlatformSetting',
      entityId: NDA_TEMPLATE_KEY,
      after: { fileId, originalName: file.originalName },
    })

    res.json({ data: await readNdaTemplate() })
  },
)
