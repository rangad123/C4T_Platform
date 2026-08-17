import { Router } from 'express'
import { z } from 'zod'
import { Role } from '@prisma/client'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission, requireRole } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { PERMISSIONS } from '../../config/permissions.js'
import * as controller from './testers.controller.js'
import {
  listTestersQuery,
  updateTesterProfileSchema,
  changeTesterStatusSchema,
  deviceSchema,
  skillsSchema,
  languagesSchema,
  setSkillCategorySchema,
  acceptNdaSchema,
  workHistorySchema,
  listGlobalDevicesQuery,
  testerIdParam,
  deviceIdParam,
  workHistoryIdParam,
} from './testers.schema.js'

export const testersRouter = Router()

testersRouter.use(authenticate)

// ─── Tester self-service (§2.3 "Manage their tester profile") ────────────────
// Declared before "/:id" so "me" is never parsed as an id.

const me = Router()
me.use(requireRole(Role.TESTER))
me.get('/', controller.getMine)
me.patch('/', validate({ body: updateTesterProfileSchema }), controller.updateMine)
me.post('/devices', validate({ body: deviceSchema }), controller.addDevice)
me.delete('/devices/:deviceId', validate({ params: deviceIdParam }), controller.removeDevice)
me.post('/work-history', validate({ body: workHistorySchema }), controller.addWorkHistory)
me.delete(
  '/work-history/:workHistoryId',
  validate({ params: workHistoryIdParam }),
  controller.removeWorkHistory,
)
me.put('/skills', validate({ body: skillsSchema }), controller.setSkills)
me.put('/languages', validate({ body: languagesSchema }), controller.setLanguages)
me.post('/nda', validate({ body: acceptNdaSchema }), controller.acceptNda)

testersRouter.use('/me', me)

// ─── Admin: crowd tester management (§2.2) ───────────────────────────────────

testersRouter.get(
  '/',
  requirePermission(PERMISSIONS.TESTER_READ),
  validate({ query: listTestersQuery }),
  controller.list,
)

/**
 * CSV export — declared before "/:id" so "export.csv" is not consumed as an
 * id with a dot in it. The query schema is the same shape as the list
 * endpoint, minus pagination.
 */
testersRouter.get(
  '/export.csv',
  requirePermission(PERMISSIONS.TESTER_READ),
  validate({ query: listTestersQuery }),
  controller.exportCsv,
)

/**
 * §18 Global Assets — every device (and, filtered, every recorded browser)
 * across every tester. Declared before "/:id" for the same reason as
 * "export.csv" — "devices" must never be parsed as an id.
 */
testersRouter.get(
  '/devices',
  requirePermission(PERMISSIONS.TESTER_READ),
  validate({ query: listGlobalDevicesQuery }),
  controller.listGlobalDevices,
)

testersRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.TESTER_READ),
  validate({ params: testerIdParam }),
  controller.getOne,
)

// ─── Skill taxonomy (admin-only) ─────────────────────────────────────────────

const skillIdParam = z.object({ skillId: z.string().cuid() })

testersRouter.get(
  '/skills/catalogue',
  requireRole(Role.ADMIN, Role.SUB_ADMIN),
  controller.listSkillCatalogue,
)

testersRouter.patch(
  '/skills/:skillId/category',
  requireRole(Role.ADMIN, Role.SUB_ADMIN),
  validate({ params: skillIdParam, body: setSkillCategorySchema }),
  controller.setSkillCategory,
)

/**
 * Verification and suspension are separate permissions in the catalogue, but a
 * single endpoint. requireAnyPermission is not used here deliberately: the
 * service branches on the target status, so the route requires the stricter of
 * the two and Admins bypass both anyway.
 */
testersRouter.patch(
  '/:id/status',
  requirePermission(PERMISSIONS.TESTER_VERIFY),
  validate({ params: testerIdParam, body: changeTesterStatusSchema }),
  controller.changeStatus,
)
