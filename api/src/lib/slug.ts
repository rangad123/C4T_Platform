/**
 * Pure string transform, shared by BlogPost/BlogCategory/BlogTag's own
 * uniqueness loops. Not a shared DB-querying helper — each model still owns
 * its own uniqueness query, matching how `organisations.service.ts`'s
 * `uniqueSlug()` already works.
 */
export function slugify(base: string, maxLength = 60): string {
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLength) || 'item'
  )
}
