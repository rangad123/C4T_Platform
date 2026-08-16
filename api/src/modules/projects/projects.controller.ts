import type { Request, Response } from 'express'
import { param } from '../../lib/http.js'
import { type AssignmentStatus } from '@prisma/client'
import { recordAudit } from '../../lib/audit.js'
import { validatedQuery } from '../../middleware/validate.js'
import { timestampedFilename } from '../../lib/csv.js'
import * as service from './projects.service.js'
import type { ListProjectsQuery } from './projects.schema.js'

export async function list(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<ListProjectsQuery>(res)
  const { items, meta } = await service.listProjects(req.user!, query)
  res.json({ data: items, meta })
}

/** CSV export — same filters as `list`, no pagination. Access scope via the service. */
export async function exportCsv(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<ListProjectsQuery>(res)
  const csv = await service.exportProjectsCSV(req.user!, query)
  res.setHeader('content-type', 'text/csv; charset=utf-8')
  res.setHeader('content-disposition', `attachment; filename="${timestampedFilename('projects')}"`)
  res.send(csv)
}

export async function getOne(req: Request, res: Response): Promise<void> {
  res.json({ data: await service.getProject(req.user!, param(req, 'id')) })
}

export async function create(req: Request, res: Response): Promise<void> {
  const project = await service.createProject(req.user!, req.body)
  await recordAudit({
    req,
    action: 'project.created',
    entityType: 'Project',
    entityId: project.id,
    after: { reference: project.reference, title: project.title },
  })
  res.status(201).json({ data: project })
}

export async function update(req: Request, res: Response): Promise<void> {
  const project = await service.updateProject(req.user!, param(req, 'id'), req.body)
  await recordAudit({
    req,
    action: 'project.updated',
    entityType: 'Project',
    entityId: project.id,
    after: req.body,
  })
  res.json({ data: project })
}

export async function changeStatus(req: Request, res: Response): Promise<void> {
  const project = await service.changeStatus(req.user!, param(req, 'id'), req.body.status)
  await recordAudit({
    req,
    action: 'project.status_changed',
    entityType: 'Project',
    entityId: project.id,
    after: { status: req.body.status, note: req.body.note },
  })
  res.json({ data: project })
}

export async function archive(req: Request, res: Response): Promise<void> {
  const project = await service.archiveProject(param(req, 'id'))
  await recordAudit({
    req,
    action: 'project.archived',
    entityType: 'Project',
    entityId: project.id,
  })
  res.json({ data: project })
}

export async function addMaterial(req: Request, res: Response): Promise<void> {
  const material = await service.addMaterial(req.user!, param(req, 'id'), req.body)
  res.status(201).json({ data: material })
}

export async function removeMaterial(req: Request, res: Response): Promise<void> {
  await service.removeMaterial(req.user!, param(req, 'id'), param(req, 'materialId'))
  res.status(204).send()
}

export async function listFeatures(req: Request, res: Response): Promise<void> {
  const features = await service.listFeatures(req.user!, param(req, 'id'))
  res.json({ data: features })
}

export async function addFeature(req: Request, res: Response): Promise<void> {
  const feature = await service.addFeature(req.user!, param(req, 'id'), req.body.name)
  res.status(201).json({ data: feature })
}

export async function removeFeature(req: Request, res: Response): Promise<void> {
  await service.removeFeature(req.user!, param(req, 'id'), param(req, 'featureId'))
  res.status(204).send()
}

export async function assignTesters(req: Request, res: Response): Promise<void> {
  const result = await service.assignTesters(param(req, 'id'), req.body.testerIds, req.body.notes)
  await recordAudit({
    req,
    action: 'project.testers_assigned',
    entityType: 'Project',
    entityId: param(req, 'id'),
    after: { testerIds: req.body.testerIds, invited: result.invited },
  })
  res.status(201).json({ data: result })
}

export async function respondToAssignment(req: Request, res: Response): Promise<void> {
  const assignment = await service.respondToAssignment(
    req.user!.id,
    param(req, 'id'),
    req.body.response as 'ACCEPTED' | 'DECLINED',
    req.body.notes,
  )
  res.json({ data: assignment })
}

export async function updateAssignment(req: Request, res: Response): Promise<void> {
  const assignment = await service.updateAssignment(
    param(req, 'id'),
    param(req, 'testerId'),
    req.body.status,
    req.body.notes,
  )
  await recordAudit({
    req,
    action: 'project.assignment_updated',
    entityType: 'ProjectAssignment',
    entityId: assignment.id,
    after: { status: req.body.status },
  })
  res.json({ data: assignment })
}

export async function listMyAssignments(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<{ page: number; limit: number; status?: AssignmentStatus }>(res)
  const { items, meta } = await service.listMyAssignments(req.user!.id, query)
  res.json({ data: items, meta })
}
