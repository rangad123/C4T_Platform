import { Router } from 'express'
import { authenticate } from '../../middleware/authenticate.js'
import { validate } from '../../middleware/validate.js'
import * as controller from './testing.controller.js'
import * as workflow from './workflow.controller.js'
import * as wf from './workflow.schema.js'
import {
  listTestCasesQuery,
  createTestCaseSchema,
  updateTestCaseSchema,
  assignTestCaseSchema,
  createTestReportSchema,
  createTestReviewSchema,
  testCaseIdParam,
  testCaseAssignmentParam,
  buildIdParam,
} from './testing.schema.js'

/**
 * Structured testing workflow — test cases, execution reports, reviews.
 *
 * Authorisation is RELATIONSHIP-based, same reasoning as bugs.routes.ts: who
 * may read or write a test case depends on the caller's relationship to the
 * PROJECT the case's build belongs to, which cannot be known from the URL
 * alone. Every decision is made in testing.service.ts against policy.ts.
 */
export const testingRouter = Router()

testingRouter.use(authenticate)

testingRouter.get('/test-cases', validate({ query: listTestCasesQuery }), controller.list)
testingRouter.post('/test-cases', validate({ body: createTestCaseSchema }), controller.create)
testingRouter.get('/test-cases/:id', validate({ params: testCaseIdParam }), controller.getOne)
testingRouter.patch(
  '/test-cases/:id',
  validate({ params: testCaseIdParam, body: updateTestCaseSchema }),
  controller.update,
)
testingRouter.delete('/test-cases/:id', validate({ params: testCaseIdParam }), controller.remove)

testingRouter.post(
  '/test-cases/:id/assignments',
  validate({ params: testCaseIdParam, body: assignTestCaseSchema }),
  controller.assign,
)
testingRouter.delete(
  '/test-cases/:id/assignments/:testerId',
  validate({ params: testCaseAssignmentParam }),
  controller.unassign,
)

testingRouter.post(
  '/test-cases/:id/reports',
  validate({ params: testCaseIdParam, body: createTestReportSchema }),
  controller.createReport,
)

testingRouter.get(
  '/builds/:buildId/test-reviews',
  validate({ params: buildIdParam }),
  controller.listReviews,
)
testingRouter.post(
  '/builds/:buildId/test-reviews',
  validate({ params: buildIdParam, body: createTestReviewSchema }),
  controller.createReview,
)

testingRouter.get(
  '/builds/:buildId/summary',
  validate({ params: buildIdParam }),
  controller.summary,
)

// ─── Applications, execution reviews, timesheets, scenarios ──────────────────
// Same relationship-based model: every decision is made in workflow.service.ts.

testingRouter.put(
  '/builds/:buildId/applications-open',
  validate({ params: wf.buildIdParam, body: wf.setApplicationsOpenSchema }),
  workflow.setApplicationsOpen,
)
testingRouter.get('/open-builds', workflow.listOpenBuilds)
testingRouter.get(
  '/applications',
  validate({ query: wf.listApplicationsQuery }),
  workflow.listApplications,
)
testingRouter.post('/applications', validate({ body: wf.applySchema }), workflow.apply)
testingRouter.post(
  '/applications/:id/decision',
  validate({ params: wf.idParam, body: wf.decideApplicationSchema }),
  workflow.decideApplication,
)
testingRouter.post(
  '/applications/:id/withdraw',
  validate({ params: wf.idParam }),
  workflow.withdrawApplication,
)

testingRouter.get(
  '/test-reports',
  validate({ query: wf.listExecutionsQuery }),
  workflow.listExecutions,
)
testingRouter.post(
  '/test-reports/:id/review',
  validate({ params: wf.idParam, body: wf.reviewExecutionSchema }),
  workflow.reviewExecution,
)

testingRouter.get(
  '/timesheets',
  validate({ query: wf.listTimesheetsQuery }),
  workflow.listTimesheets,
)
testingRouter.post('/timesheets', validate({ body: wf.logTimeSchema }), workflow.logTime)
testingRouter.post(
  '/timesheets/:id/review',
  validate({ params: wf.idParam, body: wf.reviewTimesheetSchema }),
  workflow.reviewTimesheet,
)

testingRouter.get(
  '/builds/:buildId/test-scenarios',
  validate({ params: wf.buildIdParam }),
  workflow.listScenarios,
)
testingRouter.post(
  '/builds/:buildId/test-scenarios',
  validate({ params: wf.buildIdParam, body: wf.createScenarioSchema }),
  workflow.createScenario,
)
testingRouter.delete(
  '/test-scenarios/:id',
  validate({ params: wf.idParam }),
  workflow.deleteScenario,
)
