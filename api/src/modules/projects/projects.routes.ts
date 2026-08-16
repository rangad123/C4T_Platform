import { Router } from 'express'
import { z } from 'zod'
import { Role, AssignmentStatus } from '@prisma/client'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission, requireRole } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { paginationQuery } from '../../lib/pagination.js'
import { PERMISSIONS } from '../../config/permissions.js'
import * as controller from './projects.controller.js'
import {
  listProjectsQuery,
  createProjectSchema,
  updateProjectSchema,
  changeProjectStatusSchema,
  addMaterialSchema,
  addFeatureSchema,
  assignTestersSchema,
  respondToAssignmentSchema,
  updateAssignmentSchema,
  projectIdParam,
  materialParam,
  featureParam,
  assignmentParam,
} from './projects.schema.js'

export const projectsRouter = Router()

projectsRouter.use(authenticate)

// ─── Tester view (§2.3) — declared before "/:id" ─────────────────────────────

projectsRouter.get(
  '/my-assignments',
  requireRole(Role.TESTER),
  validate({
    query: paginationQuery.extend({ status: z.nativeEnum(AssignmentStatus).optional() }),
  }),
  controller.listMyAssignments,
)

// ─── Shared list/detail — the service scopes results by role ─────────────────

projectsRouter.get('/', validate({ query: listProjectsQuery }), controller.list)
/**
 * CSV export — declared before "/:id" so "export.csv" is not consumed as an
 * id with a dot in it. The query schema is the same shape as the list
 * endpoint, minus pagination.
 */
projectsRouter.get('/export.csv', validate({ query: listProjectsQuery }), controller.exportCsv)
projectsRouter.get('/:id', validate({ params: projectIdParam }), controller.getOne)

// ─── Create / edit — Customers (own org) and Admin ───────────────────────────

projectsRouter.post(
  '/',
  requireRole(Role.CUSTOMER, Role.ADMIN, Role.SUB_ADMIN),
  validate({ body: createProjectSchema }),
  controller.create,
)

projectsRouter.patch(
  '/:id',
  requireRole(Role.CUSTOMER, Role.ADMIN, Role.SUB_ADMIN),
  validate({ params: projectIdParam, body: updateProjectSchema }),
  controller.update,
)

/**
 * Status changes. Customers may only submit a draft; the service enforces that.
 * No requirePermission here because a Customer must be able to reach it —
 * authorisation is decided inside changeStatus().
 */
projectsRouter.post(
  '/:id/status',
  requireRole(Role.CUSTOMER, Role.ADMIN, Role.SUB_ADMIN),
  validate({ params: projectIdParam, body: changeProjectStatusSchema }),
  controller.changeStatus,
)

projectsRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.PROJECT_DELETE),
  validate({ params: projectIdParam }),
  controller.archive,
)

// ─── Materials ───────────────────────────────────────────────────────────────

projectsRouter.post(
  '/:id/materials',
  requireRole(Role.CUSTOMER, Role.ADMIN, Role.SUB_ADMIN),
  validate({ params: projectIdParam, body: addMaterialSchema }),
  controller.addMaterial,
)

projectsRouter.delete(
  '/:id/materials/:materialId',
  requireRole(Role.CUSTOMER, Role.ADMIN, Role.SUB_ADMIN),
  validate({ params: materialParam }),
  controller.removeMaterial,
)

// ─── Features ────────────────────────────────────────────────────────────────

projectsRouter.get(
  '/:id/features',
  validate({ params: projectIdParam }),
  controller.listFeatures,
)

projectsRouter.post(
  '/:id/features',
  requireRole(Role.CUSTOMER, Role.ADMIN, Role.SUB_ADMIN),
  validate({ params: projectIdParam, body: addFeatureSchema }),
  controller.addFeature,
)

projectsRouter.delete(
  '/:id/features/:featureId',
  requireRole(Role.CUSTOMER, Role.ADMIN, Role.SUB_ADMIN),
  validate({ params: featureParam }),
  controller.removeFeature,
)

// ─── Assignments ─────────────────────────────────────────────────────────────

projectsRouter.post(
  '/:id/assignments',
  requirePermission(PERMISSIONS.PROJECT_ASSIGN),
  validate({ params: projectIdParam, body: assignTestersSchema }),
  controller.assignTesters,
)

projectsRouter.patch(
  '/:id/assignments/:testerId',
  requirePermission(PERMISSIONS.PROJECT_ASSIGN),
  validate({ params: assignmentParam, body: updateAssignmentSchema }),
  controller.updateAssignment,
)

/** Tester accepting or declining their own invitation. */
projectsRouter.post(
  '/:id/respond',
  requireRole(Role.TESTER),
  validate({ params: projectIdParam, body: respondToAssignmentSchema }),
  controller.respondToAssignment,
)
