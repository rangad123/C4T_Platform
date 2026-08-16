import { Router } from 'express'
import { authenticate } from '../../middleware/authenticate.js'
import { validate } from '../../middleware/validate.js'
import * as controller from './bugs.controller.js'
import {
  listBugsQuery,
  createBugSchema,
  updateBugSchema,
  changeBugStatusSchema,
  bulkChangeBugStatusSchema,
  addCommentSchema,
  addAttachmentSchema,
  bugIdParam,
  bugAttachmentParam,
} from './bugs.schema.js'

/**
 * Authorisation for bugs is RELATIONSHIP-based, so these routes carry no role
 * or permission guards beyond authentication.
 *
 * Whether you may act on a given bug depends on your relationship to it —
 * reporter, the customer whose project it is, an assigned manager, or platform
 * staff — which cannot be known from the URL alone. Every decision is made in
 * bugs.service.ts against lib/access/policy.ts. Putting a `requirePermission`
 * here would wrongly lock out the customer whose product the bug is in.
 */
export const bugsRouter = Router()

bugsRouter.use(authenticate)

bugsRouter.get('/', validate({ query: listBugsQuery }), controller.list)
/**
 * CSV export — declared before `/:id` so "export.csv" is not consumed as an
 * id with a dot in it. The query schema is the same shape as the list
 * endpoint, minus pagination.
 */
bugsRouter.get('/export.csv', validate({ query: listBugsQuery }), controller.exportCsv)
bugsRouter.get('/:id', validate({ params: bugIdParam }), controller.getOne)

/** Creating requires an active assignment — enforced in the service. */
bugsRouter.post('/', validate({ body: createBugSchema }), controller.create)

bugsRouter.patch('/:id', validate({ params: bugIdParam, body: updateBugSchema }), controller.update)

/**
 * Triage, resolve, verify and reopen are all this one endpoint. The transition
 * matrix decides what each party may do from the bug's current state.
 */
bugsRouter.post(
  '/:id/status',
  validate({ params: bugIdParam, body: changeBugStatusSchema }),
  controller.changeStatus,
)

/** Retained as an alias so existing triage integrations keep working. */
bugsRouter.post(
  '/:id/triage',
  validate({ params: bugIdParam, body: changeBugStatusSchema }),
  controller.changeStatus,
)

/**
 * Bulk status / severity change. Admin-side only — a customer marking dozens
 * of bugs fixed in one click is a workflow we don't want to expose yet, and
 * the transition matrix requires `bug.change_status` which is admin-shaped.
 */
bugsRouter.post(
  '/bulk-status',
  validate({ body: bulkChangeBugStatusSchema }),
  controller.bulkStatus,
)

bugsRouter.delete('/:id', validate({ params: bugIdParam }), controller.remove)

bugsRouter.post(
  '/:id/comments',
  validate({ params: bugIdParam, body: addCommentSchema }),
  controller.addComment,
)

bugsRouter.post(
  '/:id/attachments',
  validate({ params: bugIdParam, body: addAttachmentSchema }),
  controller.addAttachment,
)

bugsRouter.delete(
  '/:id/attachments/:attachmentId',
  validate({ params: bugAttachmentParam }),
  controller.removeAttachment,
)
