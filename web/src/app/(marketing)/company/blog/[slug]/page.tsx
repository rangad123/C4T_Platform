import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, permanentRedirect } from 'next/navigation'
import { Badge, Button, CtaBanner, ResourceCard, Section } from '@/components/ds'
import { ShareRow } from '@/components/ds/marketing/ShareRow'
import { DeepBand } from '@/components/sections/blocks'
import s from '@/components/sections/sections.module.css'
import { JsonLd } from '@/components/seo/JsonLd'
import { serverFetch } from '@/lib/api/server'
import { publicFetchPage, publicFetchWithExtras } from '@/lib/api/public'
import { ApiError } from '@/lib/api/types'
import { PostLead } from './PostLead'
import { PostGallery } from './PostGallery'
import { SITE_NAME } from '@/lib/seo/metadata'
import { blogPostingJsonLd, breadcrumbJsonLd } from '@/lib/seo/structured-data'
import { env } from '@/lib/env'
import { CLOSING_CTA } from '@/content'
import type { BlogPostDetail, BlogPostSummary } from '@/lib/blog/types'
import styles from './article.module.css'

const PREFIX = '/company/blog'

/**
 * A blog post — rewritten to read from the database (see the plan: the
 * static `content/blog.ts` collection is retired entirely).
 *
 * Every slug now renders on demand rather than from a build-time
 * `generateStaticParams` list — the old static site's assumption ("only
 * pre-declared slugs exist") is exactly what this feature's "no manual
 * refresh" requirement rules out. Freshness comes from `publicFetch`'s
 * `next.tags` + the admin's `updateTag` calls instead, not from
 * `dynamicParams = false` + rebuild.
 */

/** Resolves the post for a real visit, or — behind `?preview=1` — for the admin editor's Preview button. */
async function loadPost(
  slug: string,
  isPreviewRequest: boolean,
): Promise<{ post: BlogPostDetail; redirectTo: string | null }> {
  if (isPreviewRequest) {
    try {
      const post = await serverFetch<BlogPostDetail>(`blog/posts/${slug}/preview`)
      return { post, redirectTo: null }
    } catch {
      // Not signed in, lacking `blog.read`, or the slug genuinely doesn't
      // exist — fall through to the normal public path below rather than
      // surfacing anything. A non-admin pasting `?preview=1` onto a real
      // URL should see exactly what everyone else sees, and learn nothing
      // about whether a draft exists at a slug that isn't live.
    }
  }

  const { data: post, redirectTo } = await publicFetchWithExtras<
    BlogPostDetail,
    { redirectTo: string | null }
  >(`blog/posts/${slug}`, { next: { tags: [`blog-post-${slug}`] } })
  return { post, redirectTo }
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ preview?: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const sp = await searchParams

  let post: BlogPostDetail
  try {
    ;({ post } = await loadPost(slug, sp.preview === '1'))
  } catch {
    return {}
  }

  const url = new URL(`${PREFIX}/${slug}`, env.NEXT_PUBLIC_SITE_URL).toString()
  const title = post.seoTitle ?? post.title
  const description = post.seoDescription ?? post.excerpt ?? undefined
  const isLive = post.status === 'PUBLISHED'

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      // `article`, not `website` — it carries the publication date, which is
      // what makes a post eligible for the news/article treatments.
      type: 'article',
      siteName: SITE_NAME,
      title,
      description,
      url,
      // Always explicit — Next replaces `openGraph` wholesale on override
      // rather than merging, so omitting `images` here would silently drop
      // the fallback and every share of this post would unfurl with none.
      images: [post.featuredImageUrl ?? '/opengraph-image'],
      publishedTime: post.publishedAt ?? undefined,
      authors: post.author ? [post.author] : undefined,
    },
    twitter: { card: 'summary_large_image', title, description },
    ...(isLive ? {} : { robots: { index: false, follow: false } }),
  }
}

