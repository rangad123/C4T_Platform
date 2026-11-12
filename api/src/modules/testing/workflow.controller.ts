import type { Request, Response } from 'express'
import { param } from '../../lib/http.js'
import { recordAudit } from '../../lib/audit.js'
import { validatedQuery } from '../../middleware/validate.js'
import * as service from './workflow.service.js'
import type {
  ListApplicationsQuery,
  ListExecutionsQuery,
  ListTimesheetsQuery,
} from './workflow.schema.js'

export async function setApplicationsOpen(req: Request, res: Response): Promise<void> {
  const build = await service.setApplicationsOpen(req.user!, param(req, 'buildId'), req.body.open)
  await recordAudit({
    req,
    action: 'build.applications_toggled',
    entityType: 'Build',
    entityId: build.id,
    after: { acceptsApplications: build.acceptsApplications },
  })
  res.json({ data: build })
}

export async function listOpenBuilds(req: Request, res: Response): Promise<void> {
  res.json({ data: await service.listOpenBuilds(req.user!) })
}

export async function apply(req: Request, res: Response): Promise<void> {
  res.status(201).json({ data: await service.apply(req.user!, req.body) })
}

export async function listApplications(req: Request, res: Response): Promise<void> {
  const { items, meta } = await service.listApplications(
    req.user!,
    validatedQuery<ListApplicationsQuery>(res),
  )
  res.json({ data: items, meta })
}

export async function decideApplication(req: Request, res: Response): Promise<void> {
  const result = await service.decideApplication(req.user!, param(req, 'id'), req.body)
  await recordAudit({
    req,
    action: 'application.decided',
    entityType: 'ProjectApplication',
    entityId: result.id,
    after: { status: result.status },
  })
  res.json({ data: result })
}

export async function withdrawApplication(req: Request, res: Response): Promise<void> {
  await service.withdrawApplication(req.user!, param(req, 'id'))
  res.status(204).send()
}

export async function listExecutions(req: Request, res: Response): Promise<void> {
  const { items, meta } = await service.listExecutions(
    req.user!,
    validatedQuery<ListExecutionsQuery>(res),
  )
  res.json({ data: items, meta })
}

export async function reviewExecution(req: Request, res: Response): Promise<void> {
  const result = await service.reviewExecution(req.user!, param(req, 'id'), req.body)
  await recordAudit({
    req,
    action: 'testreport.reviewed',
    entityType: 'TestReport',
    entityId: result.id,
    after: { reviewStatus: result.reviewStatus },
  })
  res.json({ data: result })
}

export async function logTime(req: Request, res: Response): Promise<void> {
  res.status(201).json({ data: await service.logTime(req.user!, req.body) })
}

export async function listTimesheets(req: Request, res: Response): Promise<void> {
  const { items, meta } = await service.listTimesheets(
    req.user!,
    validatedQuery<ListTimesheetsQuery>(res),
  )
  res.json({ data: items, meta })
}

export async function reviewTimesheet(req: Request, res: Response): Promise<void> {
  const entry = await service.reviewTimesheet(req.user!, param(req, 'id'), req.body)
  await recordAudit({
    req,
    action: 'timesheet.reviewed',
    entityType: 'TimesheetEntry',
    entityId: entry.id,
    after: { status: entry.status, approvedMinutes: entry.approvedMinutes },
  })
  res.json({ data: entry })
}

export async function listScenarios(req: Request, res: Response): Promise<void> {
  res.json({ data: await service.listScenarios(req.user!, param(req, 'buildId')) })
}

export async function createScenario(req: Request, res: Response): Promise<void> {
  res
    .status(201)
    .json({ data: await service.createScenario(req.user!, param(req, 'buildId'), req.body) })
}

export async function deleteScenario(req: Request, res: Response): Promise<void> {
  await service.deleteScenario(req.user!, param(req, 'id'))
  res.status(204).send()
}
