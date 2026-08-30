import { notFound } from 'next/navigation'
import { revalidatePath, updateTag } from 'next/cache'
import { DetailShell } from '@/components/admin/DetailShell'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { SingleFileUpload } from '@/components/admin/SingleFileUpload'
import { ConfirmSubmit } from '@/components/admin/ConfirmSubmit'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { BlogEditor } from '@/components/admin/blog/BlogEditor'
import { TagCombobox, type TagOption } from '@/components/admin/blog/TagCombobox'
import { serverFetch, serverFetchOrNull } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { hasPermission, requireRole } from '@/lib/auth/session'
import { env } from '@/lib/env'
import { formatDate } from '@/lib/admin/format'
import {
  saveContentAction,
  saveSeoAction,
  publishPostAction,
  schedulePostAction,
  archivePostAction,
  revertToDraftAction,
  setFeaturedAction,
  deletePostAction,
  findOrCreateTagAction,
} from '../actions'

const BASE = '/app/admin/blog'

interface CategoryOption {
  id: string
  name: string
  slug: string
  isActive: boolean
}

interface PostDetail {
  id: string
  slug: string
  title: string
  excerpt: string | null
  content: string
  status: 'DRAFT' | 'SCHEDULED' | 'PUBLISHED' | 'ARCHIVED'
  categoryId: string | null
  authorId: string
  authorDisplayName: string | null
  featuredImageFileId: string | null
  featuredImageUrl: string | null
  isFeatured: boolean
  readingTimeMinutes: number
  viewCount: number
  seoTitle: string | null
  seoDescription: string | null
  previousSlugs: string[]
  scheduledAt: string | null
  publishedAt: string | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  category: { id: string; name: string; slug: string } | null
  author: { id: string; firstName: string | null; lastName: string | null }
  tags: TagOption[]
}

const SECTIONS = [
  { value: 'content', label: 'Content', icon: 'file-text' },
  { value: 'seo', label: 'SEO', icon: 'search' },
] as const

const NOTICES: Record<string, NoticeCopy> = {
  created: { tone: 'success', message: 'Post created. Add a category and featured image before publishing.' },
  saved: { tone: 'success', message: 'Changes saved.' },
  seo_saved: { tone: 'success', message: 'SEO details saved.' },
  published: { tone: 'success', message: 'Published. It now appears on the public blog.' },
  scheduled: { tone: 'success', message: 'Scheduled. It will go live automatically at the chosen time.' },
  archived: { tone: 'success', message: 'Archived. It no longer appears on the public blog.' },
  reverted: { tone: 'success', message: 'Moved back to draft.' },
  featured: { tone: 'success', message: 'Marked as featured. Any previously featured post was un-featured.' },
  unfeatured: { tone: 'success', message: 'No longer featured.' },
  not_ready: { tone: 'error', message: 'A post needs a category and a featured image before it can be published or scheduled.' },
  duplicate_slug: { tone: 'error', message: 'That slug is already used by another post.' },
  failed: { tone: 'error', message: "That didn't work. Try again." },
}

