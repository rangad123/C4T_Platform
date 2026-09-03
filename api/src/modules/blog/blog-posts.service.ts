import { type Prisma, BlogPostStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { NotFoundError, BadRequestError } from '../../lib/errors.js'
import { buildMeta, buildOrderBy, toSkipTake } from '../../lib/pagination.js'
import { slugify } from '../../lib/slug.js'
import { createPublicUrl } from '../../lib/storage.js'
import { sanitizeContent, computeReadingTimeMinutes } from './blog-content.js'
import {
  BLOG_POST_SORT_FIELDS,
  type AdminListPostsQuery,
  type PublicListPostsQuery,
  type CreatePostInput,
  type UpdatePostInput,
} from './blog-posts.schema.js'

/**
 * Slugs a post can never take: `search` genuinely collides with the Next.js
 * route `company/blog/search/route.ts` (a literal path segment beats the
 * dynamic `[slug]` for an exact match, so a post slugged "search" would make
 * the search endpoint unreachable). `category`/`tag`/`admin` are reserved for
 * hygiene — they're the other first-segment paths under `/company/blog/`.
 */
const RESERVED_SLUGS = new Set(['search', 'category', 'tag', 'admin'])

const postAdminSelect = {
  id: true,
  slug: true,
  title: true,
  excerpt: true,
  content: true,
  status: true,
  categoryId: true,
  authorId: true,
  authorDisplayName: true,
  featuredImageFileId: true,
  secondaryImageFileId: true,
  layout: true,
  isFeatured: true,
  readingTimeMinutes: true,
  viewCount: true,
  seoTitle: true,
  seoDescription: true,
  previousSlugs: true,
  scheduledAt: true,
  publishedAt: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  category: { select: { id: true, name: true, slug: true } },
  author: { select: { id: true, firstName: true, lastName: true } },
  featuredImage: { select: { id: true, storageKey: true, originalName: true } },
  secondaryImage: { select: { id: true, storageKey: true, originalName: true } },
  galleryImages: {
    select: {
      id: true,
      fileId: true,
      caption: true,
      position: true,
      file: { select: { id: true, storageKey: true, originalName: true } },
    },
    // A nested to-many has NO default order in Prisma. Without this the
    // gallery looks right in development and scrambles in production.
    orderBy: { position: 'asc' },
  },
  tags: { select: { tag: { select: { id: true, name: true, slug: true } } } },
} satisfies Prisma.BlogPostSelect

type AdminPostRow = Prisma.BlogPostGetPayload<{ select: typeof postAdminSelect }>

function shapeAdminPost(post: AdminPostRow) {
  const { tags, featuredImage, secondaryImage, galleryImages, ...rest } = post
  return {
    ...rest,
    tags: tags.map((t) => t.tag),
    featuredImageUrl: featuredImage ? createPublicUrl(featuredImage.storageKey) : null,
    secondaryImageUrl: secondaryImage ? createPublicUrl(secondaryImage.storageKey) : null,
    galleryImages: galleryImages.map(({ file, ...image }) => ({
      ...image,
      url: createPublicUrl(file.storageKey),
      originalName: file.originalName,
    })),
  }
}

/** What a public, unauthenticated caller ever receives — no `content` on a list row. */
const postPublicListSelect = {
  id: true,
  slug: true,
  title: true,
  excerpt: true,
  isFeatured: true,
  readingTimeMinutes: true,
  publishedAt: true,
  authorDisplayName: true,
  category: { select: { name: true, slug: true } },
  author: { select: { firstName: true, lastName: true } },
  featuredImage: { select: { storageKey: true } },
} satisfies Prisma.BlogPostSelect

type PublicPostListRow = Prisma.BlogPostGetPayload<{ select: typeof postPublicListSelect }>

function shapePublicListRow(post: PublicPostListRow) {
  const { authorDisplayName, author, featuredImage, ...rest } = post
  return {
    ...rest,
    author:
      authorDisplayName ?? ([author.firstName, author.lastName].filter(Boolean).join(' ') || null),
    featuredImageUrl: featuredImage ? createPublicUrl(featuredImage.storageKey) : null,
  }
}

const postPublicDetailSelect = {
  ...postPublicListSelect,
  // Harmless to expose publicly — a visitor of a genuinely public post only
  // ever sees `PUBLISHED` here. What it's actually for is the ADMIN preview
  // path below, which reuses this exact select/shape (unlike every other
  // public field) so the editor's "Preview" button renders through the same
  // code the real page uses, not a second hand-maintained shape.
  status: true,
  content: true,
  seoTitle: true,
  seoDescription: true,
  previousSlugs: true,
  layout: true,
  secondaryImage: { select: { storageKey: true } },
  galleryImages: {
    select: { caption: true, position: true, file: { select: { storageKey: true } } },
    orderBy: { position: 'asc' },
  },
  tags: { select: { tag: { select: { name: true, slug: true } } } },
} satisfies Prisma.BlogPostSelect

type PublicPostDetailRow = Prisma.BlogPostGetPayload<{ select: typeof postPublicDetailSelect }>

function shapePublicDetail(post: PublicPostDetailRow) {
  const { authorDisplayName, author, featuredImage, secondaryImage, galleryImages, tags, ...rest } =
    post
  return {
    ...rest,
    author:
      authorDisplayName ?? ([author.firstName, author.lastName].filter(Boolean).join(' ') || null),
    featuredImageUrl: featuredImage ? createPublicUrl(featuredImage.storageKey) : null,
    secondaryImageUrl: secondaryImage ? createPublicUrl(secondaryImage.storageKey) : null,
    galleryImages: galleryImages.map(({ file, ...image }) => ({
      ...image,
      url: createPublicUrl(file.storageKey),
    })),
    tags: tags.map((t) => t.tag),
  }
}

/** Generates a URL-safe, unique slug for a post — mirrors `organisations.service.ts`'s own `uniqueSlug`. */
async function uniqueSlug(
  base: string,
  tx: Prisma.TransactionClient,
  excludeId?: string,
): Promise<string> {
  const stem = slugify(base)
  let slug = stem
  let i = 2
  while (true) {
    const taken =
      RESERVED_SLUGS.has(slug) ||
      Boolean(
        await tx.blogPost.findFirst({
          where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
          select: { id: true },
        }),
      )
    if (!taken) return slug
    slug = `${stem}-${i++}`
  }
}

/**
 * A post is publicly visible once it's `PUBLISHED`, or `SCHEDULED` with a due
 * time — the latter branch is belt-and-braces for the brief window between
 * "the time has passed" and the next call to `settleDuePosts()`, which is
 * what actually flips the stored status; in steady state every visible row
 * is simply `PUBLISHED`.
 */
function publicVisibleWhere(): Prisma.BlogPostWhereInput {
  return {
    deletedAt: null,
    OR: [
      { status: BlogPostStatus.PUBLISHED },
      { status: BlogPostStatus.SCHEDULED, scheduledAt: { lte: new Date() } },
    ],
  }
}

/**
 * No cron exists anywhere in this codebase (confirmed — nothing like
 * node-cron/bullmq/agenda is installed). Scheduled publishing is settled
 * lazily instead, the same "stamp on next touch" idiom already used for
 * `Organisation.onboardedAt`: called at the top of every PUBLIC read path,
 * this flips any `SCHEDULED` post whose time has come to `PUBLISHED`.
 */
async function settleDuePosts(): Promise<void> {
  const due = await prisma.blogPost.findMany({
    where: { status: BlogPostStatus.SCHEDULED, scheduledAt: { lte: new Date() }, deletedAt: null },
    select: { id: true, scheduledAt: true },
  })
  if (due.length === 0) return
  await prisma.$transaction(
    due.map((p) =>
      prisma.blogPost.update({
        where: { id: p.id },
        data: { status: BlogPostStatus.PUBLISHED, publishedAt: p.scheduledAt, scheduledAt: null },
      }),
    ),
  )
}

/** §23 — a post needs a category and a featured image before it may go live. */
function assertPublishReady(post: {
  categoryId: string | null
  featuredImageFileId: string | null
}): void {
  if (!post.categoryId || !post.featuredImageFileId) {
    throw new BadRequestError(
      'A post needs a category and a featured image before it can be published.',
    )
  }
}

// ─── Admin ─────────────────────────────────────────────────────────────────

export async function listPostsAdmin(query: AdminListPostsQuery) {
  const where: Prisma.BlogPostWhereInput = {
    deletedAt: null,
    ...(query.status ? { status: query.status } : {}),
    ...(query.category ? { category: { slug: query.category } } : {}),
    ...(query.search
      ? {
          OR: [
            { title: { contains: query.search, mode: 'insensitive' } },
            { excerpt: { contains: query.search, mode: 'insensitive' } },
            { slug: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    prisma.blogPost.findMany({
      where,
      select: postAdminSelect,
      orderBy: buildOrderBy(query.sort, query.order, BLOG_POST_SORT_FIELDS, 'createdAt'),
      ...toSkipTake(query),
    }),
    prisma.blogPost.count({ where }),
  ])

  return { items: items.map(shapeAdminPost), meta: buildMeta(query, total) }
}

export async function getPostAdmin(id: string) {
  const post = await prisma.blogPost.findFirst({
    where: { id, deletedAt: null },
    select: postAdminSelect,
  })
  if (!post) throw new NotFoundError('Blog post')
  return shapeAdminPost(post)
}

/**
 * Any status, by slug — the admin editor's Preview button. No view-count
 * bump. Shaped via `shapePublicDetail`, the exact same function and select
 * the real public route uses (just without `publicVisibleWhere()` gating
 * which rows are visible) — so a preview renders through the identical
 * frontend code path as the live page, rather than a second, easily-drifted
 * admin-shaped variant.
 */
export async function getPostPreview(slug: string) {
  const post = await prisma.blogPost.findFirst({
    where: { slug, deletedAt: null },
    select: postPublicDetailSelect,
  })
  if (!post) throw new NotFoundError('Blog post')
  return shapePublicDetail(post)
}

export async function createPost(authorId: string, input: CreatePostInput) {
  return prisma.$transaction(async (tx) => {
    const slug = await uniqueSlug(input.title, tx)
    const post = await tx.blogPost.create({
      data: { title: input.title, slug, content: '', authorId, status: BlogPostStatus.DRAFT },
      select: postAdminSelect,
    })
    return shapeAdminPost(post)
  })
}

export async function updatePost(id: string, input: UpdatePostInput) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.blogPost.findFirst({ where: { id, deletedAt: null } })
    if (!existing) throw new NotFoundError('Blog post')

    const slug =
      input.slug !== undefined && input.slug !== existing.slug
        ? await uniqueSlug(input.slug, tx, id)
        : undefined
    const previousSlugs = slug
      ? Array.from(new Set([...existing.previousSlugs, existing.slug]))
      : undefined

    // §28 — at most one featured post. Unset any previous holder before
    // setting this one, in the same transaction as the rest of the update.
    if (input.isFeatured === true) {
      await tx.blogPost.updateMany({
        where: { isFeatured: true, id: { not: id } },
        data: { isFeatured: false },
      })
    }

    const content = input.content !== undefined ? sanitizeContent(input.content) : undefined

    const post = await tx.blogPost.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(slug ? { slug, previousSlugs } : {}),
        ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
        ...(content !== undefined
          ? { content, readingTimeMinutes: computeReadingTimeMinutes(content) }
          : {}),
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.featuredImageFileId !== undefined
          ? { featuredImageFileId: input.featuredImageFileId }
          : {}),
        ...(input.secondaryImageFileId !== undefined
          ? { secondaryImageFileId: input.secondaryImageFileId }
          : {}),
        ...(input.layout !== undefined ? { layout: input.layout } : {}),
        ...(input.isFeatured !== undefined ? { isFeatured: input.isFeatured } : {}),
        ...(input.authorDisplayName !== undefined
          ? { authorDisplayName: input.authorDisplayName }
          : {}),
        ...(input.seoTitle !== undefined ? { seoTitle: input.seoTitle } : {}),
        ...(input.seoDescription !== undefined ? { seoDescription: input.seoDescription } : {}),
        ...(input.tagIds
          ? { tags: { deleteMany: {}, create: input.tagIds.map((tagId) => ({ tagId })) } }
          : {}),
        /**
         * Replace the gallery wholesale, exactly as tags are replaced above.
         *
         * `@@unique([postId, position])` makes an in-place reorder a
         * constraint violation — swapping two images by updating each row's
         * position collides on the intermediate state. Delete-all-then-create
         * in order is the only shape that cannot, and it runs inside the same
         * interactive transaction as the rest of the update, so no partial
         * gallery is ever visible to a concurrent public read.
         *
         * `position` comes from the array index, never from the client.
         */
        ...(input.galleryImages
          ? {
              galleryImages: {
                deleteMany: {},
                create: input.galleryImages.map((image, index) => ({
                  fileId: image.fileId,
                  caption: image.caption ?? null,
                  position: index,
                })),
              },
            }
          : {}),
      },
      select: postAdminSelect,
    })
    return shapeAdminPost(post)
  })
}

