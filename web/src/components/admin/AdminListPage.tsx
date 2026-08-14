import type { ReactNode } from 'react'
import { Topbar } from '@/components/admin/Topbar'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Pagination } from '@/components/ds/admin/Pagination'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import type { IconName } from '@/components/ds/core/icon-registry'
import type { ListResult } from '@/lib/admin/list'

export interface AdminListPageProps<Row> {
  /** Sidebar group this page belongs to, shown as the eyebrow. */
  eyebrow: string
  /** Page heading. */
  title: string
  /** One or two sentences on what the list holds and what to do with it. */
  description: string
  /** Breadcrumb trail after "Admin". */
  crumbs: readonly { label: string; href?: string }[]

  /** The outcome of `loadList`. */
  result: ListResult<Row>
  columns: readonly TableColumn<Row>[]
  rowKey: (row: Row) => string
  rowHref?: (row: Row) => string

  /** Builds the URL for a given page, preserving filters. */
  hrefFor: (page: number) => string

  /** Optional filter form / actions rendered between the header and the table. */
  toolbar?: ReactNode
  /** Optional summary strip (totals, counts) above the table. */
  summary?: ReactNode

  /** Empty-state copy for when the list is genuinely empty. */
  emptyTitle: string
  emptyDescription: string
  emptyIcon?: IconName
  /** True when filters are applied — switches the empty state's wording. */
  filtered?: boolean
  /** The permission a sub-admin needs, named in the 403 empty state. */
  permission: string
}

/**
 * The shared shell for an admin list page.
 *
 * Eight sections render the same four things in the same order — topbar,
 * header, optional toolbar, then a table or one of three empty states — and
 * the only real difference between them is the columns. Writing that layout
 * eight times produced eight subtly different paddings the first time round,
 * so it lives here instead.
 *
 * The three terminal states are deliberately distinct, because they need
 * different actions from the reader:
 *
 *   forbidden — you cannot see this; ask for a grant
 *   unknown   — the service is down; retry
 *   empty     — nothing exists yet, or your filter excluded everything
 *
 * Collapsing them into one "no data" message is what makes an admin panel
 * feel broken: a 403 that looks like an empty table sends someone hunting for
 * missing records that are actually right there.
 */
export function AdminListPage<Row>({
  eyebrow,
  title,
  description,
  crumbs,
  result,
  columns,
  rowKey,
  rowHref,
  hrefFor,
  toolbar,
  summary,
  emptyTitle,
  emptyDescription,
  emptyIcon = 'inbox',
  filtered = false,
  permission,
}: AdminListPageProps<Row>) {
  return (
    <>
      <Topbar crumbs={crumbs} />

      <main
        id="main"
        style={{
          padding: 'var(--space-9)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-7)',
        }}
      >
        <header style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <p className="c4t-eyebrow" style={{ color: 'var(--text-muted)', margin: 0 }}>
            {eyebrow}
          </p>
          <h1 className="c4t-display-md" style={{ margin: 0 }}>
            {title}
          </h1>
          <p style={{ margin: 0, color: 'var(--text-secondary)', maxWidth: '75ch' }}>
            {description}
          </p>
        </header>

        {toolbar}

        {'error' in result ? (
          result.error === 'forbidden' ? (
            <EmptyState
              icon="lock"
              title={`You don't have access to ${title.toLowerCase()}`}
              description={`Ask an administrator to grant you the ${permission} permission.`}
            />
          ) : (
            <EmptyState
              icon="alert-triangle"
              title={`Couldn't load ${title.toLowerCase()}`}
              description="The service is unreachable. Refresh in a moment."
            />
          )
        ) : result.items.length === 0 ? (
          <EmptyState
            icon={filtered ? 'search' : emptyIcon}
            title={filtered ? `No ${title.toLowerCase()} match your filters` : emptyTitle}
            description={
              filtered
                ? 'Try widening the search or clearing the filters.'
                : emptyDescription
            }
          />
        ) : (
          <>
            {summary}
            <Table
              ariaLabel={title}
              columns={columns}
              rows={result.items}
              rowKey={rowKey}
              rowHref={rowHref}
            />
            <Pagination
              page={result.meta.page}
              totalPages={Math.max(1, result.meta.totalPages)}
              total={result.meta.total}
              limit={result.meta.limit}
              hrefFor={hrefFor}
            />
          </>
        )}
      </main>
    </>
  )
}
