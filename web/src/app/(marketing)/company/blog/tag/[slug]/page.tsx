import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { CtaBanner, ResourceCard, Section } from '@/components/ds'
import { DeepBand } from '@/components/sections/blocks'
import s from '@/components/sections/sections.module.css'
import { JsonLd } from '@/components/seo/JsonLd'
import { env } from '@/lib/env'
import { publicFetch, publicFetchPage } from '@/lib/api/public'
import { breadcrumbJsonLd } from '@/lib/seo/structured-data'
import { SITE_NAME } from '@/lib/seo/metadata'
import { CLOSING_CTA } from '@/content'
import type { BlogPostSummary, BlogTagSummary } from '@/lib/blog/types'

const PREFIX = '/company/blog'
const PAGE_SIZE = 12

/**
 * `/company/blog/tag/[slug]` — same listing shell as the category page.
 *
 * Deliberately `noindex`: §69 of the blog spec warns against indexing every
 * low-value tag page without a clear SEO strategy, unlike categories (a
 * small, curated taxonomy an admin manages) tags are open-ended and can
 * proliferate — indexing them all would spread crawl budget and duplicate-
 * content risk across pages with little unique value each.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const tag = await publicFetch<BlogTagSummary>(`blog/tags/${slug}`).catch(() => null)
  if (!tag) return {}

  const url = new URL(`${PREFIX}/tag/${slug}`, env.NEXT_PUBLIC_SITE_URL).toString()
  const title = `${tag.name} — Crowd4Test Blog`
  const description = `Posts tagged ${tag.name} on the Crowd4Test blog.`

  return {
    title,
    description,
    alternates: { canonical: url },
    robots: { index: false, follow: true },
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      title,
      description,
      url,
      images: ['/opengraph-image'],
    },
  }
}

export default async function BlogTagPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ page?: string }>
}) {
  const { slug } = await params
  const sp = await searchParams
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1)

  const tag = await publicFetch<BlogTagSummary>(`blog/tags/${slug}`, {
    next: { tags: ['blog-tags'] },
  }).catch(() => null)
  if (!tag) notFound()

  const { data: posts, meta } = await publicFetchPage<BlogPostSummary>('blog/posts', {
    query: { tag: slug, page, limit: PAGE_SIZE },
    next: { tags: ['blog-posts'] },
  })

  return (
    <>
      <JsonLd
        schema={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Blog', path: PREFIX },
          { name: tag.name, path: `${PREFIX}/tag/${slug}` },
        ])}
      />

      <Section tone="inverse" className={s.deep} compact>
        <div className="c4t-eyebrow" style={{ color: 'var(--text-inverse-muted)' }}>
          Tag
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
          {tag.name}
        </h1>
      </Section>

      <Section>
        {posts.length === 0 ? (
          <p className="c4t-body-lg" style={{ margin: 0, color: 'var(--text-secondary)' }}>
            No posts tagged {tag.name} yet.
          </p>
        ) : (
          <>
            <div
              /* Sized by the card — see the note on the blog index grid. */
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                gap: 'var(--space-grid-gap)',
              }}
            >
              {posts.map((post) => (
                <ResourceCard
                  key={post.slug}
                  type="Article"
                  category={post.category?.name}
                  title={post.title}
                  description={post.excerpt ?? undefined}
                  readTime={`${post.readingTimeMinutes} min read`}
                  author={post.author ?? undefined}
                  href={`${PREFIX}/${post.slug}`}
                  image={
                    post.featuredImageUrl
                      ? { src: post.featuredImageUrl, alt: post.title }
                      : undefined
                  }
                />
              ))}
            </div>

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
                    href={n > 1 ? `${PREFIX}/tag/${slug}?page=${n}` : `${PREFIX}/tag/${slug}`}
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
