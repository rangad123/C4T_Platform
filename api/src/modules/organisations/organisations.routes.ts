import { Router } from 'express'
import { Role } from '@prisma/client'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission, requireRole } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { PERMISSIONS } from '../../config/permissions.js'
import * as controller from './organisations.controller.js'
import {
  listOrganisationsQuery,
  createOrganisationSchema,
  updateOrganisationSchema,
  updateOwnOrganisationSchema,
  addMemberSchema,
  updateMemberSchema,
  orgIdParam,
  orgMemberParam,
} from './organisations.schema.js'

export const organisationsRouter = Router()

organisationsRouter.use(authenticate)

// ─── Customer-scoped (§2.4) ──────────────────────────────────────────────────

/** Organisations the caller belongs to. Must be declared before "/:id". */
organisationsRouter.get('/mine', controller.listMine)

// ─── Admin-scoped (§2.2 Organisation Management) ─────────────────────────────

/**
 * Scoped by the caller rather than permission-gated: an admin sees every
 * organisation, a customer sees theirs, a tester sees none. That keeps this
 * list consistent with the detail endpoint below — see the invariant test in
 * tests/access/consistency.test.ts.
 */
organisationsRouter.get('/', validate({ query: listOrganisationsQuery }), controller.list)
/**
 * CSV export — declared before "/:id" so "export.csv" is not consumed as an
 * id with a dot in it. The query schema is the same shape as the list
 * endpoint, minus pagination.
 */
organisationsRouter.get('/export.csv', validate({ query: listOrganisationsQuery }), controller.exportCsv)

organisationsRouter.post(
  '/',
  requirePermission(PERMISSIONS.ORGANISATION_WRITE),
  validate({ body: createOrganisationSchema }),
  controller.create,
)

organisationsRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.ORGANISATION_DELETE),
  validate({ params: orgIdParam }),
  controller.archive,
)

// ─── Mixed access: service layer scopes by membership ────────────────────────

organisationsRouter.get('/:id', validate({ params: orgIdParam }), controller.getOne)

/**
 * Admins get the full update schema (status, internal notes). Customers get the
 * profile-only schema. Two routes rather than one branching handler, so the
 * validation contract is explicit per audience.
 */
organisationsRouter.patch(
  '/:id',
  requireRole(Role.ADMIN, Role.SUB_ADMIN),
  requirePermission(PERMISSIONS.ORGANISATION_WRITE),
  validate({ params: orgIdParam, body: updateOrganisationSchema }),
  controller.update,
)

organisationsRouter.patch(
  '/:id/profile',
  requireRole(Role.CUSTOMER),
  validate({ params: orgIdParam, body: updateOwnOrganisationSchema }),
  controller.update,
)

organisationsRouter.post(
  '/:id/members',
  validate({ params: orgIdParam, body: addMemberSchema }),
  controller.addMember,
)

organisationsRouter.patch(
  '/:id/members/:userId',
  validate({ params: orgMemberParam, body: updateMemberSchema }),
  controller.updateMember,
)

organisationsRouter.delete(
  '/:id/members/:userId',
  validate({ params: orgMemberParam }),
  controller.removeMember,
)
