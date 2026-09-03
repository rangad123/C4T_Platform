import { z } from 'zod'
import { BlogPostLayout, BlogPostStatus } from '@prisma/client'
import { paginationQuery } from '../../lib/pagination.js'

export const BLOG_POST_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'publishedAt',
  'title',
  'viewCount',
] as const

export const adminListPostsQuery = paginationQuery.extend({
  status: z.nativeEnum(BlogPostStatus).optional(),
  /** Category slug. */
  category: z.string().trim().max(100).optional(),
  search: z.string().trim().max(120).optional(),
  sort: z.enum(BLOG_POST_SORT_FIELDS).optional(),
})
export type AdminListPostsQuery = z.infer<typeof adminListPostsQuery>

export const publicListPostsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(12),
  category: z.string().trim().max(100).optional(),
  tag: z.string().trim().max(100).optional(),
  search: z.string().trim().max(120).optional(),
  /** Excludes one post id from the results — used for "related articles". */
  excludeId: z.string().cuid().optional(),
  /**
   * Looks a post up by a slug it USED to have rather than its current one —
   * the detail page's fallback path after a slug change. Mutually exclusive
   * with the filters above in practice, but not worth a discriminated union
   * for one optional field.
   */
  previousSlug: z.string().trim().max(200).optional(),
})
export type PublicListPostsQuery = z.infer<typeof publicListPostsQuery>

export const createPostSchema = z.object({
  title: z.string().trim().min(3).max(200),
})
export type CreatePostInput = z.infer<typeof createPostSchema>

export const updatePostSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  slug: z
    .string()
    .trim()
    .min(3)
    .max(200)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens only')
    .optional(),
  excerpt: z.string().trim().max(300).optional(),
  content: z.string().max(200_000).optional(),
  categoryId: z.string().cuid().nullable().optional(),
  featuredImageFileId: z.string().cuid().nullable().optional(),
  /** Nullable so it can be cleared, like featuredImageFileId and unlike excerpt. */
  secondaryImageFileId: z.string().cuid().nullable().optional(),
  layout: z.nativeEnum(BlogPostLayout).optional(),
  /**
   * The gallery, in the order it should render.
   *
   * `position` is derived from the array index server-side rather than
   * accepted from the client: `BlogPostImage` has `@@unique([postId,
   * position])`, so a client sending absolute positions can collide mid-write,
   * and only the server can guarantee the gapless 0-based order the column
   * promises. Capped for the same reason `tagIds` is — the whole gallery is
   * replaced inside one interactive transaction, and an unbounded array is the
   * one input that could push it past the timeout.
   */
  galleryImages: z
    .array(
      z.object({
        fileId: z.string().cuid(),
        caption: z.string().trim().max(300).nullable().optional(),
      }),
    )
    .max(24)
    .optional(),
  tagIds: z.array(z.string().cuid()).max(20).optional(),
  isFeatured: z.boolean().optional(),
  authorDisplayName: z.string().trim().max(120).nullable().optional(),
  seoTitle: z.string().trim().max(70).optional(),
  seoDescription: z.string().trim().max(160).optional(),
})
export type UpdatePostInput = z.infer<typeof updatePostSchema>

export const scheduleSchema = z.object({ scheduledAt: z.coerce.date() })

export const postIdParam = z.object({ id: z.string().cuid() })
export const postSlugParam = z.object({ slug: z.string().trim().min(1).max(200) })
