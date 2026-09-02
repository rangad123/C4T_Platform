'use server'

import { redirect } from 'next/navigation'
import { revalidatePath, updateTag } from 'next/cache'
import { actionFetch } from '@/lib/api/action-fetch'
import { ApiError } from '@/lib/api/types'
import { formTrimmed, formStringArray } from '@/lib/form-data'

const BASE = '/app/admin/blog'

interface PostResponse {
  id: string
  slug: string
}

/**
 * Revalidates both the admin list/detail cache (`revalidatePath`, always
 * fresh — the admin portal never caches reads) and the PUBLIC marketing
 * site's cache (`updateTag`) after any mutation. The public `/company/blog`
 * pages fetch through `publicFetch`, tagged `blog-posts` / `blog-post-<slug>`
 * — see `web/src/lib/api/public.ts` — so this is what makes a publish show up
 * on the live site immediately, with no redeploy and no manual refresh.
 *
 * `updateTag`, not `revalidateTag`: this runs inside a Server Action and the
 * whole point is read-your-own-writes — the next request for this tag must
 * see the fresh data, not `revalidateTag`'s stale-while-revalidate ("next
 * *visit*, not next *request*") semantics, which is right for a Route
 * Handler but wrong for "I just published this."
 */
function revalidateBlog(id: string, slug: string, previousSlug?: string): void {
  revalidatePath(BASE)
  revalidatePath(`${BASE}/${id}`)
  updateTag('blog-posts')
  updateTag(`blog-post-${slug}`)
  if (previousSlug && previousSlug !== slug) updateTag(`blog-post-${previousSlug}`)
}

function redirectWithNotice(id: string, code: string): never {
  redirect(`${BASE}/${id}?notice=${code}`)
}

export async function createPostAction(formData: FormData): Promise<void> {
  const title = formTrimmed(formData, 'title')
  /**
   * The chosen starter template, passed on to the editor rather than stored.
   *
   * `POST blog/posts/admin` takes a title and nothing else — it writes
   * `content: ''` and does not sanitize, so sending body HTML through it
   * would store it unsanitized. The editor seeds from this instead, and the
   * skeleton reaches the database through the ordinary save path, sanitized
   * like anything else the author types.
   */
  const template = formTrimmed(formData, 'template')

  let post: PostResponse
  try {
    post = await actionFetch<PostResponse>('blog/posts/admin', { method: 'POST', body: { title } })
  } catch {
    redirect(`${BASE}/new?error=failed&title=${encodeURIComponent(title)}`)
  }

  revalidatePath(BASE)
  redirect(
    `${BASE}/${post.id}?notice=created${template ? `&template=${encodeURIComponent(template)}` : ''}`,
  )
}

export async function saveContentAction(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const previousSlug = formTrimmed(formData, 'previousSlug') || undefined

  const body = {
    title: formTrimmed(formData, 'title') || undefined,
    slug: formTrimmed(formData, 'slug') || undefined,
    excerpt: formTrimmed(formData, 'excerpt') || undefined,
    content: formTrimmed(formData, 'content'),
    categoryId: formTrimmed(formData, 'categoryId') || null,
    authorDisplayName: formTrimmed(formData, 'authorDisplayName') || null,
    tagIds: formStringArray(formData, 'tagIds'),
  }

  let post: PostResponse
  try {
    post = await actionFetch<PostResponse>(`blog/posts/admin/${id}`, { method: 'PATCH', body })
  } catch (err) {
    const code = err instanceof ApiError && err.status === 409 ? 'duplicate_slug' : 'failed'
    redirectWithNotice(id, code)
  }

  revalidateBlog(post.id, post.slug, previousSlug)
  redirectWithNotice(post.id, 'saved')
}

export async function saveSeoAction(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')

  const body = {
    seoTitle: formTrimmed(formData, 'seoTitle') || undefined,
    seoDescription: formTrimmed(formData, 'seoDescription') || undefined,
  }

  let post: PostResponse
  try {
    post = await actionFetch<PostResponse>(`blog/posts/admin/${id}`, { method: 'PATCH', body })
  } catch {
    redirectWithNotice(id, 'failed')
  }

  revalidateBlog(post.id, post.slug)
  redirectWithNotice(post.id, 'seo_saved')
}

export async function setFeaturedAction(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const isFeatured = formTrimmed(formData, 'isFeatured') === 'true'

  let post: PostResponse
  try {
    post = await actionFetch<PostResponse>(`blog/posts/admin/${id}`, {
      method: 'PATCH',
      body: { isFeatured },
    })
  } catch {
    redirectWithNotice(id, 'failed')
  }

  revalidateBlog(post.id, post.slug)
  // Featuring one post un-features whichever post held it before — the list
  // page is the only place that would still show the old state.
  revalidatePath(BASE)
  redirectWithNotice(post.id, isFeatured ? 'featured' : 'unfeatured')
}

export async function publishPostAction(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')

  let post: PostResponse
  try {
    post = await actionFetch<PostResponse>(`blog/posts/admin/${id}/publish`, { method: 'POST' })
  } catch (err) {
    const code = err instanceof ApiError && err.status === 400 ? 'not_ready' : 'failed'
    redirectWithNotice(id, code)
  }

  revalidateBlog(post.id, post.slug)
  redirectWithNotice(post.id, 'published')
}

export async function schedulePostAction(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const scheduledAt = formTrimmed(formData, 'scheduledAt')

  let post: PostResponse
  try {
    post = await actionFetch<PostResponse>(`blog/posts/admin/${id}/schedule`, {
      method: 'POST',
      body: { scheduledAt },
    })
  } catch (err) {
    const code = err instanceof ApiError && err.status === 400 ? 'not_ready' : 'failed'
    redirectWithNotice(id, code)
  }

  revalidateBlog(post.id, post.slug)
  redirectWithNotice(post.id, 'scheduled')
}

export async function archivePostAction(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')

  let post: PostResponse
  try {
    post = await actionFetch<PostResponse>(`blog/posts/admin/${id}/archive`, { method: 'POST' })
  } catch {
    redirectWithNotice(id, 'failed')
  }

  revalidateBlog(post.id, post.slug)
  redirectWithNotice(post.id, 'archived')
}

export async function revertToDraftAction(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')

  let post: PostResponse
  try {
    post = await actionFetch<PostResponse>(`blog/posts/admin/${id}/revert-to-draft`, {
      method: 'POST',
    })
  } catch {
    redirectWithNotice(id, 'failed')
  }

  revalidateBlog(post.id, post.slug)
  redirectWithNotice(post.id, 'reverted')
}

export async function deletePostAction(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const slug = formTrimmed(formData, 'slug')

  try {
    await actionFetch<void>(`blog/posts/admin/${id}`, { method: 'DELETE' })
  } catch {
    redirectWithNotice(id, 'failed')
  }

  revalidatePath(BASE)
  updateTag('blog-posts')
  updateTag(`blog-post-${slug}`)
  redirect(`${BASE}?notice=deleted`)
}

// ─── Tags ──────────────────────────────────────────────────────────────────

interface TagResponse {
  id: string
  name: string
  slug: string
}

/**
 * Passed as a prop straight into `TagCombobox` (a Client Component) — Next
 * supports invoking a Server Action this way, not just via `<form action>`.
 * §71: this is the ONLY tag write in the app, called from the editor's tag
 * picker on demand rather than through a separate tag-management page.
 */
export async function findOrCreateTagAction(name: string): Promise<TagResponse> {
  return actionFetch<TagResponse>('blog/tags/find-or-create', { method: 'POST', body: { name } })
}
