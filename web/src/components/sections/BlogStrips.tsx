import { CaseStudyCard, ResourceCard } from '@/components/ds'
import { Carousel } from '@/components/sections/Carousel'
import type { BlogPostSummary } from '@/lib/blog/types'

const POST_PATH = '/company/blog'

function photo(post: BlogPostSummary): { src: string; alt: string } | undefined {
  return post.featuredImageUrl ? { src: post.featuredImageUrl, alt: post.title } : undefined
}

/**
 * The case-study carousel, built from blog posts.
 *
 * One component for the homepage, the About page and the case-study index, so
 * the three cannot drift into showing the same posts three different ways.
 * A post is a case study by being filed as one; it links to its own page in
 * the blog, where the full write-up lives.
 */
export function CaseStudyStrip({ posts }: { posts: readonly BlogPostSummary[] }) {
  return (
    <Carousel
      variant="deck"
      label="Case studies"
      itemNoun="case study"
      slides={posts.map((post) => (
        <CaseStudyCard
          key={post.id}
          industry={post.category?.name ?? 'Case study'}
          headline={post.title}
          description={post.excerpt ?? undefined}
          image={photo(post)}
          href={`${POST_PATH}/${post.slug}`}
        />
      ))}
    />
  )
}

/** The resources coverflow, built from the blog's non-case-study posts. */
export function ResourceStrip({ posts }: { posts: readonly BlogPostSummary[] }) {
  return (
    <Carousel
      variant="coverflow"
      label="Resources"
      itemNoun="resource"
      slides={posts.map((post) => (
        <ResourceCard
          key={post.id}
          type="Article"
          category={post.category?.name}
          title={post.title}
          description={post.excerpt ?? undefined}
          image={photo(post)}
          href={`${POST_PATH}/${post.slug}`}
          clamp
        />
      ))}
    />
  )
}