/**
 * One function per legal status transition — mirrors `archiveOrganisation`'s
 * find → guard → update shape. See the plan's transition table for the full
 * set of legal moves and what each requires.
 */
export async function publishPost(id: string) {
  const existing = await prisma.blogPost.findFirst({ where: { id, deletedAt: null } })
  if (!existing) throw new NotFoundError('Blog post')
  assertPublishReady(existing)
  const post = await prisma.blogPost.update({
    where: { id },
    data: {
      status: BlogPostStatus.PUBLISHED,
      // Preserve the original publish date across an archive → republish
      // cycle rather than overwriting it, so a post's history stays truthful.
      publishedAt: existing.publishedAt ?? new Date(),
      scheduledAt: null,
    },
    select: postAdminSelect,
  })
  return shapeAdminPost(post)
}

export async function schedulePost(id: string, scheduledAt: Date) {
  if (scheduledAt.getTime() <= Date.now()) {
    throw new BadRequestError('The schedule time must be in the future.')
  }
  const existing = await prisma.blogPost.findFirst({ where: { id, deletedAt: null } })
  if (!existing) throw new NotFoundError('Blog post')
  assertPublishReady(existing)
  const post = await prisma.blogPost.update({
    where: { id },
    data: { status: BlogPostStatus.SCHEDULED, scheduledAt },
    select: postAdminSelect,
  })
  return shapeAdminPost(post)
}

