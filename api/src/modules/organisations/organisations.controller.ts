import type { Request, Response } from 'express'
import { param } from '../../lib/http.js'
import { recordAudit } from '../../lib/audit.js'
import { validatedQuery } from '../../middleware/validate.js'
import { timestampedFilename } from '../../lib/csv.js'
import * as service from './organisations.service.js'
import type { ListOrganisationsQuery } from './organisations.schema.js'

export async function list(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<ListOrganisationsQuery>(res)
  const { items, meta } = await service.listOrganisations(req.user!, query)
  res.json({ data: items, meta })
}

/** CSV export — same filters as `list`, no pagination. Access scope via the service. */
export async function exportCsv(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<ListOrganisationsQuery>(res)
  const csv = await service.exportOrganisationsCSV(req.user!, query)
  res.setHeader('content-type', 'text/csv; charset=utf-8')
  res.setHeader('content-disposition', `attachment; filename="${timestampedFilename('organisations')}"`)
  res.send(csv)
}

export async function listMine(req: Request, res: Response): Promise<void> {
  const items = await service.listMyOrganisations(req.user!.id)
  res.json({ data: items })
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const org = await service.getOrganisation(req.user!, param(req, 'id'))
  res.json({ data: org })
}

export async function create(req: Request, res: Response): Promise<void> {
  const org = await service.createOrganisation(req.body)
  await recordAudit({
    req,
    action: 'organisation.created',
    entityType: 'Organisation',
    entityId: org.id,
    after: org,
  })
  res.status(201).json({ data: org })
}

export async function update(req: Request, res: Response): Promise<void> {
  const org = await service.updateOrganisation(req.user!, param(req, 'id'), req.body)
  await recordAudit({
    req,
    action: 'organisation.updated',
    entityType: 'Organisation',
    entityId: org.id,
    after: org,
  })
  res.json({ data: org })
}

export async function archive(req: Request, res: Response): Promise<void> {
  const org = await service.archiveOrganisation(param(req, 'id'))
  await recordAudit({
    req,
    action: 'organisation.archived',
    entityType: 'Organisation',
    entityId: org.id,
  })
  res.json({ data: org })
}

export async function addMember(req: Request, res: Response): Promise<void> {
  const member = await service.addMember(req.user!, param(req, 'id'), req.body)
  await recordAudit({
    req,
    action: 'organisation.member_added',
    entityType: 'Organisation',
    entityId: param(req, 'id'),
    after: member,
  })
  res.status(201).json({ data: member })
}

export async function updateMember(req: Request, res: Response): Promise<void> {
  const member = await service.updateMember(
    req.user!,
    param(req, 'id'),
    param(req, 'userId'),
    req.body.orgRole,
  )
  await recordAudit({
    req,
    action: 'organisation.member_role_changed',
    entityType: 'Organisation',
    entityId: param(req, 'id'),
    after: member,
  })
  res.json({ data: member })
}

export async function removeMember(req: Request, res: Response): Promise<void> {
  await service.removeMember(req.user!, param(req, 'id'), param(req, 'userId'))
  await recordAudit({
    req,
    action: 'organisation.member_removed',
    entityType: 'Organisation',
    entityId: param(req, 'id'),
    before: { userId: req.params.userId },
  })
  res.status(204).send()
}
