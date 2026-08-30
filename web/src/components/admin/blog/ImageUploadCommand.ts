/**
 * Uploads one image through `/app/admin/upload` (scope `blog-featured-image`
 * — inline article images share the same public scope as the post's own
 * featured image, see the `FileScope.BLOG_FEATURED_IMAGE` comment in the
 * Prisma schema) and resolves to the permanent public URL the route hands
 * back for that scope.
 *
 * A plain function, not a component: it's called directly from the
 * toolbar's "Insert image" button, via a hidden file input, and its only
 * job is to hand the result to `editor.chain().setImage(...)`.
 */
export async function uploadEditorImage(file: File): Promise<{ url: string; alt: string }> {
  const body = new FormData()
  body.append('file', file)
  body.append('scope', 'blog-featured-image')

  const response = await fetch('/app/admin/upload', { method: 'POST', body })
  const payload = (await response.json()) as { url?: string; name?: string; error?: string }

  if (!response.ok || !payload.url) {
    throw new Error(payload.error ?? 'That image could not be uploaded.')
  }

  return { url: payload.url, alt: payload.name ?? '' }
}
