import type { BlogPostLayout } from '@/lib/blog/types'

/**
 * How a post can be arranged on the public page.
 *
 * The body is the same sanitized HTML in every case — the layout changes the
 * frame around it, not the writing. Standard is what every post published
 * before this existed renders as, and stays the default, so adding the column
 * restyled nothing.
 *
 * The descriptions are what the author reads when choosing, so they say what
 * each one does to the page rather than naming the enum back at them.
 */
export interface BlogLayoutOption {
  value: BlogPostLayout
  label: string
  description: string
}

export const BLOG_LAYOUTS: readonly BlogLayoutOption[] = [
  {
    value: 'STANDARD',
    label: 'Standard',
    description: 'Title and summary, then the featured image above the article.',
  },
  {
    value: 'HERO',
    label: 'Hero',
    description: 'The featured image fills the top of the page with the title over it.',
  },
  {
    value: 'SPLIT',
    label: 'Split',
    description:
      'Title beside the image rather than above it. Uses the second image if there is one.',
  },
  {
    value: 'GALLERY',
    label: 'Gallery',
    description: 'Leads with the gallery. For posts that are mostly pictures.',
  },
]

export const BLOG_LAYOUT_OPTIONS = BLOG_LAYOUTS.map((l) => ({ value: l.value, label: l.label }))
