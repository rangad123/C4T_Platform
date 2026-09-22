import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { requireCrmAccess } from '@/lib/hrms/hr-session'
import { hasCrmCapability, crmCapabilityScope } from '@/lib/hrms/hr-crm-capabilities'
import {
  loadCrmIndustryOptions,
  loadCrmLeadSourceOptions,
  loadCrmAssignableEmployeeOptions,
} from '@/lib/hrms/hr-catalog'
import { titleCase, formatDate, formatDateTime } from '@/lib/admin/format'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { Modal } from '@/components/admin/Modal'
import { Panel } from '@/components/admin/Panel'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Icon } from '@/components/ds/core/Icon'
import { Button } from '@/components/ds/core/Button'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { CountrySelect } from '@/components/ds/forms/CountrySelect'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import {
  updateLead,
  changeLeadStatus,
  assignLead,
  archiveLead,
  addLeadNote,
  addLeadContact,
  updateLeadContact,
  removeLeadContact,
} from './actions'

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

const SECTIONS = [
  { value: 'basic', label: 'Basic details', icon: 'building-2' },
  { value: 'contacts', label: 'Contacts', icon: 'users' },
  { value: 'activity', label: 'Activity', icon: 'clock' },
] as const

const NOTICES: Record<string, NoticeCopy> = {
  refused: { tone: 'warning', message: 'That could not be done.' },
}

interface EmployeeSummary {
  id: string
  firstName: string
  lastName: string
  employeeCode: string
}

interface Contact {
  id: string
  name: string
  designation: string | null
  phone: string | null
  email: string | null
  profileUrl: string | null
}

interface Activity {
  id: string
  kind: 'NOTE' | 'STATUS_CHANGED' | 'ASSIGNED' | 'CREATED'
  body: string | null
  meta: { from?: string | null; to?: string | null } | null
  createdAt: string
  employee: EmployeeSummary
}

interface LeadDetail {
  id: string
  companyName: string
  companySize: string | null
  website: string | null
  status: (typeof CRM_LEAD_STATUSES)[number]
  countryCode: string | null
  location: string | null
  registeredOrgName: string | null
  registeredAddress: string | null
  gstin: string | null
  industry: { id: string; name: string } | null
  leadSource: { id: string; name: string } | null
  assignedTo: EmployeeSummary | null
  createdBy: EmployeeSummary
  createdAt: string
  updatedAt: string
  lastActivityAt: string | null
  contacts: readonly Contact[]
  activity: readonly Activity[]
}

async function loadLead(id: string): Promise<LeadDetail> {
  try {
    return await serverFetch<LeadDetail>(`hrms/crm/leads/${id}`)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound()
    throw error
  }
}

