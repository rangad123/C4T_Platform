import type { Metadata } from 'next'
import { CtaBanner, ResourceCard, Section, Tag } from '@/components/ds'
import { DeepBand } from '@/components/sections/blocks'
import s from '@/components/sections/sections.module.css'
import { JsonLd } from '@/components/seo/JsonLd'
import { BlogSearchBox } from '@/components/ds/marketing/BlogSearchBox'
import { buildMetadata } from '@/lib/seo/metadata'
import { breadcrumbFor } from '@/lib/seo/structured-data'
import { publicFetchOrNull, publicFetchPage } from '@/lib/api/public'
import type { BlogCategorySummary, BlogPostSummary } from '@/lib/blog/types'
import { BLOG_INDEX, CLOSING_CTA } from '@/content'

const PATH = '/company/blog'
const PAGE_SIZE = 12

export const metadata: Metadata = buildMetadata(PATH)

function pageHref(params: { category?: string; search?: string; page?: number }): string {
  const sp = new URLSearchParams()
  if (params.category) sp.set('category', params.category)
  if (params.search) sp.set('search', params.search)
  if (params.page && params.page > 1) sp.set('page', String(params.page))
  const qs = sp.toString()
  return qs ? `${PATH}?${qs}` : PATH
}

/**
 * The blog index — rewritten to read from the database instead of
 * `content/blog.ts` (see the plan: the static typed-module blog is retired
 * entirely, replaced by this admin-editable one, at the same URL).
 *
 * The hero band and closing CTA are untouched from the original static
 * page — only the content between them is now dynamic.
 */
export default async function BlogIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; search?: string; page?: string }>
}) {
  const params = await searchParams
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1)
  const hasFilters = Boolean(params.category ?? params.search)

  const [{ data: posts, meta }, categories] = await Promise.all([
    publicFetchPage<BlogPostSummary>('blog/posts', {
      query: { category: params.category, search: params.search, page, limit: PAGE_SIZE },
      next: { tags: ['blog-posts'] },
    }),
    publicFetchOrNull<BlogCategorySummary[]>('blog/categories', {
      next: { tags: ['blog-categories'] },
    }),
  ])

  // The public list is ordered featured-first — on an unfiltered first page,
  // a featured post (if any) is the opening item. Pulled out for its own
  // horizontal treatment and dropped from the grid below so it isn't shown
  // twice.
  const featured = page === 1 && !hasFilters && posts[0]?.isFeatured ? posts[0] : undefined
  const gridPosts = featured ? posts.slice(1) : posts

  return (
    <>
      <JsonLd schema={breadcrumbFor(PATH, 'Blog')} />

      <Section tone="inverse" className={s.deep} compact>
        <div className="c4t-eyebrow" style={{ color: 'var(--text-inverse-muted)' }}>
          {BLOG_INDEX.eyebrow}
        </div>
        <h1
          className="c4t-display-xl"
          style={{
            margin: '20px 0 0',
            color: 'var(--text-inverse)',
            maxWidth: 900,
            textWrap: 'pretty',
          }}
        >
          {BLOG_INDEX.title}
        </h1>
        <p
          className="c4t-body-lg"
          style={{ margin: '24px 0 0', color: 'var(--text-inverse-muted)', maxWidth: 620 }}
        >
          {BLOG_INDEX.description}
        </p>
      </Section>

      <Section>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-5)',
            marginBottom: 'var(--space-8)',
          }}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            <Tag active={!params.category} href={pageHref({ search: params.search })}>
              All
            </Tag>
            {(categories ?? []).map((category) => (
              <Tag
                key={category.slug}
                active={params.category === category.slug}
                href={pageHref({ category: category.slug, search: params.search })}
              >
                {category.name}
              </Tag>
            ))}
          </div>
          <BlogSearchBox defaultValue={params.search} />
        </div>

        {posts.length === 0 ? (
          <p className="c4t-body-lg" style={{ margin: 0, color: 'var(--text-secondary)' }}>
            {hasFilters
              ? 'No posts match your search. Try a different term or clear the filter.'
              : BLOG_INDEX.emptyState}
          </p>
        ) : (
          <>
            {featured ? (
              <div style={{ marginBottom: 'var(--space-8)' }}>
                <ResourceCard
                  layout="horizontal"
                  type="Article"
                  category={featured.category?.name}
                  title={featured.title}
                  description={featured.excerpt ?? undefined}
                  date={featured.publishedAt ? formatDate(featured.publishedAt) : undefined}
                  readTime={`${featured.readingTimeMinutes} min read`}
                  author={featured.author ?? undefined}
                  href={`${PATH}/${featured.slug}`}
                  image={
                    featured.featuredImageUrl
                      ? { src: featured.featuredImageUrl, alt: featured.title }
                      : undefined
                  }
                />
              </div>
            ) : null}

            {gridPosts.length > 0 ? (
              <div
                className="c4t-grid-4"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, 1fr)',
                  gap: 'var(--space-grid-gap)',
                }}
              >
                {gridPosts.map((post) => (
                  <ResourceCard
                    key={post.slug}
                    type="Article"
                    category={post.category?.name}
                    title={post.title}
                    description={post.excerpt ?? undefined}
                    date={post.publishedAt ? formatDate(post.publishedAt) : undefined}
                    readTime={`${post.readingTimeMinutes} min read`}
                    author={post.author ?? undefined}
                    href={`${PATH}/${post.slug}`}
                    image={
                      post.featuredImageUrl
                        ? { src: post.featuredImageUrl, alt: post.title }
                        : undefined
                    }
                  />
                ))}
              </div>
            ) : null}

            {meta && meta.totalPages > 1 ? (
              <nav
                aria-label="Pagination"
                style={{
                  display: 'flex',
                  justifyContent: 'center',
                  gap: 'var(--space-3)',
                  marginTop: 'var(--space-9)',
                }}
              >
                {Array.from({ length: meta.totalPages }, (_, i) => i + 1).map((n) => (
                  <a
                    key={n}
                    href={pageHref({ category: params.category, search: params.search, page: n })}
                    className="c4t-page-btn"
                    aria-current={n === page ? 'page' : undefined}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      minWidth: 40,
                      height: 40,
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-default)',
                      background: n === page ? 'var(--surface-inverse)' : 'var(--surface-canvas)',
                      color: n === page ? 'var(--text-inverse)' : 'var(--text-primary)',
                      textDecoration: 'none',
                      fontSize: 'var(--type-body-sm-size)',
                    }}
                  >
                    {n}
                  </a>
                ))}
              </nav>
            ) : null}
          </>
        )}
      </Section>

      <DeepBand>
        <CtaBanner tone="inverse" style={{ background: 'transparent' }} {...CLOSING_CTA} />
      </DeepBand>
    </>
  )
}

/** `en-GB` explicitly — see the note on the same helper in the old static page. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}
