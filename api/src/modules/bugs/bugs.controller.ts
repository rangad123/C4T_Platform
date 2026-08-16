import type { Request, Response } from 'express'
import { param } from '../../lib/http.js'
import { recordAudit } from '../../lib/audit.js'
import { validatedQuery } from '../../middleware/validate.js'
import { timestampedFilename } from '../../lib/csv.js'
import * as service from './bugs.service.js'
import type { ListBugsQuery } from './bugs.schema.js'

/**
 * Bulk status / severity change for a list of bugs. Per-row auth + transition
 * checks — see `bulkChangeBugStatus` for the failure semantics.
 */
export async function bulkStatus(req: Request, res: Response): Promise<void> {
  const result = await service.bulkChangeBugStatus(req.user!, req.body)
  await recordAudit({
    req,
    action: 'bug.bulk_status_changed',
    entityType: 'Bug',
    after: { ids: req.body.ids, status: req.body.status, severity: req.body.severity },
  })
  res.json({ data: result })
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<ListBugsQuery>(res)
  const { items, meta } = await service.listBugs(req.user!, query)
  res.json({ data: items, meta })
}

/**
 * CSV export. Same query params as `list` minus pagination — the export is
 * the full filtered set. Access scope is enforced by the service, never
 * bypassed here.
 */
export async function exportCsv(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<ListBugsQuery>(res)
  const csv = await service.exportBugsCSV(req.user!, query)
  res.setHeader('content-type', 'text/csv; charset=utf-8')
  res.setHeader('content-disposition', `attachment; filename="${timestampedFilename('bugs')}"`)
  res.send(csv)
}

export async function getOne(req: Request, res: Response): Promise<void> {
  res.json({ data: await service.getBug(req.user!, param(req, 'id')) })
}

export async function create(req: Request, res: Response): Promise<void> {
  const bug = await service.createBug(req.user!, req.body)
  res.status(201).json({ data: bug })
}

export async function update(req: Request, res: Response): Promise<void> {
  res.json({ data: await service.updateBug(req.user!, param(req, 'id'), req.body) })
}

/**
 * One endpoint for every lifecycle move — triage, resolve, verify, reopen.
 * Which of those the caller may make is decided in the service, from their
 * relationship to the bug and its current status.
 */
export async function changeStatus(req: Request, res: Response): Promise<void> {
  const bug = await service.changeBugStatus(req.user!, param(req, 'id'), req.body)
  await recordAudit({
    req,
    action: 'bug.status_changed',
    entityType: 'Bug',
    entityId: bug.id,
    after: req.body,
  })
  res.json({ data: bug })
}

export async function remove(req: Request, res: Response): Promise<void> {
  const bug = await service.deleteBug(req.user!, param(req, 'id'))
  await recordAudit({ req, action: 'bug.deleted', entityType: 'Bug', entityId: bug.id })
  res.json({ data: bug })
}

export async function addComment(req: Request, res: Response): Promise<void> {
  res.status(201).json({ data: await service.addComment(req.user!, param(req, 'id'), req.body) })
}

export async function addAttachment(req: Request, res: Response): Promise<void> {
  res.status(201).json({ data: await service.addAttachment(req.user!, param(req, 'id'), req.body) })
}

export async function removeAttachment(req: Request, res: Response): Promise<void> {
  await service.removeAttachment(req.user!, param(req, 'id'), param(req, 'attachmentId'))
  res.status(204).send()
}
