import 'server-only'
import { publicFetchOrNull } from '@/lib/api/public'
import type { BlogPostSummary } from './types'

/**
 * The blog's two public sections. A post is a case study when it is filed
 * under the Case Study category or tagged "case study"; every other post is an
 * article. The API draws that line (see `collectionWhere` in the blog service)
 * so the two lists are complementary by construction.
 */
export type BlogCollection = 'case-studies' | 'articles'

/**
 * The category the migrated case studies are filed under. The API decides what
 * counts as a case study (this category, or a case-study tag); this is only so
 * the blog's category pills can leave the category out, since its posts are not
 * listed there.
 */
export const CASE_STUDY_CATEGORY_SLUG = 'case-study'

/**
 * The latest published posts of one collection, newest first.
 *
 * Read on the server and cached: the five-minute window is the ceiling on how
 * long a new post takes to appear, and the `blog-posts` tag is what an admin's
 * publish or save invalidates, so in practice it appears straight away.
 *
 * Returns an empty list rather than throwing when the API cannot be reached.
 * A build with no API running (CI) and a moment when it is restarting should
 * both leave a page without this strip, not without the page.
 */
export async function loadBlogCollection(
  collection: BlogCollection,
  limit: number,
): Promise<BlogPostSummary[]> {
  const posts = await publicFetchOrNull<BlogPostSummary[]>('blog/posts', {
    query: { collection, limit },
    next: { tags: ['blog-posts'], revalidate: 300 },
  })
  return posts ?? []
}

/**
 * The two homepage strips, guaranteed not to show the same post twice.
 *
 * The API already splits the blog into disjoint collections, so the filter
 * below is a second lock rather than the first: it holds even if the two reads
 * straddle a save that moves a post from one collection to the other.
 */
export async function loadHomeBlogStrips(limits: { caseStudies: number; articles: number }) {
  const [caseStudies, articles] = await Promise.all([
    loadBlogCollection('case-studies', limits.caseStudies),
    loadBlogCollection('articles', limits.articles),
  ])
  const shown = new Set(caseStudies.map((post) => post.id))
  return { caseStudies, articles: articles.filter((post) => !shown.has(post.id)) }
}
