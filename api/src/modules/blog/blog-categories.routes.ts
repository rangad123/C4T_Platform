import { Router } from 'express'
import { z } from 'zod'
import { BlogPostStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { param } from '../../lib/http.js'
import { slugify } from '../../lib/slug.js'
import { NotFoundError } from '../../lib/errors.js'
import { recordAudit } from '../../lib/audit.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { PERMISSIONS } from '../../config/permissions.js'

/**
 * Flat, catalog-style module — like `catalog.routes.ts`, except reads here
 * are genuinely PUBLIC (no `authenticate` at all), since the marketing site
 * and search crawlers read categories with no session. Only writes are
 * gated. Retiring a category sets `isActive = false`, never a hard delete —
 * existing posts keep their `categoryId`, the category just stops being
 * offered for new/edited posts and drops out of the public category list.
 */
export const blogCategoriesRouter = Router()

function effectivelyPublishedWhere() {
  return {
    deletedAt: null,
    OR: [
      { status: BlogPostStatus.PUBLISHED },
      { status: BlogPostStatus.SCHEDULED, scheduledAt: { lte: new Date() } },
    ],
  }
}

// ─── Public ────────────────────────────────────────────────────────────────

blogCategoriesRouter.get('/', async (req, res) => {
  const categories = await prisma.blogCategory.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      _count: { select: { posts: { where: effectivelyPublishedWhere() } } },
    },
    orderBy: { name: 'asc' },
  })
  res.json({
    data: categories.map(({ _count, ...c }) => ({ ...c, postCount: _count.posts })),
  })
})

/**
 * Every category, active or retired, with its live+scheduled post count —
 * what the admin categories page needs to show a retired category with a
 * "Reactivate" control instead of it just vanishing.
 *
 * ⚠ Registered BEFORE the public `GET /:slug` below, same reason as the
 * equivalent warning in `blog-posts.routes.ts`: both are GET, and `/:slug`
 * matches any single segment — "admin" included — so registering it after
 * would silently swallow this route as a slug lookup.
 */
blogCategoriesRouter.get(
  '/admin',
  authenticate,
  requirePermission(PERMISSIONS.BLOG_READ),
  async (req, res) => {
    const categories = await prisma.blogCategory.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        isActive: true,
        _count: { select: { posts: { where: effectivelyPublishedWhere() } } },
      },
      orderBy: { name: 'asc' },
    })
    res.json({
      data: categories.map(({ _count, ...c }) => ({ ...c, postCount: _count.posts })),
    })
  },
)

blogCategoriesRouter.get(
  '/:slug',
  validate({ params: z.object({ slug: z.string() }) }),
  async (req, res) => {
    const category = await prisma.blogCategory.findFirst({
      where: { slug: param(req, 'slug'), isActive: true },
      select: { id: true, name: true, slug: true, description: true },
    })
    if (!category) throw new NotFoundError('Category')
    res.json({ data: category })
  },
)

// ─── Admin ─────────────────────────────────────────────────────────────────

const createSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(300).optional(),
})
const updateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(300).optional(),
  isActive: z.boolean().optional(),
})
const idParam = z.object({ id: z.string().cuid() })

async function uniqueCategorySlug(name: string, excludeId?: string): Promise<string> {
  const stem = slugify(name)
  let slug = stem
  let i = 2
  while (true) {
    const taken = await prisma.blogCategory.findFirst({
      where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    })
    if (!taken) return slug
    slug = `${stem}-${i++}`
  }
}

blogCategoriesRouter.post(
  '/',
  authenticate,
  requirePermission(PERMISSIONS.BLOG_MANAGE_CATEGORIES),
  validate({ body: createSchema }),
  async (req, res) => {
    const slug = await uniqueCategorySlug(req.body.name)
    const category = await prisma.blogCategory.create({
      data: { name: req.body.name, slug, description: req.body.description },
    })
    await recordAudit({
      req,
      action: 'blog_category.created',
      entityType: 'BlogCategory',
      entityId: category.id,
      after: category,
    })
    res.status(201).json({ data: category })
  },
)

blogCategoriesRouter.patch(
  '/:id',
  authenticate,
  requirePermission(PERMISSIONS.BLOG_MANAGE_CATEGORIES),
  validate({ params: idParam, body: updateSchema }),
  async (req, res) => {
    const id = param(req, 'id')
    const existing = await prisma.blogCategory.findUnique({ where: { id } })
    if (!existing) throw new NotFoundError('Category')

    const slug =
      req.body.name && req.body.name !== existing.name
        ? await uniqueCategorySlug(req.body.name, id)
        : undefined

    const category = await prisma.blogCategory.update({
      where: { id },
      data: {
        ...(req.body.name !== undefined ? { name: req.body.name } : {}),
        ...(slug ? { slug } : {}),
        ...(req.body.description !== undefined ? { description: req.body.description } : {}),
        ...(req.body.isActive !== undefined ? { isActive: req.body.isActive } : {}),
      },
    })
    await recordAudit({
      req,
      action: 'blog_category.updated',
      entityType: 'BlogCategory',
      entityId: id,
      after: category,
    })
    res.json({ data: category })
  },
)
