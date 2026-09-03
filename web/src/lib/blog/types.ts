/**
 * Shapes returned by the PUBLIC blog API (`/v1/blog/posts`, `/v1/blog/categories`,
 * `/v1/blog/tags`) — mirrors `shapePublicListRow`/`shapePublicDetail` in
 * `api/src/modules/blog/blog-posts.service.ts`. Kept as hand-written unions
 * rather than imported from the API, same convention as `lib/api/types.ts`.
 */

export interface BlogPostSummary {
  id: string
  slug: string
  title: string
  excerpt: string | null
  isFeatured: boolean
  readingTimeMinutes: number
  publishedAt: string | null
  category: { name: string; slug: string } | null
  author: string | null
  featuredImageUrl: string | null
}

export type BlogPostLayout = 'STANDARD' | 'HERO' | 'SPLIT' | 'GALLERY'

export interface BlogGalleryImage {
  url: string
  caption: string | null
  position: number
}

export interface BlogPostDetail extends BlogPostSummary {
  /**
   * Present on every response, but only meaningfully checked on a preview
   * render — the public read path only ever returns an effectively-
   * published post, so this is always `'PUBLISHED'` there in practice.
   */
  status: 'DRAFT' | 'SCHEDULED' | 'PUBLISHED' | 'ARCHIVED'
  content: string
  seoTitle: string | null
  seoDescription: string | null
  previousSlugs: string[]
  tags: { name: string; slug: string }[]
  /** How the page arranges the post. See `BlogPostLayout` on the API. */
  layout: BlogPostLayout
  /** Used by SPLIT, and as the social card when the featured image is the wrong crop. */
  secondaryImageUrl: string | null
  galleryImages: BlogGalleryImage[]
}

export interface BlogCategorySummary {
  id: string
  name: string
  slug: string
  description: string | null
  postCount: number
}

export interface BlogTagSummary {
  id: string
  name: string
  slug: string
  postCount: number
}
