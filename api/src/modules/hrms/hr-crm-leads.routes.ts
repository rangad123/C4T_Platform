import { Router, type Request } from 'express'
import { param } from '../../lib/http.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { recordHrAudit } from '../../lib/hrms/hr-audit.js'
import { hrAuthenticate } from './hr-auth.middleware.js'
import { requireCrmAccess, requireCrmCapability } from './hr-crm.middleware.js'
import * as service from './hr-crm-leads.service.js'
import {
  createLeadSchema,
  updateLeadSchema,
  changeLeadStatusSchema,
  assignLeadSchema,
  addLeadActivitySchema,
  createContactSchema,
  updateContactSchema,
  listLeadsQuery,
  leadIdParam,
  contactIdParam,
  type ListLeadsQuery,
} from './hr-crm-leads.schema.js'

/**
 * The CRM leads API — every route sits behind the CRM module gate
 * (`requireCrmAccess`) and its own capability gate. Row-level ownership for
 * `'own'`-scoped capabilities (an EMPLOYEE touching only their assigned
 * leads) is enforced inside the service, baked into each query's own WHERE —
 * see `ownershipWhere` there.
 */
export const hrCrmLeadsRouter = Router()

hrCrmLeadsRouter.use(hrAuthenticate, requireCrmAccess)

/** `requireCrmAccess` guarantees both are set by the time a handler runs. */
function actorFrom(req: Request): service.CrmActor {
  return { id: req.hrEmployee!.id, role: req.crmAccess!.role }
}

hrCrmLeadsRouter.get(
  '/',
  requireCrmCapability('view_leads'),
  validate({ query: listLeadsQuery }),
  async (req, res) => {
    const query = validatedQuery<ListLeadsQuery>(res)
    const { items, meta } = await service.listLeads(actorFrom(req), query)
    res.json({ data: items, meta })
  },
)

/** Declared before `/:id` so "assignable-employees" is never parsed as a lead id. */
hrCrmLeadsRouter.get(
  '/assignable-employees',
  requireCrmCapability('assign_leads'),
  async (_req, res) => {
    res.json({ data: await service.listAssignableEmployees() })
  },
)

/** Declared before `/:id` so "stats" is never parsed as a lead id. */
hrCrmLeadsRouter.get('/stats', requireCrmCapability('view_dashboard'), async (req, res) => {
  res.json({ data: await service.getDashboardStats(actorFrom(req)) })
})

hrCrmLeadsRouter.post(
  '/',
  requireCrmCapability('create_leads'),
  validate({ body: createLeadSchema }),
  async (req, res) => {
    const lead = await service.createLead(actorFrom(req), req.body)
    await recordHrAudit({
      req,
      action: 'hr.crm_lead.created',
      entityType: 'CrmLead',
      entityId: lead.id,
      after: { companyName: lead.companyName, assignedToId: lead.assignedTo?.id ?? null },
    })
    res.status(201).json({ data: lead })
  },
)

hrCrmLeadsRouter.get(
  '/:id',
  requireCrmCapability('view_leads'),
  validate({ params: leadIdParam }),
  async (req, res) => {
    res.json({ data: await service.getLead(actorFrom(req), param(req, 'id')) })
  },
)

hrCrmLeadsRouter.patch(
  '/:id',
  requireCrmCapability('edit_leads'),
  validate({ params: leadIdParam, body: updateLeadSchema }),
  async (req, res) => {
    const id = param(req, 'id')
    const lead = await service.updateLead(actorFrom(req), id, req.body)
    await recordHrAudit({ req, action: 'hr.crm_lead.updated', entityType: 'CrmLead', entityId: id })
    res.json({ data: lead })
  },
)

hrCrmLeadsRouter.post(
  '/:id/status',
  requireCrmCapability('change_status'),
  validate({ params: leadIdParam, body: changeLeadStatusSchema }),
  async (req, res) => {
    const id = param(req, 'id')
    const lead = await service.changeLeadStatus(actorFrom(req), id, req.body.status)
    await recordHrAudit({
      req,
      action: 'hr.crm_lead.status_changed',
      entityType: 'CrmLead',
      entityId: id,
      after: { status: req.body.status },
    })
    res.json({ data: lead })
  },
)

hrCrmLeadsRouter.post(
  '/:id/assign',
  requireCrmCapability('assign_leads'),
  validate({ params: leadIdParam, body: assignLeadSchema }),
  async (req, res) => {
    const id = param(req, 'id')
    const lead = await service.assignLead(actorFrom(req), id, req.body.assignedToId)
    await recordHrAudit({
      req,
      action: 'hr.crm_lead.assigned',
      entityType: 'CrmLead',
      entityId: id,
      after: { assignedToId: req.body.assignedToId },
    })
    res.json({ data: lead })
  },
)

hrCrmLeadsRouter.post(
  '/:id/archive',
  requireCrmCapability('delete_leads'),
  validate({ params: leadIdParam }),
  async (req, res) => {
    const id = param(req, 'id')
    await service.archiveLead(id)
    await recordHrAudit({
      req,
      action: 'hr.crm_lead.archived',
      entityType: 'CrmLead',
      entityId: id,
    })
    res.status(204).end()
  },
)

hrCrmLeadsRouter.post(
  '/:id/activity',
  requireCrmCapability('add_activity'),
  validate({ params: leadIdParam, body: addLeadActivitySchema }),
  async (req, res) => {
    const id = param(req, 'id')
    const activity = await service.addLeadNote(
      actorFrom(req),
      id,
      req.body.body,
      req.body.communicationStatusId,
    )
    await recordHrAudit({
      req,
      action: 'hr.crm_activity.added',
      entityType: 'CrmLead',
      entityId: id,
      after: { activityId: activity.id },
    })
    res.status(201).json({ data: activity })
  },
)

hrCrmLeadsRouter.post(
  '/:id/contacts',
  requireCrmCapability('manage_contacts'),
  validate({ params: leadIdParam, body: createContactSchema }),
  async (req, res) => {
    const id = param(req, 'id')
    const contact = await service.addLeadContact(actorFrom(req), id, req.body)
    await recordHrAudit({
      req,
      action: 'hr.crm_contact.added',
      entityType: 'CrmLead',
      entityId: id,
      after: { contactId: contact.id },
    })
    res.status(201).json({ data: contact })
  },
)

hrCrmLeadsRouter.patch(
  '/:id/contacts/:contactId',
  requireCrmCapability('manage_contacts'),
  validate({ params: contactIdParam, body: updateContactSchema }),
  async (req, res) => {
    const id = param(req, 'id')
    const contactId = param(req, 'contactId')
    const contact = await service.updateLeadContact(actorFrom(req), id, contactId, req.body)
    await recordHrAudit({
      req,
      action: 'hr.crm_contact.updated',
      entityType: 'CrmLead',
      entityId: id,
      after: { contactId },
    })
    res.json({ data: contact })
  },
)

hrCrmLeadsRouter.delete(
  '/:id/contacts/:contactId',
  requireCrmCapability('manage_contacts'),
  validate({ params: contactIdParam }),
  async (req, res) => {
    const id = param(req, 'id')
    const contactId = param(req, 'contactId')
    await service.removeLeadContact(actorFrom(req), id, contactId)
    await recordHrAudit({
      req,
      action: 'hr.crm_contact.removed',
      entityType: 'CrmLead',
      entityId: id,
      after: { contactId },
    })
    res.status(204).end()
  },
)
