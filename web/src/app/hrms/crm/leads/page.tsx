import type { Metadata } from 'next'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { searchTerm, hasFilter, formatDate, titleCase } from '@/lib/admin/format'
import { requireCrmAccess } from '@/lib/hrms/hr-session'
import { hasCrmCapability, crmCapabilityScope } from '@/lib/hrms/hr-crm-capabilities'
import {
  loadCrmIndustryOptions,
  loadCrmLeadSourceOptions,
  loadCrmAssignableEmployeeOptions,
} from '@/lib/hrms/hr-catalog'
import { HrAdminListPage } from '@/components/hrms/HrAdminListPage'
import { Modal } from '@/components/admin/Modal'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { MultiSelect } from '@/components/admin/MultiSelect'
import { Button } from '@/components/ds/core/Button'
import { Icon } from '@/components/ds/core/Icon'
import type { TableColumn } from '@/components/ds/admin/Table'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { CountrySelect } from '@/components/ds/forms/CountrySelect'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { createLead } from './actions'

export const metadata: Metadata = { title: 'All leads' }

const BASE = '/crm/leads'

const CRM_LEAD_STATUSES = [
  'NEW',
  'UNQUALIFIED',
  'QUALIFIED',
  'PROSPECT',
  'WARM',
  'HOT',
  'COLD',
  'CLIENT',
  'LEAD_LOST',
  'SHUTDOWN',
] as const

const STATUS_OPTIONS = CRM_LEAD_STATUSES.map((value) => ({ value, label: titleCase(value) }))

const SORT_OPTIONS = [
  { value: 'createdAt', label: 'Newest first' },
  { value: 'updatedAt', label: 'Last updated' },
  { value: 'companyName', label: 'Company name' },
  { value: 'status', label: 'Status' },
]

const NOTICES: Record<string, NoticeCopy> = {
  refused: { tone: 'warning', message: 'That could not be done.' },
}

interface LeadRow {
  id: string
  companyName: string
  status: (typeof CRM_LEAD_STATUSES)[number]
  countryCode: string | null
  location: string | null
  industry: { id: string; name: string } | null
  leadSource: { id: string; name: string } | null
  assignedTo: { id: string; firstName: string; lastName: string; employeeCode: string } | null
  createdAt: string
  updatedAt: string
  lastActivityAt: string | null
}

interface SearchParams {
  page?: string
  search?: string
  status?: string
  industryId?: string
  leadSourceId?: string
  countryCode?: string
  assignedToId?: string
  createdFrom?: string
  createdTo?: string
  updatedFrom?: string
  updatedTo?: string
  lastActivityFrom?: string
  lastActivityTo?: string
  sort?: string
  order?: 'asc' | 'desc'
  add?: string
  notice?: string
  reason?: string
}

