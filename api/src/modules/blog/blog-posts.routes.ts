import { Router } from 'express'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { PERMISSIONS } from '../../config/permissions.js'
import * as controller from './blog-posts.controller.js'
import {
  adminListPostsQuery,
  publicListPostsQuery,
  createPostSchema,
  updatePostSchema,
  scheduleSchema,
  postIdParam,
  postSlugParam,
} from './blog-posts.schema.js'

/**
 * Public reads live at the router root, entirely unauthenticated — marketing-
 * site visitors and search crawlers never hold a session. Every admin
 * mutation lives under `/admin`, gated by `authenticate` + `requirePermission`
 * on that one sub-path rather than the whole router — unlike `catalog.routes.ts`
 * (which can blanket-gate because it has no public reads at all), this module
 * genuinely needs both, so it follows `leads.routes.ts`'s "public routes
 * first, admin routes apply auth per-branch" shape instead.
 *
 * ⚠ REGISTRATION ORDER MATTERS. `/admin` MUST be registered before the public
 * `GET /:slug` below — Express matches routes in registration order, and
 * `/:slug` matches any single path segment, `admin` included. Registering it
 * first silently swallowed every request to `/admin/*` as a slug lookup
 * (caught in Phase 1 verification: `GET /posts/admin` returned 404 instead
 * of the expected 401, because it never reached the admin router at all).
 */
export const blogPostsRouter = Router()

// ─── Public list ───────────────────────────────────────────────────────────

blogPostsRouter.get('/', validate({ query: publicListPostsQuery }), controller.listPublic)

// A slug-scoped preview for the admin editor's "Preview" button — any
// status, no view-count bump. `/:slug/preview` is a distinct two-segment
// path, so it can't collide with `/:slug` regardless of order, but it's
// grouped with the rest of the admin surface below for readability.
blogPostsRouter.get(
  '/:slug/preview',
  authenticate,
  requirePermission(PERMISSIONS.BLOG_READ),
  validate({ params: postSlugParam }),
  controller.preview,
)

// ─── Admin ─────────────────────────────────────────────────────────────────

const admin = Router()
admin.use(authenticate)

admin.get(
  '/',
  requirePermission(PERMISSIONS.BLOG_READ),
  validate({ query: adminListPostsQuery }),
  controller.listAdmin,
)
admin.get('/:id', requirePermission(PERMISSIONS.BLOG_READ), validate({ params: postIdParam }), controller.getAdmin)
admin.post(
  '/',
  requirePermission(PERMISSIONS.BLOG_WRITE),
  validate({ body: createPostSchema }),
  controller.create,
)
admin.patch(
  '/:id',
  requirePermission(PERMISSIONS.BLOG_WRITE),
  validate({ params: postIdParam, body: updatePostSchema }),
  controller.update,
)
admin.post(
  '/:id/publish',
  requirePermission(PERMISSIONS.BLOG_PUBLISH),
  validate({ params: postIdParam }),
  controller.publish,
)
admin.post(
  '/:id/schedule',
  requirePermission(PERMISSIONS.BLOG_PUBLISH),
  validate({ params: postIdParam, body: scheduleSchema }),
  controller.schedule,
)
admin.post(
  '/:id/archive',
  requirePermission(PERMISSIONS.BLOG_PUBLISH),
  validate({ params: postIdParam }),
  controller.archive,
)
admin.post(
  '/:id/revert-to-draft',
  requirePermission(PERMISSIONS.BLOG_PUBLISH),
  validate({ params: postIdParam }),
  controller.revertToDraft,
)
admin.delete(
  '/:id',
  requirePermission(PERMISSIONS.BLOG_DELETE),
  validate({ params: postIdParam }),
  controller.remove,
)

blogPostsRouter.use('/admin', admin)

// ─── Public get-by-slug ─────────────────────────────────────────────────────
// Registered LAST — see the warning above. Anything not already matched by
// a route above (including `/admin/*`) falls through to here as a slug.

blogPostsRouter.get('/:slug', validate({ params: postSlugParam }), controller.getPublic)
