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
import type { BlogCategorySummary, BlogPostSummary } from '@/lib/blog/types'

const PREFIX = '/company/blog'
const PAGE_SIZE = 12

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const category = await publicFetch<BlogCategorySummary>(`blog/categories/${slug}`).catch(
    () => null,
  )
  if (!category) return {}

  const url = new URL(`${PREFIX}/category/${slug}`, env.NEXT_PUBLIC_SITE_URL).toString()
  const title = `${category.name} — Crowd4Test Blog`
  const description =
    category.description ?? `Posts filed under ${category.name} on the Crowd4Test blog.`

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      title,
      description,
      url,
      images: ['/opengraph-image'],
    },
    twitter: { card: 'summary_large_image', title, description },
  }
}

/** `/company/blog/category/[slug]` — same listing shell as the index, filtered to one category. */
export default async function BlogCategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ page?: string }>
}) {
  const { slug } = await params
  const sp = await searchParams
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1)

  const category = await publicFetch<BlogCategorySummary>(`blog/categories/${slug}`, {
    next: { tags: ['blog-categories'] },
  }).catch(() => null)
  if (!category) notFound()

  const { data: posts, meta } = await publicFetchPage<BlogPostSummary>('blog/posts', {
    query: { category: slug, page, limit: PAGE_SIZE },
    next: { tags: ['blog-posts'] },
  })

  return (
    <>
      <JsonLd
        schema={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Blog', path: PREFIX },
          { name: category.name, path: `${PREFIX}/category/${slug}` },
        ])}
      />

      <Section tone="inverse" className={s.deep} compact>
        <div className="c4t-eyebrow" style={{ color: 'var(--text-inverse-muted)' }}>
          Category
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
          {category.name}
        </h1>
        {category.description ? (
          <p
            className="c4t-body-lg"
            style={{ margin: '24px 0 0', color: 'var(--text-inverse-muted)', maxWidth: 620 }}
          >
            {category.description}
          </p>
        ) : null}
      </Section>

      <Section>
        {posts.length === 0 ? (
          <p className="c4t-body-lg" style={{ margin: 0, color: 'var(--text-secondary)' }}>
            No posts in this category yet.
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
                    href={
                      n > 1 ? `${PREFIX}/category/${slug}?page=${n}` : `${PREFIX}/category/${slug}`
                    }
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