export async function archivePost(id: string) {
  const existing = await prisma.blogPost.findFirst({ where: { id, deletedAt: null } })
  if (!existing) throw new NotFoundError('Blog post')
  const post = await prisma.blogPost.update({
    where: { id },
    data: { status: BlogPostStatus.ARCHIVED, archivedAt: new Date() },
    select: postAdminSelect,
  })
  return shapeAdminPost(post)
}

export async function revertToDraft(id: string) {
  const existing = await prisma.blogPost.findFirst({ where: { id, deletedAt: null } })
  if (!existing) throw new NotFoundError('Blog post')
  const post = await prisma.blogPost.update({
    where: { id },
    data: { status: BlogPostStatus.DRAFT, scheduledAt: null, archivedAt: null },
    select: postAdminSelect,
  })
  return shapeAdminPost(post)
}

/** Soft delete — matches Bug/Project/Organisation, never a hard `.delete()`. */
export async function deletePost(id: string): Promise<void> {
  const existing = await prisma.blogPost.findFirst({ where: { id, deletedAt: null } })
  if (!existing) throw new NotFoundError('Blog post')
  await prisma.blogPost.update({ where: { id }, data: { deletedAt: new Date() } })
}

// ─── Public ────────────────────────────────────────────────────────────────

export async function listPostsPublic(query: PublicListPostsQuery) {
  void settleDuePosts()

  const where: Prisma.BlogPostWhereInput = {
    ...publicVisibleWhere(),
    ...(query.category ? { category: { slug: query.category } } : {}),
    ...(query.tag ? { tags: { some: { tag: { slug: query.tag } } } } : {}),
    ...(query.excludeId ? { id: { not: query.excludeId } } : {}),
    ...(query.search
      ? {
          OR: [
            { title: { contains: query.search, mode: 'insensitive' } },
            { excerpt: { contains: query.search, mode: 'insensitive' } },
            { content: { contains: query.search, mode: 'insensitive' } },
            { category: { name: { contains: query.search, mode: 'insensitive' } } },
            { tags: { some: { tag: { name: { contains: query.search, mode: 'insensitive' } } } } },
          ],
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    prisma.blogPost.findMany({
      where,
      select: postPublicListSelect,
      orderBy: [{ isFeatured: 'desc' }, { publishedAt: 'desc' }],
      ...toSkipTake(query),
    }),
    prisma.blogPost.count({ where }),
  ])

  return { items: items.map(shapePublicListRow), meta: buildMeta(query, total) }
}

/**
 * By current slug, or — on a miss — by a slug the post used to have, in
 * which case the caller (the Next.js route) is expected to 308-redirect to
 * the post's current slug rather than render it at the old URL.
 */
export async function getPostPublic(
  slug: string,
): Promise<{ post: ReturnType<typeof shapePublicDetail>; redirectTo?: string }> {
  void settleDuePosts()

  const direct = await prisma.blogPost.findFirst({
    where: { slug, ...publicVisibleWhere() },
    select: postPublicDetailSelect,
  })
  if (direct) {
    // Fire-and-forget — a simple counter, no unique-visitor dedup, matching
    // the lack of any view-dedup infrastructure elsewhere in this codebase.
    // A failure here must never fail the read itself, but is still worth
    // knowing about.
    void prisma.blogPost
      .update({ where: { id: direct.id }, data: { viewCount: { increment: 1 } } })
      .catch((error: unknown) => {
        logger.error({ err: error, postId: direct.id }, 'Failed to increment blog post view count')
      })
    return { post: shapePublicDetail(direct) }
  }

  const viaOldSlug = await prisma.blogPost.findFirst({
    where: { previousSlugs: { has: slug }, ...publicVisibleWhere() },
    select: postPublicDetailSelect,
  })
  if (!viaOldSlug) throw new NotFoundError('Blog post')
  return { post: shapePublicDetail(viaOldSlug), redirectTo: viaOldSlug.slug }
}
