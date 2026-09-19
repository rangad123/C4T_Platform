import type { ReactNode } from 'react'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Pagination } from '@/components/ds/admin/Pagination'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import type { IconName } from '@/components/ds/core/icon-registry'
import type { ListResult } from '@/lib/admin/list'
import { HrTopbar, type HrCrumb } from './HrTopbar'

export interface HrAdminListPageProps<Row> {
  eyebrow: string
  title: string
  description: string
  crumbs: readonly HrCrumb[]
  root: { label: string; href: string }

  result: ListResult<Row>
  columns: readonly TableColumn<Row>[]
  rowKey: (row: Row) => string
  rowHref?: (row: Row) => string
  hrefFor: (page: number) => string

  tabs?: ReactNode
  toolbar?: ReactNode
  summary?: ReactNode

  /**
   * An alternative rendering of the same `result.items`, shown instead of the
   * table when `view` is `cards`.
   *
   * Passed in rather than derived here: a card is a layout decision about one
   * kind of record — which field is the title, which the meta line — and the
   * `columns` array does not carry enough to guess it. The shell keeps owning
   * everything around the list: the header, the empty and error states, and
   * the pagination, all of which are the same either way.
   */
  cards?: ReactNode
  view?: 'table' | 'cards'

  emptyTitle: string
  emptyDescription: string
  emptyIcon?: IconName
  filtered?: boolean
}

/**
 * HRMS's own list-page shell — structural copy of
 * `components/admin/AdminListPage.tsx` with `HrTopbar` in place of the
 * platform's `Topbar`, and no `permission` prop: every HRMS admin route is
 * gated to the single ADMIN role (no per-permission Sub-Admin grants exist
 * here), so a 403 needs no "ask for this permission" copy, just a plain
 * access-denied state.
 */
export function HrAdminListPage<Row>({
  eyebrow,
  title,
  description,
  crumbs,
  root,
  result,
  columns,
  rowKey,
  rowHref,
  hrefFor,
  tabs,
  toolbar,
  summary,
  cards,
  view = 'table',
  emptyTitle,
  emptyDescription,
  emptyIcon = 'inbox',
  filtered = false,
}: HrAdminListPageProps<Row>) {
  return (
    <>
      <HrTopbar crumbs={crumbs} root={root} />

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

        {tabs}

        {toolbar}

        {'error' in result ? (
          result.error === 'forbidden' ? (
            <EmptyState
              icon="lock"
              title={`You don't have access to ${title.toLowerCase()}`}
              description="Ask an HR administrator for access."
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
              filtered ? 'Try widening the search or clearing the filters.' : emptyDescription
            }
          />
        ) : (
          <>
            {summary}
            {view === 'cards' && cards ? (
              cards
            ) : (
              <Table
                ariaLabel={title}
                columns={columns}
                rows={result.items}
                rowKey={rowKey}
                rowHref={rowHref}
              />
            )}
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
