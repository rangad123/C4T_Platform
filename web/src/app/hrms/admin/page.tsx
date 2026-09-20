import type { Metadata } from 'next'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { searchTerm, hasFilter } from '@/lib/admin/format'
import { HrAdminListPage } from '@/components/hrms/HrAdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { HrAvatar } from '@/components/hrms/HrAvatar'
import { HrEmployeeCards } from '@/components/hrms/HrEmployeeCards'
import { HrViewToggle } from '@/components/hrms/HrViewToggle'
import { resolveListView } from '@/lib/hrms/list-view'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import type { TableColumn } from '@/components/ds/admin/Table'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { Modal } from '@/components/admin/Modal'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { addEmployee } from './actions'

export const metadata: Metadata = { title: 'Employees' }

const BASE = '/admin'

interface EmployeeRow {
  id: string
  employeeCode: string
  firstName: string
  lastName: string
  email: string
  role: 'ADMIN' | 'ACCOUNT_MANAGER' | 'EMPLOYEE'
  status: 'ACTIVE' | 'RESIGNED' | 'TERMINATED'
  phone: string | null
  profilePictureFileId: string | null
  designation: { id: string; name: string } | null
}

const ROLES = ['ADMIN', 'ACCOUNT_MANAGER', 'EMPLOYEE']
const SORT_OPTIONS = [
  { value: 'createdAt', label: 'Newest first' },
  { value: 'firstName', label: 'Name' },
  { value: 'employeeCode', label: 'Employee code' },
  { value: 'joiningDate', label: 'Joining date' },
]

/**
 * The role a new employee is added with. HR administrator is here because the
 * person adding a second administrator has no other way to make one.
 */
const NEW_EMPLOYEE_ROLES = [
  { value: 'EMPLOYEE', label: 'Employee' },
  { value: 'ACCOUNT_MANAGER', label: 'Account manager' },
  { value: 'ADMIN', label: 'HR administrator' },
]

const NOTICES: Record<string, NoticeCopy> = {
  invited: {
    tone: 'success',
    message:
      'Employee added and invited. They will get an email to choose their password, then fill in their own details.',
  },
}

const ADD_ERRORS: Record<string, string> = {
  email_taken: 'An employee with this email already exists.',
  rejected: 'That name or email was not accepted. Check them and try again.',
  missing: 'Enter a first name, last name and email.',
}

export default async function HrAdminEmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string
    role?: string
    search?: string
    sort?: string
    order?: 'asc' | 'desc'
    view?: string
    add?: string
    notice?: string
    error?: string
    firstName?: string
    lastName?: string
    email?: string
    newRole?: string
  }>
}) {
  const params = await searchParams
  const page = parsePage(params.page)
  const role = ROLES.includes(params.role ?? '') ? params.role : undefined
  const search = searchTerm(params.search)
  const view = await resolveListView(params.view)

  const listQuery = { role, search, sort: params.sort, order: params.order, view: params.view }
  const hrefFor = pageHrefBuilder(BASE, listQuery)
  // Where the view toggle sends you back to: this same list, filters, sort and
  // page intact, so switching how it is drawn never also moves you.
  const returnTo = hrefFor(page)

  const result = await loadList<EmployeeRow>('hrms/employees', {
    page,
    limit: 20,
    query: { role, search, sort: params.sort, order: params.order },
  })

  const columns: readonly TableColumn<EmployeeRow>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (row) => (
        <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <HrAvatar
            name={`${row.firstName} ${row.lastName}`}
            fileId={row.profilePictureFileId}
            size="sm"
          />
          {row.firstName} {row.lastName}
        </span>
      ),
      renderSecondary: (row) => row.email,
    },
    { key: 'employeeCode', header: 'Employee code', render: (row) => row.employeeCode },
    {
      key: 'designation',
      header: 'Designation',
      render: (row) => row.designation?.name ?? '—',
    },
    { key: 'role', header: 'Role', render: (row) => <StatusBadge status={row.role} /> },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
  ]

  return (
    <HrAdminListPage
      eyebrow="Employees"
      title="Employees"
      description="Active staff, organised by role and reporting line."
      crumbs={[{ label: 'Employees' }]}
      root={{ label: 'Admin', href: BASE }}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `${BASE}/${row.id}`}
      hrefFor={hrefFor}
      view={view}
      cards={'items' in result ? <HrEmployeeCards rows={result.items} basePath={BASE} /> : null}
      filtered={hasFilter([role, search])}
      emptyIcon="users"
      emptyTitle="No employees yet"
      emptyDescription="Add the first employee to get started."
      toolbar={
        <>
          <Notice code={params.notice} notices={NOTICES} />
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'space-between',
              gap: 'var(--space-4)',
              flexWrap: 'wrap',
            }}
          >
            <ListFilters
              action={BASE}
              search={{ value: search, placeholder: 'Search name, email or employee code' }}
              selects={[
                { name: 'role', label: 'Role', options: ROLES, value: role, allLabel: 'All roles' },
              ]}
              sort={{
                name: 'sort',
                orderName: 'order',
                options: SORT_OPTIONS,
                value: params.sort,
                order: params.order,
              }}
            />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-4)',
                flexWrap: 'wrap',
              }}
            >
              <HrViewToggle active={view} returnTo={returnTo} />
              <Button
                href={`${returnTo}${returnTo.includes('?') ? '&' : '?'}add=1`}
                variant="primary"
                iconLeft="plus"
              >
                Add employee
              </Button>
            </div>
          </div>

          <Modal open={params.add === '1'} closedHref={returnTo} title="Add employee">
            <TrackedForm
              action={addEmployee}
              style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
            >
              {params.error ? (
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
                  {ADD_ERRORS[params.error] ?? 'Could not add this employee.'}
                </p>
              ) : null}
              <p
                style={{
                  margin: 0,
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--type-body-sm-size)',
                }}
              >
                They are emailed an invitation to choose their password, then fill in their own
                details.
              </p>
              <Field label="First name" htmlFor="addFirstName" required>
                <Input
                  id="addFirstName"
                  name="firstName"
                  required
                  maxLength={80}
                  defaultValue={params.firstName ?? ''}
                />
              </Field>
              <Field label="Last name" htmlFor="addLastName" required>
                <Input
                  id="addLastName"
                  name="lastName"
                  required
                  maxLength={80}
                  defaultValue={params.lastName ?? ''}
                />
              </Field>
              <Field
                label="Email"
                htmlFor="addEmail"
                required
                hint="The invitation goes to this address."
              >
                <Input
                  id="addEmail"
                  name="email"
                  type="email"
                  required
                  maxLength={255}
                  defaultValue={params.email ?? ''}
                />
              </Field>
              <Field label="User role" htmlFor="addRole" required>
                <Select
                  id="addRole"
                  name="role"
                  required
                  options={NEW_EMPLOYEE_ROLES}
                  defaultValue={params.newRole ?? 'EMPLOYEE'}
                />
              </Field>
              <SubmitButton variant="primary" fullWidth pendingLabel="Adding…">
                Add employee
              </SubmitButton>
            </TrackedForm>
          </Modal>
        </>
      }
    />
  )
}
