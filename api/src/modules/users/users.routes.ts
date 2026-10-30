import { Router } from 'express'
import { param } from '../../lib/http.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { recordAudit } from '../../lib/audit.js'
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
  permissionCatalogueQuery,
  userIdParam,
  type ListUsersQuery,
  type PermissionCatalogueQuery,
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

/**
 * Close your own account.
 *
 * Reuses `deleteUser` rather than defining a second kind of deletion — the
 * retention rules are a property of the platform, not of who pressed the
 * button. So this is the same soft delete an admin performs: the row stays
 * for the bugs and payouts that reference it, the email is released for
 * reuse, and every session is revoked.
 *
 * The id is the caller's own, taken from the session and never from the
 * request, so this route cannot be pointed at anybody else. Deleting other
 * people remains `DELETE /users/:id`, behind `user.write`.
 *
 * Declared before `/:id` so "me" is never parsed as an id.
 */
usersRouter.delete('/me', async (req, res) => {
  const result = await service.deleteUser(req.user!.id)
  await recordAudit({
    req,
    action: 'user.self_deleted',
    entityType: 'User',
    entityId: req.user!.id,
  })
  res.json({ data: result })
})

// ─── Permission catalogue — renders the Sub-Admin and AI Studio editors ──────

usersRouter.get(
  '/permissions/catalogue',
  requirePermission(PERMISSIONS.SUBADMIN_MANAGE),
  validate({ query: permissionCatalogueQuery }),
  async (_req, res) => {
    const query = validatedQuery<PermissionCatalogueQuery>(res)
    res.json({ data: await service.listPermissionCatalogue(query.grantableTo) })
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
    const user = await service.createUser(req.user!, req.body)
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
    await service.assertMayManage(req.user!, param(req, 'id'))
    res.json({ data: await service.updateUser(param(req, 'id'), req.body) })
  },
)

usersRouter.post(
  '/:id/role',
  requirePermission(PERMISSIONS.USER_WRITE),
  validate({ params: userIdParam, body: changeUserRoleSchema }),
  async (req, res) => {
    await service.assertMayManage(req.user!, param(req, 'id'), req.body.role)
    const { user, revokedPermissionCodes } = await service.changeRole(
      req.user!,
      param(req, 'id'),
      req.body.role,
    )
    await recordAudit({
      req,
      action: 'user.role_changed',
      entityType: 'User',
      entityId: param(req, 'id'),
      after: {
        role: req.body.role,
        ...(revokedPermissionCodes.length > 0 ? { revokedPermissionCodes } : {}),
      },
    })
    res.json({ data: user })
  },
)

usersRouter.post(
  '/:id/status',
  requirePermission(PERMISSIONS.USER_WRITE),
  validate({ params: userIdParam, body: changeUserStatusSchema }),
  async (req, res) => {
    await service.assertMayManage(req.user!, param(req, 'id'))
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
    await service.assertMayManage(req.user!, param(req, 'id'))
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

usersRouter.post(
  '/:id/resend-verification',
  requirePermission(PERMISSIONS.USER_WRITE),
  validate({ params: userIdParam }),
  async (req, res) => {
    await service.resendVerificationEmail(param(req, 'id'))
    await recordAudit({
      req,
      action: 'user.verification_resent',
      entityType: 'User',
      entityId: param(req, 'id'),
    })
    res.status(204).end()
  },
)

// ─── Permission grants (§2.2 "Sub-Admin Permissions", and AI Studio access) ──
// Customers and testers may hold AI Studio codes too; the rules are in
// permission-rules.ts. The guard stays subadmin.manage for every target.

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
    const { previousCodes, permissions } = await service.setUserPermissions(
      req.user!,
      param(req, 'id'),
      req.body.permissionCodes,
      req.body.scope,
    )
    await recordAudit({
      req,
      action: 'user.permissions_set',
      entityType: 'User',
      entityId: param(req, 'id'),
      before: { scope: req.body.scope, permissionCodes: previousCodes },
      after: { scope: req.body.scope, permissionCodes: req.body.permissionCodes },
    })
    res.json({ data: permissions })
  },
)