export default async function HrCrmLeadsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const employee = await requireCrmAccess()
  const crmRole = employee.crmRole!
  const canSeeAllLeads = crmCapabilityScope(crmRole, 'view_leads') === 'all'
  const canAssign = hasCrmCapability(crmRole, 'assign_leads')

  const params = await searchParams
  const page = parsePage(params.page)
  const search = searchTerm(params.search)
  const statusValues = (params.status ?? '').split(',').filter((v) => v.length > 0)
  const validStatuses = statusValues.filter((v): v is (typeof CRM_LEAD_STATUSES)[number] =>
    (CRM_LEAD_STATUSES as readonly string[]).includes(v),
  )
  const industryId = searchTerm(params.industryId)
  const leadSourceId = searchTerm(params.leadSourceId)
  const countryCode = searchTerm(params.countryCode)?.toUpperCase()
  const assignedToId = canSeeAllLeads ? searchTerm(params.assignedToId) : undefined
  const createdFrom = searchTerm(params.createdFrom)
  const createdTo = searchTerm(params.createdTo)
  const updatedFrom = searchTerm(params.updatedFrom)
  const updatedTo = searchTerm(params.updatedTo)
  const lastActivityFrom = searchTerm(params.lastActivityFrom)
  const lastActivityTo = searchTerm(params.lastActivityTo)

  const [industryOptions, leadSourceOptions, assignableEmployees] = await Promise.all([
    loadCrmIndustryOptions(),
    loadCrmLeadSourceOptions(),
    canSeeAllLeads || canAssign ? loadCrmAssignableEmployeeOptions() : Promise.resolve([]),
  ])

  const currentParams: Record<string, string | undefined> = {
    search,
    status: validStatuses.join(',') || undefined,
    industryId,
    leadSourceId,
    countryCode,
    assignedToId,
    createdFrom,
    createdTo,
    updatedFrom,
    updatedTo,
    lastActivityFrom,
    lastActivityTo,
    sort: params.sort,
    order: params.order,
  }

  const result = await loadList<LeadRow>('hrms/crm/leads', {
    page,
    limit: 20,
    query: currentParams,
  })

  function filterHref(overrides: Record<string, string | undefined>): string {
    const merged = { ...currentParams, ...overrides }
    const sp = new URLSearchParams()
    for (const [key, value] of Object.entries(merged)) {
      if (value) sp.set(key, value)
    }
    const qs = sp.toString()
    return qs ? `${BASE}?${qs}` : BASE
  }

  const industryName = industryOptions.find((o) => o.value === industryId)?.label
  const leadSourceName = leadSourceOptions.find((o) => o.value === leadSourceId)?.label
  const assigneeName =
    assignedToId === 'unassigned'
      ? 'Unassigned'
      : assignableEmployees.find((o) => o.value === assignedToId)?.label

  const chips: { label: string; href: string }[] = [
    ...(search ? [{ label: `Search: "${search}"`, href: filterHref({ search: undefined }) }] : []),
    ...validStatuses.map((status) => ({
      label: `Status: ${titleCase(status)}`,
      href: filterHref({
        status: validStatuses.filter((s) => s !== status).join(',') || undefined,
      }),
    })),
    ...(industryName
      ? [{ label: `Industry: ${industryName}`, href: filterHref({ industryId: undefined }) }]
      : []),
    ...(leadSourceName
      ? [{ label: `Source: ${leadSourceName}`, href: filterHref({ leadSourceId: undefined }) }]
      : []),
    ...(countryCode
      ? [{ label: `Country: ${countryCode}`, href: filterHref({ countryCode: undefined }) }]
      : []),
    ...(assigneeName
      ? [{ label: `Assigned: ${assigneeName}`, href: filterHref({ assignedToId: undefined }) }]
      : []),
    ...(createdFrom || createdTo
      ? [
          {
            label: `Created: ${createdFrom ?? '…'} – ${createdTo ?? '…'}`,
            href: filterHref({ createdFrom: undefined, createdTo: undefined }),
          },
        ]
      : []),
    ...(updatedFrom || updatedTo
      ? [
          {
            label: `Updated: ${updatedFrom ?? '…'} – ${updatedTo ?? '…'}`,
            href: filterHref({ updatedFrom: undefined, updatedTo: undefined }),
          },
        ]
      : []),
    ...(lastActivityFrom || lastActivityTo
      ? [
          {
            label: `Last activity: ${lastActivityFrom ?? '…'} – ${lastActivityTo ?? '…'}`,
            href: filterHref({ lastActivityFrom: undefined, lastActivityTo: undefined }),
          },
        ]
      : []),
  ]

  const columns: readonly TableColumn<LeadRow>[] = [
    {
      key: 'company',
      header: 'Company',
      render: (row) => row.companyName,
      renderSecondary: (row) => row.industry?.name ?? null,
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'location',
      header: 'Location',
      render: (row) => [row.location, row.countryCode].filter(Boolean).join(', ') || '—',
    },
    ...(canSeeAllLeads
      ? [
          {
            key: 'assignedTo',
            header: 'Assigned to',
            render: (row: LeadRow) =>
              row.assignedTo
                ? `${row.assignedTo.firstName} ${row.assignedTo.lastName}`
                : 'Unassigned',
          },
        ]
      : []),
    {
      key: 'lastActivity',
      header: 'Last activity',
      render: (row) => formatDate(row.lastActivityAt),
    },
    { key: 'created', header: 'Created', render: (row) => formatDate(row.createdAt) },
  ]

  const returnTo = filterHref({})
  const addHref = `${returnTo}${returnTo.includes('?') ? '&' : '?'}add=1`

  return (
    <HrAdminListPage
      eyebrow="CRM"
      title="All leads"
      description="Every lead you can see — search, filter and sort, or open one for the full picture."
      crumbs={[{ label: 'All leads' }]}
      root={{ label: 'CRM', href: '/crm' }}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `${BASE}/${row.id}`}
      hrefFor={pageHrefBuilder(BASE, currentParams)}
      filtered={hasFilter([
        search,
        validStatuses.length > 0,
        industryId,
        leadSourceId,
        countryCode,
        assignedToId,
        createdFrom,
        createdTo,
        updatedFrom,
        updatedTo,
        lastActivityFrom,
        lastActivityTo,
      ])}
      emptyIcon="handshake"
      emptyTitle="No leads yet"
      emptyDescription="Add the first lead to get started."
      toolbar={
        <>
          <Notice
            code={params.notice}
            notices={
              params.notice && params.reason
                ? { ...NOTICES, [params.notice]: { tone: 'warning', message: params.reason } }
                : NOTICES
            }
          />

          <form
            method="get"
            action={BASE}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)' }}>
              <Field label="Search" htmlFor="search" style={{ flex: '2 1 220px' }}>
                <Input
                  id="search"
                  name="search"
                  type="search"
                  autoComplete="off"
                  defaultValue={search ?? ''}
                  placeholder="Company, contact, GSTIN"
                  iconLeft="search"
                />
              </Field>
              <Field
                label="Industry"
                htmlFor="industryId"
                style={{ flex: '1 1 170px', maxWidth: 220 }}
              >
                <Select
                  id="industryId"
                  name="industryId"
                  defaultValue={industryId ?? ''}
                  placeholder="All industries"
                  options={industryOptions}
                />
              </Field>
              <Field
                label="Lead source"
                htmlFor="leadSourceId"
                style={{ flex: '1 1 170px', maxWidth: 220 }}
              >
                <Select
                  id="leadSourceId"
                  name="leadSourceId"
                  defaultValue={leadSourceId ?? ''}
                  placeholder="All sources"
                  options={leadSourceOptions}
                />
              </Field>
              <Field
                label="Country"
                htmlFor="countryCode"
                style={{ flex: '1 1 140px', maxWidth: 170 }}
              >
                <Input
                  id="countryCode"
                  name="countryCode"
                  type="text"
                  maxLength={2}
                  placeholder="IN"
                  defaultValue={countryCode ?? ''}
                />
              </Field>
              {canSeeAllLeads ? (
                <Field
                  label="Assigned to"
                  htmlFor="assignedToId"
                  style={{ flex: '1 1 200px', maxWidth: 240 }}
                >
                  <Select
                    id="assignedToId"
                    name="assignedToId"
                    defaultValue={assignedToId ?? ''}
                    placeholder="Anyone"
                    options={[{ value: 'unassigned', label: 'Unassigned' }, ...assignableEmployees]}
                  />
                </Field>
              ) : null}
              <Field label="Sort by" htmlFor="sort" style={{ flex: '1 1 150px', maxWidth: 190 }}>
                <Select
                  id="sort"
                  name="sort"
                  defaultValue={params.sort ?? ''}
                  options={[{ value: '', label: 'Default' }, ...SORT_OPTIONS]}
                />
              </Field>
              <Field label="Order" htmlFor="order" style={{ flex: '1 1 130px', maxWidth: 150 }}>
                <Select
                  id="order"
                  name="order"
                  defaultValue={params.order ?? 'desc'}
                  options={[
                    { value: 'desc', label: 'Descending' },
                    { value: 'asc', label: 'Ascending' },
                  ]}
                />
              </Field>
            </div>

            <Field label="Status" htmlFor="status-search">
              <MultiSelect
                id="status-search"
                name="status"
                options={STATUS_OPTIONS}
                defaultValue={validStatuses}
                placeholder="Search statuses…"
              />
            </Field>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)' }}>
              <Field label="Created from" htmlFor="createdFrom" style={{ flex: '1 1 150px' }}>
                <Input
                  id="createdFrom"
                  name="createdFrom"
                  type="date"
                  defaultValue={createdFrom ?? ''}
                />
              </Field>
              <Field label="Created to" htmlFor="createdTo" style={{ flex: '1 1 150px' }}>
                <Input id="createdTo" name="createdTo" type="date" defaultValue={createdTo ?? ''} />
              </Field>
              <Field label="Updated from" htmlFor="updatedFrom" style={{ flex: '1 1 150px' }}>
                <Input
                  id="updatedFrom"
                  name="updatedFrom"
                  type="date"
                  defaultValue={updatedFrom ?? ''}
                />
              </Field>
              <Field label="Updated to" htmlFor="updatedTo" style={{ flex: '1 1 150px' }}>
                <Input id="updatedTo" name="updatedTo" type="date" defaultValue={updatedTo ?? ''} />
              </Field>
              <Field
                label="Last activity from"
                htmlFor="lastActivityFrom"
                style={{ flex: '1 1 150px' }}
              >
                <Input
                  id="lastActivityFrom"
                  name="lastActivityFrom"
                  type="date"
                  defaultValue={lastActivityFrom ?? ''}
                />
              </Field>
              <Field
                label="Last activity to"
                htmlFor="lastActivityTo"
                style={{ flex: '1 1 150px' }}
              >
                <Input
                  id="lastActivityTo"
                  name="lastActivityTo"
                  type="date"
                  defaultValue={lastActivityTo ?? ''}
                />
              </Field>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                flexWrap: 'wrap',
              }}
            >
              <SubmitButton variant="primary" iconLeft="filter" pendingLabel="Applying…">
                Apply filters
              </SubmitButton>
              {chips.length > 0 ? (
                <Button href={BASE} type="button" variant="ghost">
                  Clear all
                </Button>
              ) : null}
              {hasCrmCapability(crmRole, 'create_leads') ? (
                <Button
                  href={addHref}
                  variant="secondary"
                  iconLeft="plus"
                  style={{ marginLeft: 'auto' }}
                >
                  New lead
                </Button>
              ) : null}
            </div>
          </form>

          {chips.length > 0 ? (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexWrap: 'wrap',
                gap: 'var(--space-2)',
              }}
            >
              {chips.map((chip) => (
                <li key={chip.label}>
                  <a
                    href={chip.href}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                      height: 28,
                      padding: '0 var(--space-2) 0 var(--space-3)',
                      borderRadius: 'var(--radius-full)',
                      background: 'var(--surface-sunken)',
                      border: '1px solid var(--border-default)',
                      fontSize: 'var(--type-body-sm-size)',
                      color: 'var(--text-primary)',
                      textDecoration: 'none',
                    }}
                  >
                    {chip.label}
                    <Icon name="x" size={14} style={{ color: 'var(--text-secondary)' }} />
                  </a>
                </li>
              ))}
            </ul>
          ) : null}

          <Modal open={params.add === '1'} closedHref={returnTo} title="New lead">
            <TrackedForm
              action={createLead}
              style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
            >
              <Field label="Company name" htmlFor="companyName" required>
                <Input id="companyName" name="companyName" required maxLength={160} />
              </Field>
              <Field label="Company size" htmlFor="companySize" hint="e.g. 11–50 employees">
                <Input id="companySize" name="companySize" maxLength={40} />
              </Field>
              <Field label="Website" htmlFor="website">
                <Input
                  id="website"
                  name="website"
                  type="url"
                  placeholder="https://"
                  maxLength={255}
                />
              </Field>
              <Field label="Industry" htmlFor="createIndustryId">
                <Select
                  id="createIndustryId"
                  name="industryId"
                  placeholder="Select industry"
                  options={industryOptions}
                />
              </Field>
              <Field label="Lead source" htmlFor="createLeadSourceId">
                <Select
                  id="createLeadSourceId"
                  name="leadSourceId"
                  placeholder="Select source"
                  options={leadSourceOptions}
                />
              </Field>
              <Field label="Country" htmlFor="createCountryCode">
                <CountrySelect id="createCountryCode" name="countryCode" />
              </Field>
              <Field label="Location" htmlFor="location" hint="City or region">
                <Input id="location" name="location" maxLength={160} />
              </Field>
              <Field label="Registered organisation name" htmlFor="registeredOrgName">
                <Input id="registeredOrgName" name="registeredOrgName" maxLength={200} />
              </Field>
              <Field label="GSTIN" htmlFor="gstin">
                <Input id="gstin" name="gstin" maxLength={15} placeholder="22AAAAA0000A1Z5" />
              </Field>
              <Field label="Registered address" htmlFor="registeredAddress">
                <Textarea
                  id="registeredAddress"
                  name="registeredAddress"
                  rows={2}
                  maxLength={1000}
                />
              </Field>
              {canAssign ? (
                <Field
                  label="Assign to"
                  htmlFor="assignedToId"
                  hint="Leave unassigned for now if unsure."
                >
                  <Select
                    id="assignedToId"
                    name="assignedToId"
                    placeholder="Unassigned"
                    options={assignableEmployees}
                  />
                </Field>
              ) : null}
              <SubmitButton variant="primary" fullWidth pendingLabel="Adding…">
                Add lead
              </SubmitButton>
            </TrackedForm>
          </Modal>
        </>
      }
    />
  )
}