export default async function BlogPostPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ preview?: string }>
}) {
  const { slug } = await params
  const sp = await searchParams
  const isPreviewRequest = sp.preview === '1'

  let post: BlogPostDetail
  let redirectTo: string | null
  try {
    ;({ post, redirectTo } = await loadPost(slug, isPreviewRequest))
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    throw err
  }

  // A slug change: the old URL still resolves (via `previousSlugs`), so send
  // the visitor and every search engine on to the current one instead of
  // quietly serving the post at a URL that no longer matches its metadata.
  if (redirectTo) permanentRedirect(`${PREFIX}/${redirectTo}`)

  const isLive = post.status === 'PUBLISHED'

  const related = isLive
    ? await publicFetchPage<BlogPostSummary>('blog/posts', {
        query: { category: post.category?.slug, excludeId: post.id, limit: 3 },
        next: { tags: ['blog-posts'] },
      })
        .then((r) => r.data)
        .catch(() => [])
    : []

  const breadcrumbTrail = [
    { name: 'Home', path: '/' },
    { name: 'Blog', path: PREFIX },
    ...(post.category
      ? [{ name: post.category.name, path: `${PREFIX}/category/${post.category.slug}` }]
      : []),
    { name: post.title, path: `${PREFIX}/${slug}` },
  ]

  return (
    <>
      {/* No `BlogPosting` markup on a non-live preview — marking up an
          article as published when it is not yet true is exactly the
          mistake the old static page's own comment warned about. */}
      <JsonLd
        schema={
          isLive
            ? [blogPostingJsonLd(post), breadcrumbJsonLd(breadcrumbTrail)]
            : breadcrumbJsonLd(breadcrumbTrail)
        }
      />

      <Section tone="inverse" className={s.deep} compact>
        <PostLead
          layout={post.layout ?? 'STANDARD'}
          title={post.title}
          featuredImageUrl={post.featuredImageUrl}
          secondaryImageUrl={post.secondaryImageUrl}
        >
        <nav
          aria-label="Breadcrumb"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 6,
            marginBottom: 'var(--space-5)',
            fontSize: 'var(--type-caption-size)',
            color: 'var(--text-inverse-muted)',
          }}
        >
          {breadcrumbTrail.slice(0, -1).map((crumb) => (
            <span key={crumb.path} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Link href={crumb.path} style={{ color: 'inherit', textDecoration: 'none' }}>
                {crumb.name}
              </Link>
              <span aria-hidden="true">/</span>
            </span>
          ))}
          <span style={{ color: 'var(--text-inverse)' }} aria-current="page">
            {post.title}
          </span>
        </nav>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="c4t-eyebrow" style={{ color: 'var(--text-inverse-muted)' }}>
            {post.category?.name ?? 'Article'}
          </span>
          {!isLive ? (
            <Badge tone="warning">
              {post.status === 'DRAFT'
                ? 'Draft — preview only'
                : post.status === 'SCHEDULED'
                  ? 'Scheduled — preview only'
                  : 'Archived — preview only'}
            </Badge>
          ) : null}
          {post.publishedAt ? (
            <span
              className="c4t-eyebrow"
              style={{ color: 'var(--text-inverse-muted)', letterSpacing: '0.06em' }}
            >
              {formatDate(post.publishedAt)}
            </span>
          ) : null}
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 'var(--type-caption-size)',
              color: 'var(--text-inverse-muted)',
            }}
          >
            {post.readingTimeMinutes} min read
          </span>
        </div>

        <h1
          className="c4t-display-lg"
          style={{
            margin: '20px 0 0',
            color: 'var(--text-inverse)',
            maxWidth: 900,
            textWrap: 'pretty',
          }}
        >
          {post.title}
        </h1>

        {post.excerpt ? (
          <p
            className="c4t-body-lg"
            style={{ margin: '24px 0 0', color: 'var(--text-inverse-muted)', maxWidth: 620 }}
          >
            {post.excerpt}
          </p>
        ) : null}

        {/*
          The featured image, on the post it belongs to.

          It was already being uploaded, stored and served — the index card
          rendered it and `generateMetadata` put it in the OpenGraph tags —
          but the article itself never showed it. So an author picked an
          image, saw it as a thumbnail, and found the post it was for had no
          picture at all.

          `priority` because this is the hero: it is the largest thing above
          the fold, and lazy-loading it means the reader watches it arrive.
          16/9 to match the shape the index card crops to, so the same
          upload reads the same way in both places.
        */}
        </PostLead>
      </Section>

      <Section>
        {/* `--container-prose` caps the measure at ~75ch — long-form is the
            one place on this site where line length is the whole
            typographic problem. */}
        {/*
          A GALLERY post leads with its pictures; every other layout shows
          them after the article, where they read as a set of supporting
          images rather than the point of the page.
        */}
        {post.layout === 'GALLERY' ? (
          <div style={{ marginBottom: 'var(--space-8)' }}>
            <PostGallery images={post.galleryImages ?? []} title={post.title} lead />
          </div>
        ) : null}

        <div style={{ maxWidth: 'var(--container-prose)', margin: '0 auto' }}>
          <div className={styles.article} dangerouslySetInnerHTML={{ __html: post.content }} />

          {post.layout !== 'GALLERY' ? (
            <PostGallery images={post.galleryImages ?? []} title={post.title} />
          ) : null}

          <div
            style={{
              marginTop: 'var(--space-8)',
              paddingTop: 'var(--space-7)',
              borderTop: '1px solid var(--border-default)',
            }}
          >
            <ShareRow
              url={new URL(`${PREFIX}/${post.slug}`, env.NEXT_PUBLIC_SITE_URL).toString()}
              title={post.title}
            />
          </div>

          <div style={{ marginTop: 'var(--space-9)' }}>
            <Button variant="secondary" iconLeft="arrow-left" href={PREFIX}>
              All posts
            </Button>
          </div>
        </div>

        {related.length > 0 ? (
          <div style={{ marginTop: 'var(--space-13)' }}>
            <h2 className="c4t-heading-md" style={{ margin: '0 0 var(--space-6)' }}>
              Related articles
            </h2>
            <div
              className="c4t-grid-3"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 'var(--space-grid-gap)',
              }}
            >
              {related.map((item) => (
                <ResourceCard
                  key={item.slug}
                  type="Article"
                  category={item.category?.name}
                  title={item.title}
                  description={item.excerpt ?? undefined}
                  readTime={`${item.readingTimeMinutes} min read`}
                  author={item.author ?? undefined}
                  href={`${PREFIX}/${item.slug}`}
                  image={
                    item.featuredImageUrl
                      ? { src: item.featuredImageUrl, alt: item.title }
                      : undefined
                  }
                />
              ))}
            </div>
          </div>
        ) : null}
      </Section>

      <DeepBand>
        <CtaBanner tone="inverse" style={{ background: 'transparent' }} {...CLOSING_CTA} />
      </DeepBand>
    </>
  )
}

/** `en-GB` explicitly, not the server's locale — see the note on the same helper elsewhere in this codebase. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}