export default async function BlogPostDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ section?: string; notice?: string }>
}) {
  const user = await requireRole(['ADMIN', 'SUB_ADMIN'])
  const { id } = await params
  const sp = await searchParams
  const section = resolveSection(SECTIONS, sp.section)

  let post: PostDetail
  try {
    post = await serverFetch<PostDetail>(`blog/posts/admin/${id}`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    throw err
  }

  const [allCategories, allTags] = await Promise.all([
    serverFetchOrNull<CategoryOption[]>('blog/categories/admin'),
    serverFetchOrNull<TagOption[]>('blog/tags'),
  ])

  const canWrite = hasPermission(user, 'blog.write')
  const canPublish = hasPermission(user, 'blog.publish')
  const canDelete = hasPermission(user, 'blog.delete')

  // The category select must offer every active category, plus the post's
  // own current one even if it has since been retired — otherwise editing an
  // older post would silently drop a category nobody chose to remove.
  // Falls back to the post's own already-loaded category if the separate
  // categories list fetch fails or is transiently unavailable — otherwise a
  // hiccup there would silently drop the select's real option, the browser
  // would default to the blank placeholder, and saving the form would wipe
  // the post's category even though nobody touched that field.
  const categoryOptions = (allCategories ?? []).filter((c) => c.isActive || c.id === post.categoryId)
  if (post.category && !categoryOptions.some((c) => c.id === post.category!.id)) {
    categoryOptions.push({ ...post.category, isActive: true })
  }

  const detailHref = `${BASE}/${post.id}`
  const previewHref = `${env.NEXT_PUBLIC_SITE_URL}/company/blog/${post.slug}?preview=1`

  return (
    <DetailShell
      crumbs={[{ label: 'Blog', href: BASE }, { label: post.title }]}
      eyebrow="Content"
      title={post.title}
      subtitle={`/company/blog/${post.slug} · ${post.readingTimeMinutes} min read · ${post.viewCount} views`}
      badges={<StatusBadge status={post.status} />}
      tabs={<SectionTabs basePath={detailHref} tabs={SECTIONS} active={section} />}
      aside={
        <>
          <Panel title="Publish" description="Where this post stands, and what to do next.">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
              {canPublish ? (
                <PublishControls post={post} />
              ) : (
                <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>
                  You don&apos;t have the <code>blog.publish</code> permission — ask an admin to publish,
                  schedule or archive this post.
                </p>
              )}

              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 'var(--space-5)' }}>
                {canPublish ? (
                  <form action={setFeaturedAction}>
                    <input type="hidden" name="id" value={post.id} />
                    <input type="hidden" name="isFeatured" value={(!post.isFeatured).toString()} />
                    <SubmitButton
                      variant={post.isFeatured ? 'secondary' : 'ghost'}
                      fullWidth
                      iconLeft="star"
                      pendingLabel="Saving…"
                    >
                      {post.isFeatured ? 'Remove featured status' : 'Mark as featured'}
                    </SubmitButton>
                  </form>
                ) : null}
              </div>

              <Button href={previewHref} variant="secondary" fullWidth iconLeft="eye">
                Preview
              </Button>
            </div>
          </Panel>

          <Panel title="Record" description="What the platform knows about this post.">
            <DescriptionList
              items={[
                { label: 'Author', value: post.authorDisplayName ?? [post.author.firstName, post.author.lastName].filter(Boolean).join(' ') },
                { label: 'Created', value: formatDate(post.createdAt) },
                { label: 'Last updated', value: formatDate(post.updatedAt) },
                { label: 'Published', value: post.publishedAt ? formatDate(post.publishedAt) : '—' },
                { label: 'Reading time', value: `${post.readingTimeMinutes} min` },
                { label: 'Views', value: post.viewCount },
                {
                  label: 'Previous slugs',
                  value: post.previousSlugs.length ? post.previousSlugs.join(', ') : '—',
                  wide: true,
                },
              ]}
            />
          </Panel>

          {canDelete ? (
            <Panel title="Danger zone" description="Deleting a post removes it from the admin list and the public site.">
              <form action={deletePostAction}>
                <input type="hidden" name="id" value={post.id} />
                <input type="hidden" name="slug" value={post.slug} />
                <ConfirmSubmit
                  question={`Delete "${post.title}"? This cannot be undone.`}
                  confirmLabel="Yes, delete"
                  pendingLabel="Deleting…"
                >
                  Delete post
                </ConfirmSubmit>
              </form>
            </Panel>
          ) : null}
        </>
      }
    >
      <Notice code={sp.notice} notices={NOTICES} />

      {section === 'content' ? (
        <Panel title="Content" description="The title, slug, taxonomy and body every reader sees.">
          {canWrite ? (
            <form
              action={saveContentAction}
              style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}
            >
              <input type="hidden" name="id" value={post.id} />
              <input type="hidden" name="previousSlug" value={post.slug} />

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: 'var(--space-5) var(--space-6)',
                }}
              >
                <Field label="Title" htmlFor="title" required>
                  <Input id="title" name="title" required minLength={3} defaultValue={post.title} />
                </Field>
                <Field label="Slug" htmlFor="slug" hint="Changing this redirects the old URL automatically.">
                  <Input id="slug" name="slug" defaultValue={post.slug} pattern="[a-z0-9]+(-[a-z0-9]+)*" />
                </Field>
              </div>

              <Field label="Excerpt" htmlFor="excerpt" hint="Shown on post cards, in search results and as the SEO description fallback.">
                <Textarea id="excerpt" name="excerpt" rows={2} maxLength={300} defaultValue={post.excerpt ?? ''} />
              </Field>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: 'var(--space-5) var(--space-6)',
                }}
              >
                <Field label="Category" htmlFor="categoryId" required hint="Required to publish or schedule.">
                  <Select
                    id="categoryId"
                    name="categoryId"
                    defaultValue={post.categoryId ?? ''}
                    placeholder="Choose a category"
                    options={categoryOptions.map((c) => ({ value: c.id, label: c.name }))}
                  />
                </Field>
                <Field label="Byline" htmlFor="authorDisplayName" hint="Overrides the author's name on the public page. Leave blank to show the account name.">
                  <Input id="authorDisplayName" name="authorDisplayName" defaultValue={post.authorDisplayName ?? ''} />
                </Field>
              </div>

              <Field label="Tags" htmlFor="tags">
                <TagCombobox
                  name="tagIds"
                  allTags={allTags ?? []}
                  defaultSelected={post.tags}
                  findOrCreateTag={findOrCreateTagAction}
                />
              </Field>

              <Field label="Featured image" htmlFor="featuredImage" required hint="Required to publish or schedule. Also used as the social-share image.">
                <SingleFileUpload
                  endpoint="/app/admin/upload"
                  scope="blog-featured-image"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  label={post.featuredImageUrl ? 'Replace image' : 'Upload image'}
                  currentName={post.featuredImageUrl ? 'Current image set' : null}
                  onUploaded={attachFeaturedImage.bind(null, post.id)}
                />
                {post.featuredImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a plain admin-only preview thumbnail; next/image's remote-pattern allow-list is a marketing-site concern, not worth wiring here for one small preview.
                  <img
                    src={post.featuredImageUrl}
                    alt=""
                    style={{
                      marginTop: 'var(--space-3)',
                      maxWidth: 240,
                      borderRadius: 'var(--radius-media)',
                      border: '1px solid var(--border-default)',
                    }}
                  />
                ) : null}
              </Field>

              <Field label="Body" htmlFor="content">
                <BlogEditor name="content" defaultValue={post.content} />
              </Field>

              <SubmitButton variant="primary" iconLeft="check" pendingLabel="Saving…">
                Save changes
              </SubmitButton>
            </form>
          ) : (
            <DescriptionList
              items={[
                { label: 'Title', value: post.title },
                { label: 'Slug', value: post.slug },
                { label: 'Category', value: post.category?.name ?? '—' },
                { label: 'Excerpt', value: post.excerpt, wide: true },
              ]}
            />
          )}
        </Panel>
      ) : null}

      {section === 'seo' ? (
        <Panel title="SEO" description="Search and social-share metadata. Both fall back to the title and excerpt when left blank.">
          {canWrite ? (
            <form action={saveSeoAction} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
              <input type="hidden" name="id" value={post.id} />
              <Field
                label="SEO title"
                htmlFor="seoTitle"
                hint={`${(post.seoTitle ?? post.title).length}/70 characters — falls back to the post title.`}
              >
                <Input id="seoTitle" name="seoTitle" maxLength={70} defaultValue={post.seoTitle ?? ''} placeholder={post.title} />
              </Field>
              <Field
                label="SEO description"
                htmlFor="seoDescription"
                hint={`${(post.seoDescription ?? post.excerpt ?? '').length}/160 characters — falls back to the excerpt.`}
              >
                <Textarea
                  id="seoDescription"
                  name="seoDescription"
                  rows={3}
                  maxLength={160}
                  defaultValue={post.seoDescription ?? ''}
                  placeholder={post.excerpt ?? ''}
                />
              </Field>
              <SubmitButton variant="primary" iconLeft="check" pendingLabel="Saving…">
                Save SEO details
              </SubmitButton>
            </form>
          ) : (
            <DescriptionList
              items={[
                { label: 'SEO title', value: post.seoTitle ?? `${post.title} (from title)` },
                { label: 'SEO description', value: post.seoDescription ?? `${post.excerpt ?? ''} (from excerpt)` },
              ]}
            />
          )}
        </Panel>
      ) : null}
    </DetailShell>
  )
}

