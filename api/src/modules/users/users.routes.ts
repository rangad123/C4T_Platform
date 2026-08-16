import { Router } from 'express'
import { param } from '../../lib/http.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { recordAudit } from '../../lib/audit.js'
import { timestampedFilename } from '../../lib/csv.js'
import { PERMISSIONS } from '../../config/permissions.js'
import * as service from './users.service.js'
import {
  listUsersQuery,
  createUserSchema,
  updateUserSchema,
  updateOwnProfileSchema,
  changeUserRoleSchema,
  changeUserStatusSchema,
  setPermissionsSchema,
  userIdParam,
  type ListUsersQuery,
} from './users.schema.js'

export const usersRouter = Router()

usersRouter.use(authenticate)

// ─── Own profile — any authenticated role ────────────────────────────────────

usersRouter.get('/me', async (req, res) => {
  res.json({ data: await service.getUser(req.user!.id) })
})

usersRouter.patch('/me', validate({ body: updateOwnProfileSchema }), async (req, res) => {
  res.json({ data: await service.updateUser(req.user!.id, req.body) })
})

// ─── Permission catalogue — needed to render the Sub-Admin editor ────────────

usersRouter.get(
  '/permissions/catalogue',
  requirePermission(PERMISSIONS.SUBADMIN_MANAGE),
  async (_req, res) => {
    res.json({ data: await service.listPermissionCatalogue() })
  },
)

// ─── Admin user management (§2.2) ────────────────────────────────────────────

usersRouter.get(
  '/',
  requirePermission(PERMISSIONS.USER_READ),
  validate({ query: listUsersQuery }),
  async (_req, res) => {
    const query = validatedQuery<ListUsersQuery>(res)
    const { items, meta } = await service.listUsers(query)
    res.json({ data: items, meta })
  },
)

/**
 * CSV export — declared before "/:id" so "export.csv" is not consumed as an
 * id with a dot in it. The query schema is the same shape as the list
 * endpoint, minus pagination.
 */
usersRouter.get(
  '/export.csv',
  requirePermission(PERMISSIONS.USER_READ),
  validate({ query: listUsersQuery }),
  async (_req, res) => {
    const query = validatedQuery<ListUsersQuery>(res)
    const csv = await service.exportUsersCSV(query)
    res.setHeader('content-type', 'text/csv; charset=utf-8')
    res.setHeader('content-disposition', `attachment; filename="${timestampedFilename('users')}"`)
    res.send(csv)
  },
)

usersRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.USER_READ),
  validate({ params: userIdParam }),
  async (req, res) => {
    res.json({ data: await service.getUser(param(req, 'id')) })
  },
)

usersRouter.post(
  '/',
  requirePermission(PERMISSIONS.USER_WRITE),
  validate({ body: createUserSchema }),
  async (req, res) => {
    const user = await service.createUser(req.body)
    await recordAudit({
      req,
      action: 'user.created',
      entityType: 'User',
      entityId: user.id,
      after: { email: user.email, role: user.role },
    })
    res.status(201).json({ data: user })
  },
)

usersRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.USER_WRITE),
  validate({ params: userIdParam, body: updateUserSchema }),
  async (req, res) => {
    res.json({ data: await service.updateUser(param(req, 'id'), req.body) })
  },
)

usersRouter.post(
  '/:id/role',
  requirePermission(PERMISSIONS.USER_WRITE),
  validate({ params: userIdParam, body: changeUserRoleSchema }),
  async (req, res) => {
    const user = await service.changeRole(req.user!.id, param(req, 'id'), req.body.role)
    await recordAudit({
      req,
      action: 'user.role_changed',
      entityType: 'User',
      entityId: param(req, 'id'),
      after: { role: req.body.role },
    })
    res.json({ data: user })
  },
)

usersRouter.post(
  '/:id/status',
  requirePermission(PERMISSIONS.USER_WRITE),
  validate({ params: userIdParam, body: changeUserStatusSchema }),
  async (req, res) => {
    const user = await service.changeStatus(param(req, 'id'), req.body.status)
    await recordAudit({
      req,
      action: 'user.status_changed',
      entityType: 'User',
      entityId: param(req, 'id'),
      after: { status: req.body.status, reason: req.body.reason },
    })
    res.json({ data: user })
  },
)

usersRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.USER_WRITE),
  validate({ params: userIdParam }),
  async (req, res) => {
    const result = await service.deleteUser(param(req, 'id'))
    await recordAudit({
      req,
      action: 'user.deleted',
      entityType: 'User',
      entityId: param(req, 'id'),
    })
    res.json({ data: result })
  },
)

// ─── Sub-Admin permission grants (§2.2 "Sub-Admin Permissions") ──────────────

usersRouter.get(
  '/:id/permissions',
  requirePermission(PERMISSIONS.SUBADMIN_MANAGE),
  validate({ params: userIdParam }),
  async (req, res) => {
    res.json({ data: await service.getUserPermissions(param(req, 'id')) })
  },
)

usersRouter.put(
  '/:id/permissions',
  requirePermission(PERMISSIONS.SUBADMIN_MANAGE),
  validate({ params: userIdParam, body: setPermissionsSchema }),
  async (req, res) => {
    const permissions = await service.setUserPermissions(
      req.user!.id,
      param(req, 'id'),
      req.body.permissionCodes,
    )
    await recordAudit({
      req,
      action: 'user.permissions_set',
      entityType: 'User',
      entityId: param(req, 'id'),
      after: { permissionCodes: req.body.permissionCodes },
    })
    res.json({ data: permissions })
  },
)
