/**
 * Blog index page CHROME only — the hero eyebrow/title/description and the
 * empty-state copy. This is the one piece of the blog that stays a typed
 * export: it's page furniture, not post content, and doesn't change per
 * post.
 *
 * Everything post-shaped (titles, bodies, categories, tags, publish state)
 * moved to the database — see `api/src/modules/blog/` and
 * `web/src/app/(marketing)/company/blog/`. This module previously held the
 * static `BlogPost`/`BLOG_POSTS` collection; it was retired when the blog
 * became a real admin-managed CMS.
 */

/** Transcribed from content.md §12.2. */
export const BLOG_INDEX = {
  eyebrow: 'Blog',
  title: 'Learn how modern QA actually works.',
  /** The deck from §12.2's body line. */
  description: "What we're learning from testing AI and software at scale.",
  /**
   * Shown when nothing is published. UI text, not marketing copy — there is
   * nothing in content.md to transcribe for an empty blog, and the
   * alternative is a heading over blank space.
   */
  emptyState: 'The first posts are being written. Check back shortly.',
} as const
