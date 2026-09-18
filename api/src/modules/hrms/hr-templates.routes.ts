import { Router } from 'express'
import { param } from '../../lib/http.js'
import { validate } from '../../middleware/validate.js'
import { hrAuthenticate, requireHrRole, HR_ADMIN_ROLES } from './hr-auth.middleware.js'
import { recordHrAudit } from '../../lib/hrms/hr-audit.js'
import * as service from './hr-templates.service.js'
import { createTemplateSchema, templateIdParam } from './hr-templates.schema.js'

/** Templates — admin-only upload/list/download/delete of reusable documents. */
export const hrTemplatesRouter = Router()

hrTemplatesRouter.use(hrAuthenticate, requireHrRole(...HR_ADMIN_ROLES))

hrTemplatesRouter.get('/', async (_req, res) => {
  res.json({ data: await service.listTemplates() })
})

hrTemplatesRouter.post('/', validate({ body: createTemplateSchema }), async (req, res) => {
  const template = await service.createTemplate(req.hrEmployee!.id, req.body)
  await recordHrAudit({
    req,
    action: 'hr.template.created',
    entityType: 'HrTemplate',
    entityId: template.id,
    after: { name: template.name },
  })
  res.status(201).json({ data: template })
})

hrTemplatesRouter.delete('/:id', validate({ params: templateIdParam }), async (req, res) => {
  await service.deleteTemplate(param(req, 'id'))
  await recordHrAudit({
    req,
    action: 'hr.template.deleted',
    entityType: 'HrTemplate',
    entityId: param(req, 'id'),
  })
  res.status(204).end()
})
