import type { MetadataRoute } from 'next'
import { env } from '@/lib/env'
import { indexableRoutes } from '@/lib/seo/routes'
import { publishedCaseStudies } from '@/content'
import { publicFetchPage } from '@/lib/api/public'
import type { BlogCategorySummary, BlogPostSummary } from '@/lib/blog/types'

/**
 * Generated from the route registry, so a new page appears here automatically
 * and a `noindex` one cannot leak in.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE TRAILING SLASH MATTERS. `new URL('/', origin)` yields `https://host/`,
 * but Next normalises `alternates.canonical` to `https://host` because
 * `trailingSlash` is false. That left the homepage advertising one URL in its
 * canonical and a different one in the sitemap.
 *
 * Google treats the two root forms as equivalent, so nothing was broken — but a
 * sitemap that disagrees with the canonical it points at is the first thing an
 * SEO audit flags, and the fix is one line. `canonicalUrl` below matches Next's
 * normalisation exactly, so the two can never drift.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * COLLECTIONS. Case studies are not in the route registry — that holds the
 * fixed IA — so they are appended from their content module. Blog posts and
 * categories work the same way but are DB-backed (see `api/src/modules/blog/`):
 * fetched from the public API, paginating through every page since the public
 * list endpoint caps a single request at 48 rows. Only effectively-published
 * posts and active categories — the public API already enforces that, so
 * nothing here has to re-check it. Tag pages are deliberately absent: they're
 * `noindex` (see the `generateMetadata` in `company/blog/tag/[slug]/page.tsx`
 * for why), and a noindex page has no business in a sitemap.
 */
function canonicalUrl(path: string): string {
  const url = new URL(path, env.NEXT_PUBLIC_SITE_URL).toString()
  // Strip the trailing slash except on the origin-only case, where there is
  // nothing left to strip.
  return url.endsWith('/') ? url.slice(0, -1) : url
}

/** Every published post, paginating through the public list's 48-row cap. */
async function allPublishedPosts(): Promise<BlogPostSummary[]> {
  const posts: BlogPostSummary[] = []
  let page = 1
  while (true) {
    const { data, meta } = await publicFetchPage<BlogPostSummary>('blog/posts', {
      query: { page, limit: 48 },
      next: { tags: ['blog-posts'] },
    })
    posts.push(...data)
    if (!meta?.hasNext) break
    page += 1
  }
  return posts
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // One timestamp for the fixed pages and categories. A per-page date would
  // be fiction — nothing tracks when a section's copy last changed. Blog
  // posts DO have a real date and use it below, which is the only place
  // `lastmod` means anything.
  const lastModified = new Date()

  const pages: MetadataRoute.Sitemap = indexableRoutes().map((route) => ({
    url: canonicalUrl(route.path),
    lastModified,
    changeFrequency: route.changeFrequency ?? 'monthly',
    priority: route.priority ?? 0.6,
  }))

  const [blogPosts, categories] = await Promise.all([
    allPublishedPosts(),
    publicFetchPage<BlogCategorySummary>('blog/categories', {
      next: { tags: ['blog-categories'] },
    }).then((r) => r.data),
  ])

  const posts: MetadataRoute.Sitemap = blogPosts.map((post) => ({
    url: canonicalUrl(`/company/blog/${post.slug}`),
    lastModified: post.publishedAt ? new Date(post.publishedAt) : lastModified,
    changeFrequency: 'yearly',
    priority: 0.6,
  }))

  const categoryPages: MetadataRoute.Sitemap = categories.map((category) => ({
    url: canonicalUrl(`/company/blog/category/${category.slug}`),
    lastModified,
    changeFrequency: 'weekly',
    priority: 0.4,
  }))

  const studies: MetadataRoute.Sitemap = publishedCaseStudies().map((study) => ({
    url: canonicalUrl(`/company/case-studies/${study.slug}`),
    lastModified,
    changeFrequency: 'yearly',
    priority: 0.7,
  }))

  return [...pages, ...posts, ...categoryPages, ...studies]
}
