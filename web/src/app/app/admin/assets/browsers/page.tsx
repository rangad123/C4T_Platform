import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { AssetsTabs } from '../tabs'
import { ListFilters } from '@/components/admin/ListFilters'
import { CountryFlag } from '@/components/admin/CountryFlag'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { personName, searchTerm, hasFilter, formatDate } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'

const PAGE_SIZE = 25
const BASE = '/app/admin/assets/browsers'
const SORT_OPTIONS = [{ value: 'createdAt', label: 'Added' }] as const
const SORT_FIELDS = SORT_OPTIONS.map((o) => o.value)

interface BrowserRow {
  id: string
  osName: string | null
  osVersion: string | null
  browser: string | null
  createdAt: string
  testerProfile: {
    id: string
    countryCode: string | null
    user: { id: string; firstName: string | null; lastName: string | null } | null
  } | null
}

/**
 * `/app/admin/assets/browsers` — every browser a tester has recorded on a
 * registered device, across the whole platform.
 *
 * Same underlying data as `/app/admin/assets/devices`, filtered to rows that
 * carry a browser value (`onlyWithBrowser=true` on the API). There is no
 * separate `browserVersion` field — the schema captures browser name and
 * version together in one string (e.g. "Chrome 128"), so the legacy
 * checklist's "Browser Version" column is folded into the "Browser" column
 * here rather than fabricated as a second field with nothing to populate it.
 */
export default async function BrowsersAssetPage({
  searchParams,
}: {
  searchParams: Promise<{
    search?: string
    countryCode?: string
    sort?: string
    order?: string
    page?: string
  }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const params = await searchParams
  const search = searchTerm(params.search)
  const raw = params.countryCode?.trim().toUpperCase()
  const countryCode = raw && /^[A-Z]{2}$/.test(raw) ? raw : undefined
  const sort = SORT_FIELDS.includes(params.sort as (typeof SORT_FIELDS)[number])
    ? params.sort
    : undefined
  const order = params.order === 'asc' ? 'asc' : params.order === 'desc' ? 'desc' : undefined
  const page = parsePage(params.page)

  const result = await loadList<BrowserRow>('testers/devices', {
    page,
    limit: PAGE_SIZE,
    query: { search, countryCode, sort, order, onlyWithBrowser: true },
  })

  const columns: readonly TableColumn<BrowserRow>[] = [
    {
      key: 'os',
      header: 'OS name',
      render: (row) => row.osName ?? '—',
      renderSecondary: (row) => row.osVersion ?? undefined,
    },
    {
      key: 'browser',
      header: 'Browser',
      render: (row) => row.browser ?? '—',
    },
    {
      key: 'addedBy',
      header: 'Added by',
      render: (row) => (row.testerProfile?.user ? personName(row.testerProfile.user) : '—'),
      renderSecondary: (row) =>
        row.testerProfile?.countryCode ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
            <CountryFlag countryCode={row.testerProfile.countryCode} size={14} />
            <span>{row.testerProfile.countryCode}</span>
          </span>
        ) : undefined,
    },
    {
      key: 'added',
      header: 'Added',
      align: 'right',
      render: (row) => formatDate(row.createdAt),
    },
  ]

  return (
    <AdminListPage
      eyebrow="Assets"
      title="Browsers"
      description="Every browser a tester has recorded on a device, across every project. The same devices also appear on the Devices page — this view filters to the ones with a browser on file."
      crumbs={[{ label: 'Assets' }, { label: 'Browsers' }]}
      tabs={<AssetsTabs active="browsers" />}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      hrefFor={pageHrefBuilder(BASE, { search, countryCode, sort, order })}
      filtered={hasFilter([search, countryCode])}
      permission="tester.read"
      emptyIcon="monitor"
      emptyTitle="No browsers recorded yet"
      emptyDescription="A browser appears here once a tester records one on a device in their profile."
      toolbar={
        <ListFilters
          action={BASE}
          search={{ value: search, placeholder: 'Browser or OS name' }}
          texts={[
            {
              name: 'countryCode',
              label: 'Country',
              value: countryCode,
              placeholder: 'ISO 2-letter',
              maxLength: 2,
            },
          ]}
          sort={{ name: 'sort', orderName: 'order', options: SORT_OPTIONS, value: sort, order }}
        />
      }
    />
  )
}
