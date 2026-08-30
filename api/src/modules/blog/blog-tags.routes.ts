import { Router } from 'express'
import { z } from 'zod'
import { BlogPostStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { param } from '../../lib/http.js'
import { slugify } from '../../lib/slug.js'
import { NotFoundError } from '../../lib/errors.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { PERMISSIONS } from '../../config/permissions.js'

/**
 * Deliberately minimal — name+slug only, no description, no PATCH/DELETE.
 * §71 of the blog spec: "do not create unnecessary complexity if tags can be
 * managed entirely from the blog editor." The only write is find-or-create,
 * called from the editor's tag combobox; an unused tag is harmless leftover
 * reference data, same as an unused Skill.
 */
export const blogTagsRouter = Router()

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

blogTagsRouter.get('/', async (req, res) => {
  const tags = await prisma.blogTag.findMany({
    select: {
      id: true,
      name: true,
      slug: true,
      _count: { select: { posts: { where: { post: effectivelyPublishedWhere() } } } },
    },
    orderBy: { name: 'asc' },
  })
  res.json({ data: tags.map(({ _count, ...t }) => ({ ...t, postCount: _count.posts })) })
})

blogTagsRouter.get(
  '/:slug',
  validate({ params: z.object({ slug: z.string() }) }),
  async (req, res) => {
    const tag = await prisma.blogTag.findUnique({
      where: { slug: param(req, 'slug') },
      select: { id: true, name: true, slug: true },
    })
    if (!tag) throw new NotFoundError('Tag')
    res.json({ data: tag })
  },
)

// ─── Admin ─────────────────────────────────────────────────────────────────

const findOrCreateSchema = z.object({ name: z.string().trim().min(1).max(60) })

blogTagsRouter.post(
  '/find-or-create',
  authenticate,
  requirePermission(PERMISSIONS.BLOG_MANAGE_TAGS),
  validate({ body: findOrCreateSchema }),
  async (req, res) => {
    const name: string = req.body.name

    const existing = await prisma.blogTag.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    })
    if (existing) {
      res.json({ data: existing })
      return
    }

    const stem = slugify(name, 40)
    let slug = stem
    let i = 2
    while (true) {
      const taken = await prisma.blogTag.findUnique({ where: { slug }, select: { id: true } })
      if (!taken) break
      slug = `${stem}-${i++}`
    }

    const tag = await prisma.blogTag.create({ data: { name, slug } })
    res.status(201).json({ data: tag })
  },
)
