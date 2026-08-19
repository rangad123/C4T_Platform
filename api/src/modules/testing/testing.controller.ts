import type { Request, Response } from 'express'
import { param } from '../../lib/http.js'
import { recordAudit } from '../../lib/audit.js'
import { validatedQuery } from '../../middleware/validate.js'
import * as service from './testing.service.js'
import type { ListTestCasesQuery } from './testing.schema.js'

export async function list(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<ListTestCasesQuery>(res)
  const { items, meta } = await service.listTestCases(req.user!, query)
  res.json({ data: items, meta })
}

export async function getOne(req: Request, res: Response): Promise<void> {
  res.json({ data: await service.getTestCase(req.user!, param(req, 'id')) })
}

export async function create(req: Request, res: Response): Promise<void> {
  const testCase = await service.createTestCase(req.user!, req.body)
  await recordAudit({
    req,
    action: 'testcase.created',
    entityType: 'TestCase',
    entityId: testCase.id,
    after: { title: testCase.title, buildId: testCase.buildId },
  })
  res.status(201).json({ data: testCase })
}

export async function update(req: Request, res: Response): Promise<void> {
  const testCase = await service.updateTestCase(req.user!, param(req, 'id'), req.body)
  await recordAudit({
    req,
    action: 'testcase.updated',
    entityType: 'TestCase',
    entityId: testCase.id,
    after: req.body,
  })
  res.json({ data: testCase })
}

export async function remove(req: Request, res: Response): Promise<void> {
  await service.deleteTestCase(req.user!, param(req, 'id'))
  await recordAudit({
    req,
    action: 'testcase.deleted',
    entityType: 'TestCase',
    entityId: param(req, 'id'),
  })
  res.status(204).send()
}

export async function assign(req: Request, res: Response): Promise<void> {
  const testCase = await service.assignTesters(req.user!, param(req, 'id'), req.body.testerIds)
  await recordAudit({
    req,
    action: 'testcase.assigned',
    entityType: 'TestCase',
    entityId: param(req, 'id'),
    after: { testerIds: req.body.testerIds },
  })
  res.status(201).json({ data: testCase })
}

export async function unassign(req: Request, res: Response): Promise<void> {
  await service.unassignTester(req.user!, param(req, 'id'), param(req, 'testerId'))
  res.status(204).send()
}

export async function createReport(req: Request, res: Response): Promise<void> {
  const report = await service.createTestReport(req.user!, param(req, 'id'), req.body)
  await recordAudit({
    req,
    action: 'testreport.created',
    entityType: 'TestReport',
    entityId: report.id,
    after: { result: report.result, testCaseId: param(req, 'id') },
  })
  res.status(201).json({ data: report })
}

export async function listReviews(req: Request, res: Response): Promise<void> {
  res.json({ data: await service.listTestReviews(req.user!, param(req, 'buildId')) })
}

export async function createReview(req: Request, res: Response): Promise<void> {
  const review = await service.createTestReview(req.user!, param(req, 'buildId'), req.body)
  await recordAudit({
    req,
    action: 'testreview.created',
    entityType: 'TestReview',
    entityId: review.id,
    after: { buildId: param(req, 'buildId'), rating: review.rating },
  })
  res.status(201).json({ data: review })
}

export async function summary(req: Request, res: Response): Promise<void> {
  res.json({ data: await service.buildSummary(req.user!, param(req, 'buildId')) })
}