/**
 * Bound with the post id (`.bind(null, post.id)`), then handed to
 * `SingleFileUpload` as `onUploaded` — Next's supported way to pass extra
 * data to a Server Action invoked directly from client code rather than
 * through a `<form action>`.
 */
async function attachFeaturedImage(postId: string, formData: FormData): Promise<void> {
  'use server'
  const fileId = formData.get('fileId')
  if (typeof fileId !== 'string' || !fileId) return
  await serverFetch(`blog/posts/admin/${postId}`, {
    method: 'PATCH',
    body: { featuredImageFileId: fileId },
  })
  revalidatePath(`${BASE}/${postId}`)
  updateTag('blog-posts')
}

function PublishControls({ post }: { post: PostDetail }) {
  const canPublishNow = Boolean(post.categoryId && post.featuredImageFileId)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {!canPublishNow ? (
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>
          Add a category and a featured image on the Content tab before publishing or scheduling.
        </p>
      ) : null}

      {post.status === 'DRAFT' || post.status === 'ARCHIVED' ? (
        <>
          <form action={publishPostAction}>
            <input type="hidden" name="id" value={post.id} />
            <SubmitButton variant="primary" fullWidth iconLeft="check" disabled={!canPublishNow} pendingLabel="Publishing…">
              Publish now
            </SubmitButton>
          </form>
          <form
            action={schedulePostAction}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
          >
            <input type="hidden" name="id" value={post.id} />
            <Field label="Schedule for" htmlFor="scheduledAt">
              <Input id="scheduledAt" name="scheduledAt" type="datetime-local" required disabled={!canPublishNow} />
            </Field>
            <SubmitButton variant="secondary" fullWidth iconLeft="clock" disabled={!canPublishNow} pendingLabel="Scheduling…">
              Schedule
            </SubmitButton>
          </form>
        </>
      ) : null}

      {post.status === 'SCHEDULED' ? (
        <>
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>
            Goes live automatically on {post.scheduledAt ? formatDate(post.scheduledAt) : '—'}.
          </p>
          <form action={publishPostAction}>
            <input type="hidden" name="id" value={post.id} />
            <SubmitButton variant="primary" fullWidth iconLeft="check" pendingLabel="Publishing…">
              Publish now instead
            </SubmitButton>
          </form>
          <form action={revertToDraftAction}>
            <input type="hidden" name="id" value={post.id} />
            <SubmitButton variant="ghost" fullWidth pendingLabel="Cancelling…">
              Cancel schedule
            </SubmitButton>
          </form>
        </>
      ) : null}

      {post.status === 'PUBLISHED' ? (
        <form action={archivePostAction}>
          <input type="hidden" name="id" value={post.id} />
          <SubmitButton variant="secondary" fullWidth iconLeft="eye-off" pendingLabel="Archiving…">
            Archive
          </SubmitButton>
        </form>
      ) : null}

      {post.status === 'ARCHIVED' ? (
        <form action={revertToDraftAction}>
          <input type="hidden" name="id" value={post.id} />
          <SubmitButton variant="ghost" fullWidth pendingLabel="Saving…">
            Revert to draft
          </SubmitButton>
        </form>
      ) : null}
    </div>
  )
}
