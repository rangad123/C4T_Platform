import { requirePermission } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Button } from '@/components/ds/core/Button'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, searchTerm, hasFilter } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'

const PAGE_SIZE = 20
const BASE = '/app/admin/blog'
const STATUSES = ['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED'] as const
const SORT_OPTIONS = [
  { value: 'createdAt', label: 'Created' },
  { value: 'updatedAt', label: 'Last updated' },
  { value: 'publishedAt', label: 'Published' },
  { value: 'title', label: 'Title' },
  { value: 'viewCount', label: 'Views' },
] as const
const SORT_FIELDS = SORT_OPTIONS.map((o) => o.value)

interface CategoryOption {
  slug: string
  name: string
}

interface BlogPostRow {
  id: string
  slug: string
  title: string
  excerpt: string | null
  status: string
  isFeatured: boolean
  viewCount: number
  publishedAt: string | null
  createdAt: string
  category: { name: string; slug: string } | null
  author: { firstName: string | null; lastName: string | null } | null
  authorDisplayName: string | null
}

/**
 * `/app/admin/blog` — every blog post, any status.
 *
 * Mirrors the Organisations list page exactly: `AdminListPage` +
 * `ListFilters` + `loadList` against the admin-side API endpoint, which
 * returns every status (the public one only ever returns effectively-
 * published posts).
 */
export default async function BlogPostsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string
    category?: string
    search?: string
    page?: string
    sort?: string
    order?: string
  }>
}) {
  await requirePermission('blog.read')

  const params = await searchParams
  const status = STATUSES.includes(params.status as (typeof STATUSES)[number])
    ? params.status
    : undefined
  const search = searchTerm(params.search)
  const category = searchTerm(params.category)
  const sort = SORT_FIELDS.includes(params.sort as (typeof SORT_FIELDS)[number])
    ? params.sort
    : undefined
  const order = params.order === 'asc' ? 'asc' : params.order === 'desc' ? 'desc' : undefined
  const page = parsePage(params.page)

  const [result, categories] = await Promise.all([
    loadList<BlogPostRow>('blog/posts/admin', {
      page,
      limit: PAGE_SIZE,
      query: { status, category, search, sort, order },
    }),
    serverFetchOrNull<CategoryOption[]>('blog/categories/admin'),
  ])

  const columns: readonly TableColumn<BlogPostRow>[] = [
    {
      key: 'title',
      header: 'Post',
      render: (row) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          {row.isFeatured ? (
            <span title="Featured" style={{ color: 'var(--text-brand)', display: 'inline-flex' }}>
              ★
            </span>
          ) : null}
          {row.title}
        </span>
      ),
      renderSecondary: (row) => row.excerpt ?? row.slug,
    },
    { key: 'category', header: 'Category', render: (row) => row.category?.name ?? '—' },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'author',
      header: 'Author',
      render: (row) =>
        row.authorDisplayName ??
        [row.author?.firstName, row.author?.lastName].filter(Boolean).join(' ') ??
        '—',
    },
    {
      key: 'published',
      header: 'Published',
      align: 'right',
      render: (row) => (row.publishedAt ? formatDate(row.publishedAt) : '—'),
    },
    { key: 'views', header: 'Views', align: 'right', render: (row) => row.viewCount },
  ]

  return (
    <AdminListPage
      eyebrow="Content"
      title="Blog"
      description="Every post on the Crowd4Test blog, from first draft to published. Publishing or archiving here updates the public site immediately."
      crumbs={[{ label: 'Blog' }]}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `${BASE}/${row.id}`}
      hrefFor={pageHrefBuilder(BASE, { status, category, search, sort, order })}
      filtered={hasFilter([status, category, search])}
      permission="blog.read"
      emptyIcon="newspaper"
      emptyTitle="No posts yet"
      emptyDescription="Create the first post to get the blog started."
      toolbar={
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-3)',
            alignItems: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: 280 }}>
            <ListFilters
              action={BASE}
              search={{ value: search, placeholder: 'Title, slug or excerpt' }}
              selects={[
                {
                  name: 'status',
                  label: 'Status',
                  options: STATUSES,
                  value: status,
                  allLabel: 'All statuses',
                },
                {
                  name: 'category',
                  label: 'Category',
                  options: (categories ?? []).map((c) => ({ value: c.slug, label: c.name })),
                  value: category,
                  allLabel: 'All categories',
                },
              ]}
              sort={{ name: 'sort', orderName: 'order', options: SORT_OPTIONS, value: sort, order }}
            />
          </div>
          <Button href={`${BASE}/categories`} variant="secondary" iconLeft="tag">
            Categories
          </Button>
          <Button href={`${BASE}/new`} variant="primary" iconLeft="plus">
            New post
          </Button>
        </div>
      }
    />
  )
}