function activityDescription(activity: Activity): string {
  switch (activity.kind) {
    case 'CREATED':
      return `${activity.employee.firstName} ${activity.employee.lastName} created this lead`
    case 'STATUS_CHANGED':
      return `${activity.employee.firstName} ${activity.employee.lastName} changed the status from ${activity.meta?.from ? titleCase(activity.meta.from) : '—'} to ${activity.meta?.to ? titleCase(activity.meta.to) : '—'}`
    case 'ASSIGNED':
      return `${activity.employee.firstName} ${activity.employee.lastName} ${activity.meta?.to ? 're-assigned this lead' : 'unassigned this lead'}`
    case 'NOTE':
      return `${activity.employee.firstName} ${activity.employee.lastName} added a note`
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const lead = await loadLead(id)
  return { title: lead.companyName }
}

export default async function HrCrmLeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{
    section?: string
    edit?: string
    editContact?: string
    addContact?: string
    error?: string
    notice?: string
    reason?: string
  }>
}) {
  const employee = await requireCrmAccess()
  const crmRole = employee.crmRole!
  const { id } = await params
  const sp = await searchParams
  const section = resolveSection(SECTIONS, sp.section)

  const lead = await loadLead(id)

  const canEdit = hasCrmCapability(crmRole, 'edit_leads')
  const canChangeStatus = hasCrmCapability(crmRole, 'change_status')
  const canAssign = hasCrmCapability(crmRole, 'assign_leads')
  const canArchive = hasCrmCapability(crmRole, 'delete_leads')
  const canManageContacts = hasCrmCapability(crmRole, 'manage_contacts')
  const canAddActivity = hasCrmCapability(crmRole, 'add_activity')
  const canSeeAllLeads = crmCapabilityScope(crmRole, 'view_leads') === 'all'

  const [industryOptions, leadSourceOptions, assignableEmployees] = await Promise.all([
    canEdit ? loadCrmIndustryOptions() : Promise.resolve([]),
    canEdit ? loadCrmLeadSourceOptions() : Promise.resolve([]),
    canAssign ? loadCrmAssignableEmployeeOptions() : Promise.resolve([]),
  ])

  const detailPath = `${BASE}/${id}`
  const sectionQuery = section === SECTIONS[0].value ? '' : `?section=${section}`
  const closedHref = `${detailPath}${sectionQuery}`
  const editingContact = lead.contacts.find((c) => c.id === sp.editContact)

  return (
    <HrPageShell
      crumbs={[{ label: 'All leads', href: BASE }, { label: lead.companyName }]}
      root={{ label: 'CRM', href: '/crm' }}
      eyebrow="CRM"
      title={lead.companyName}
      subtitle={lead.industry?.name ?? undefined}
      badges={<StatusBadge status={lead.status} />}
      tabs={<SectionTabs basePath={detailPath} tabs={[...SECTIONS]} active={section} />}
    >
      <Notice
        code={sp.notice}
        notices={
          sp.notice && sp.reason
            ? { ...NOTICES, [sp.notice]: { tone: 'warning', message: sp.reason } }
            : NOTICES
        }
      />
      {sp.error === 'rejected' ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: 'var(--space-4) var(--space-5)',
            borderRadius: 'var(--radius-input)',
            background: 'var(--status-error-bg)',
            color: 'var(--status-error-fg)',
            fontSize: 'var(--type-body-sm-size)',
          }}
        >
          That could not be saved. Check the values and try again.
        </p>
      ) : null}

      {section === 'basic' ? (
        <>
          <Panel
            title="Company details"
            actions={
              canEdit ? (
                <Button href={`${detailPath}?edit=basic`} variant="secondary" size="sm">
                  Edit
                </Button>
              ) : null
            }
          >
            <DescriptionList
              items={[
                { label: 'Company name', value: lead.companyName },
                { label: 'Company size', value: lead.companySize },
                {
                  label: 'Website',
                  value: lead.website ? (
                    <a href={lead.website} target="_blank" rel="noreferrer">
                      {lead.website}
                    </a>
                  ) : null,
                },
                { label: 'Industry', value: lead.industry?.name },
                { label: 'Lead source', value: lead.leadSource?.name },
                { label: 'Country', value: lead.countryCode },
                { label: 'Location', value: lead.location },
                { label: 'Registered organisation name', value: lead.registeredOrgName },
                { label: 'GSTIN', value: lead.gstin },
                { label: 'Registered address', value: lead.registeredAddress, wide: true },
                {
                  label: 'Created by',
                  value: `${lead.createdBy.firstName} ${lead.createdBy.lastName}`,
                },
                { label: 'Created', value: formatDate(lead.createdAt) },
                { label: 'Last updated', value: formatDate(lead.updatedAt) },
                { label: 'Last activity', value: formatDate(lead.lastActivityAt) },
              ]}
            />
          </Panel>

          {canChangeStatus ? (
            <Panel title="Status">
              <form
                action={changeLeadStatus.bind(null, id)}
                style={{
                  display: 'flex',
                  gap: 'var(--space-3)',
                  alignItems: 'flex-end',
                  flexWrap: 'wrap',
                }}
              >
                <Field label="Status" htmlFor="status" style={{ minWidth: 200 }}>
                  <Select
                    id="status"
                    name="status"
                    defaultValue={lead.status}
                    options={STATUS_OPTIONS}
                  />
                </Field>
                <SubmitButton variant="secondary" pendingLabel="Saving…">
                  Update status
                </SubmitButton>
              </form>
            </Panel>
          ) : null}

          {canAssign ? (
            <Panel title="Assignment">
              <form
                action={assignLead.bind(null, id)}
                style={{
                  display: 'flex',
                  gap: 'var(--space-3)',
                  alignItems: 'flex-end',
                  flexWrap: 'wrap',
                }}
              >
                <Field label="Assigned to" htmlFor="assignedToId" style={{ minWidth: 220 }}>
                  <Select
                    id="assignedToId"
                    name="assignedToId"
                    placeholder="Unassigned"
                    defaultValue={lead.assignedTo?.id ?? ''}
                    options={assignableEmployees}
                  />
                </Field>
                <SubmitButton variant="secondary" pendingLabel="Saving…">
                  Update assignment
                </SubmitButton>
              </form>
            </Panel>
          ) : !canSeeAllLeads ? null : (
            <Panel title="Assignment">
              <DescriptionList
                items={[
                  {
                    label: 'Assigned to',
                    value: lead.assignedTo
                      ? `${lead.assignedTo.firstName} ${lead.assignedTo.lastName}`
                      : 'Unassigned',
                  },
                ]}
              />
            </Panel>
          )}

          {canArchive ? (
            <Panel
              title="Archive"
              description="Removes this lead from the list. It stays on record but can no longer be edited from here."
            >
              <form action={archiveLead.bind(null, id)}>
                <SubmitButton variant="secondary" iconLeft="archive" pendingLabel="Archiving…">
                  Archive lead
                </SubmitButton>
              </form>
            </Panel>
          ) : null}

          <Modal open={sp.edit === 'basic'} closedHref={closedHref} title="Edit company details">
            <TrackedForm
              action={updateLead.bind(null, id)}
              style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
            >
              <Field label="Company name" htmlFor="companyName" required>
                <Input
                  id="companyName"
                  name="companyName"
                  required
                  maxLength={160}
                  defaultValue={lead.companyName}
                />
              </Field>
              <Field label="Company size" htmlFor="companySize">
                <Input
                  id="companySize"
                  name="companySize"
                  maxLength={40}
                  defaultValue={lead.companySize ?? ''}
                />
              </Field>
              <Field label="Website" htmlFor="website">
                <Input
                  id="website"
                  name="website"
                  type="url"
                  maxLength={255}
                  defaultValue={lead.website ?? ''}
                />
              </Field>
              <Field label="Industry" htmlFor="industryId">
                <Select
                  id="industryId"
                  name="industryId"
                  placeholder="Select industry"
                  defaultValue={lead.industry?.id ?? ''}
                  options={industryOptions}
                />
              </Field>
              <Field label="Lead source" htmlFor="leadSourceId">
                <Select
                  id="leadSourceId"
                  name="leadSourceId"
                  placeholder="Select source"
                  defaultValue={lead.leadSource?.id ?? ''}
                  options={leadSourceOptions}
                />
              </Field>
              <Field label="Country" htmlFor="countryCode">
                <CountrySelect
                  id="countryCode"
                  name="countryCode"
                  defaultValue={lead.countryCode}
                />
              </Field>
              <Field label="Location" htmlFor="location">
                <Input
                  id="location"
                  name="location"
                  maxLength={160}
                  defaultValue={lead.location ?? ''}
                />
              </Field>
              <Field label="Registered organisation name" htmlFor="registeredOrgName">
                <Input
                  id="registeredOrgName"
                  name="registeredOrgName"
                  maxLength={200}
                  defaultValue={lead.registeredOrgName ?? ''}
                />
              </Field>
              <Field label="GSTIN" htmlFor="gstin">
                <Input id="gstin" name="gstin" maxLength={15} defaultValue={lead.gstin ?? ''} />
              </Field>
              <Field label="Registered address" htmlFor="registeredAddress">
                <Textarea
                  id="registeredAddress"
                  name="registeredAddress"
                  rows={2}
                  maxLength={1000}
                  defaultValue={lead.registeredAddress ?? ''}
                />
              </Field>
              <SubmitButton variant="primary" fullWidth pendingLabel="Saving…">
                Save
              </SubmitButton>
            </TrackedForm>
          </Modal>
        </>
      ) : section === 'contacts' ? (
        <Panel
          title="Contacts"
          actions={
            canManageContacts ? (
              <Button
                href={`${detailPath}?section=contacts&addContact=1`}
                variant="secondary"
                size="sm"
              >
                Add contact
              </Button>
            ) : null
          }
        >
          {lead.contacts.length === 0 ? (
            <EmptyState icon="users" title="No contacts yet" />
          ) : (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-4)',
              }}
            >
              {lead.contacts.map((contact) => (
                <li
                  key={contact.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 'var(--space-4)',
                    padding: 'var(--space-4) var(--space-5)',
                    border: '1px solid var(--border-default)',
                    borderRadius: 'var(--radius-card)',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontWeight: 'var(--fw-semibold)' }}>{contact.name}</span>
                    {contact.designation ? (
                      <span
                        style={{
                          color: 'var(--text-secondary)',
                          fontSize: 'var(--type-body-sm-size)',
                        }}
                      >
                        {contact.designation}
                      </span>
                    ) : null}
                    {contact.email ? (
                      <a
                        href={`mailto:${contact.email}`}
                        style={{ fontSize: 'var(--type-body-sm-size)' }}
                      >
                        {contact.email}
                      </a>
                    ) : null}
                    {contact.phone ? (
                      <a
                        href={`tel:${contact.phone}`}
                        style={{ fontSize: 'var(--type-body-sm-size)' }}
                      >
                        {contact.phone}
                      </a>
                    ) : null}
                    {contact.profileUrl ? (
                      <a
                        href={contact.profileUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 'var(--type-body-sm-size)' }}
                      >
                        {contact.profileUrl}
                      </a>
                    ) : null}
                  </div>
                  {canManageContacts ? (
                    <div style={{ display: 'flex', gap: 'var(--space-2)', flex: 'none' }}>
                      <Button
                        href={`${detailPath}?section=contacts&editContact=${contact.id}`}
                        variant="secondary"
                        size="sm"
                      >
                        Edit
                      </Button>
                      <form action={removeLeadContact.bind(null, id, contact.id)}>
                        <SubmitButton
                          variant="ghost"
                          size="sm"
                          iconLeft="trash-2"
                          pendingLabel="Removing…"
                        >
                          Remove
                        </SubmitButton>
                      </form>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <Modal open={sp.addContact === '1'} closedHref={closedHref} title="Add contact">
            <TrackedForm
              action={addLeadContact.bind(null, id)}
              style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
            >
              <Field label="Name" htmlFor="contactName" required>
                <Input id="contactName" name="name" required maxLength={120} />
              </Field>
              <Field label="Designation" htmlFor="contactDesignation">
                <Input id="contactDesignation" name="designation" maxLength={120} />
              </Field>
              <Field label="Phone" htmlFor="contactPhone">
                <Input id="contactPhone" name="phone" type="tel" maxLength={24} />
              </Field>
              <Field label="Email" htmlFor="contactEmail">
                <Input id="contactEmail" name="email" type="email" maxLength={255} />
              </Field>
              <Field label="Profile URL" htmlFor="contactProfileUrl" hint="e.g. their LinkedIn">
                <Input id="contactProfileUrl" name="profileUrl" type="url" maxLength={255} />
              </Field>
              <SubmitButton variant="primary" fullWidth pendingLabel="Adding…">
                Add contact
              </SubmitButton>
            </TrackedForm>
          </Modal>

          <Modal open={Boolean(editingContact)} closedHref={closedHref} title="Edit contact">
            {editingContact ? (
              <TrackedForm
                action={updateLeadContact.bind(null, id, editingContact.id)}
                style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
              >
                <Field label="Name" htmlFor="editContactName" required>
                  <Input
                    id="editContactName"
                    name="name"
                    required
                    maxLength={120}
                    defaultValue={editingContact.name}
                  />
                </Field>
                <Field label="Designation" htmlFor="editContactDesignation">
                  <Input
                    id="editContactDesignation"
                    name="designation"
                    maxLength={120}
                    defaultValue={editingContact.designation ?? ''}
                  />
                </Field>
                <Field label="Phone" htmlFor="editContactPhone">
                  <Input
                    id="editContactPhone"
                    name="phone"
                    type="tel"
                    maxLength={24}
                    defaultValue={editingContact.phone ?? ''}
                  />
                </Field>
                <Field label="Email" htmlFor="editContactEmail">
                  <Input
                    id="editContactEmail"
                    name="email"
                    type="email"
                    maxLength={255}
                    defaultValue={editingContact.email ?? ''}
                  />
                </Field>
                <Field label="Profile URL" htmlFor="editContactProfileUrl">
                  <Input
                    id="editContactProfileUrl"
                    name="profileUrl"
                    type="url"
                    maxLength={255}
                    defaultValue={editingContact.profileUrl ?? ''}
                  />
                </Field>
                <SubmitButton variant="primary" fullWidth pendingLabel="Saving…">
                  Save
                </SubmitButton>
              </TrackedForm>
            ) : null}
          </Modal>
        </Panel>
      ) : (
        <Panel title="Activity">
          {canAddActivity ? (
            <form
              action={addLeadNote.bind(null, id)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-3)',
                marginBottom: 'var(--space-6)',
              }}
            >
              <Field label="Add a note" htmlFor="noteBody">
                <Textarea id="noteBody" name="body" rows={3} maxLength={4000} required />
              </Field>
              <SubmitButton
                variant="primary"
                iconLeft="plus"
                pendingLabel="Adding…"
                style={{ alignSelf: 'flex-start' }}
              >
                Add note
              </SubmitButton>
            </form>
          ) : null}

          {lead.activity.length === 0 ? (
            <EmptyState icon="clock" title="No activity yet" />
          ) : (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-4)',
              }}
            >
              {lead.activity.map((activity) => (
                <li
                  key={activity.id}
                  style={{
                    display: 'flex',
                    gap: 'var(--space-4)',
                    padding: 'var(--space-4) var(--space-5)',
                    border: '1px solid var(--border-default)',
                    borderRadius: 'var(--radius-card)',
                  }}
                >
                  <Icon
                    name={
                      activity.kind === 'NOTE'
                        ? 'message-square'
                        : activity.kind === 'STATUS_CHANGED'
                          ? 'refresh-cw'
                          : activity.kind === 'ASSIGNED'
                            ? 'user-check'
                            : 'plus'
                    }
                    size={18}
                    style={{ flex: 'none', color: 'var(--text-secondary)', marginTop: 2 }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                    <span style={{ fontSize: 'var(--type-body-sm-size)' }}>
                      {activityDescription(activity)}
                    </span>
                    {activity.body ? <p style={{ margin: 0 }}>{activity.body}</p> : null}
                    <span
                      style={{ fontSize: 'var(--type-caption-size)', color: 'var(--text-muted)' }}
                    >
                      {formatDateTime(activity.createdAt)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </HrPageShell>
  )
}
