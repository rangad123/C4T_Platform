import { publicFetchPage } from '@/lib/api/public'
import type { BlogPostSummary } from '@/lib/blog/types'

export const dynamic = 'force-dynamic'

/**
 * Same-origin JSON proxy for the debounced search box — the browser never
 * calls the Express API directly, matching how every other browser-facing
 * data need on this site (uploads included) goes through a Route Handler
 * rather than a direct cross-origin fetch.
 *
 * The public list endpoint's own `search` param IS the search feature; this
 * route is a thin pass-through, not a separate implementation.
 *
 * `disallow`ed in `robots.ts` — it's a JSON endpoint, not a content page.
 */
export async function GET(request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams.get('q')?.trim().slice(0, 120) ?? ''
  if (!q) return Response.json({ results: [] })

  const { data } = await publicFetchPage<BlogPostSummary>('blog/posts', {
    query: { search: q, limit: 8 },
    next: { revalidate: 60 },
  })

  return Response.json({
    results: data.map((post) => ({ slug: post.slug, title: post.title, excerpt: post.excerpt })),
  })
}
