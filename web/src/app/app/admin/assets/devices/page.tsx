import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { CountryFlag } from '@/components/admin/CountryFlag'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { personName, searchTerm, hasFilter, titleCase, formatDate } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'

const PAGE_SIZE = 25
const BASE = '/app/admin/assets/devices'
const TYPES = ['MOBILE', 'TABLET', 'DESKTOP', 'SMART_TV', 'WEARABLE', 'OTHER'] as const
const SORT_OPTIONS = [
  { value: 'createdAt', label: 'Added' },
  { value: 'model', label: 'Model' },
  { value: 'manufacturer', label: 'Brand' },
] as const
const SORT_FIELDS = SORT_OPTIONS.map((o) => o.value)

interface DeviceRow {
  id: string
  type: string
  manufacturer: string | null
  model: string
  osName: string | null
  osVersion: string | null
  network: string | null
  createdAt: string
  testerProfile: {
    id: string
    countryCode: string | null
    user: { id: string; firstName: string | null; lastName: string | null } | null
  } | null
}

/**
 * `/app/admin/assets/devices` — every device any tester has registered,
 * across the whole platform.
 *
 * There is no separate "device catalogue" entity in this schema — legacy's
 * Global Assets > Devices is, here, an aggregate view over every tester's own
 * `TesterDevice` rows. "Added By" is the tester who registered it, and
 * "Country" is that tester's own country, not a property of the device.
 */
export default async function DevicesAssetPage({
  searchParams,
}: {
  searchParams: Promise<{
    search?: string
    type?: string
    countryCode?: string
    sort?: string
    order?: string
    page?: string
  }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const params = await searchParams
  const search = searchTerm(params.search)
  const type = TYPES.includes(params.type as (typeof TYPES)[number]) ? params.type : undefined
  const raw = params.countryCode?.trim().toUpperCase()
  const countryCode = raw && /^[A-Z]{2}$/.test(raw) ? raw : undefined
  const sort = SORT_FIELDS.includes(params.sort as (typeof SORT_FIELDS)[number])
    ? params.sort
    : undefined
  const order = params.order === 'asc' ? 'asc' : params.order === 'desc' ? 'desc' : undefined
  const page = parsePage(params.page)

  const result = await loadList<DeviceRow>('testers/devices', {
    page,
    limit: PAGE_SIZE,
    query: { search, type, countryCode, sort, order },
  })

  const columns: readonly TableColumn<DeviceRow>[] = [
    {
      key: 'model',
      header: 'Device',
      render: (row) => [row.manufacturer, row.model].filter(Boolean).join(' '),
      renderSecondary: (row) => titleCase(row.type),
    },
    {
      key: 'os',
      header: 'Operating system',
      render: (row) => row.osName ?? '—',
      renderSecondary: (row) => row.osVersion ?? undefined,
    },
    {
      key: 'network',
      header: 'Network',
      render: (row) => row.network ?? '—',
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
      title="Devices"
      description="Every device a tester has registered against their profile, across every project. There is no separate reference catalogue — this is the aggregate of what testers actually own."
      crumbs={[{ label: 'Assets' }, { label: 'Devices' }]}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      hrefFor={pageHrefBuilder(BASE, { search, type, countryCode, sort, order })}
      filtered={hasFilter([search, type, countryCode])}
      permission="tester.read"
      emptyIcon="smartphone"
      emptyTitle="No devices registered yet"
      emptyDescription="A device appears here as soon as a tester adds one to their profile."
      toolbar={
        <ListFilters
          action={BASE}
          search={{ value: search, placeholder: 'Model, brand, OS or browser' }}
          selects={[
            { name: 'type', label: 'Type', options: TYPES, value: type, allLabel: 'All types' },
          ]}
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
