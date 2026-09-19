import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import type { CSSProperties } from 'react'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { requireHrRole } from '@/lib/hrms/hr-session'
import { loadDesignationOptions, loadManagerOptions, withStoredOption } from '@/lib/hrms/hr-catalog'
import { currentFinancialYear, isValidFinancialYear } from '@/lib/hrms/financial-year'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { Modal } from '@/components/admin/Modal'
import { Panel } from '@/components/admin/Panel'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { HrAvatar } from '@/components/hrms/HrAvatar'
import { Button } from '@/components/ds/core/Button'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Checkbox } from '@/components/ds/forms/Checkbox'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { SingleFileUpload } from '@/components/admin/SingleFileUpload'
import { HrRevealFinancialDetails } from '@/components/hrms/HrRevealFinancialDetails'
import { SalaryTab } from './SalaryTab'
import { TaxTab } from './TaxTab'
import { InvestmentsTab } from './InvestmentsTab'
import { PayslipTab } from './PayslipTab'
import { LeavesTab } from './LeavesTab'
import { TimesheetTab } from './TimesheetTab'
import { DocumentsTab } from './DocumentsTab'
import {
  updatePersonalDetails,
  updateEmploymentDetails,
  updateFinancialDetails,
  changeEmployeeStatus,
  attachProfilePicture,
  sendEmployeeInvitation,
} from './actions'

const BASE = '/admin'

const SECTIONS = [
  { value: 'basic', label: 'Basic details', icon: 'user-check' },
  { value: 'salary', label: 'Salary details', icon: 'banknote' },
  { value: 'tax', label: 'Tax calculation', icon: 'line-chart' },
  { value: 'investments', label: 'Investments', icon: 'landmark' },
  { value: 'payslip', label: 'Payslip', icon: 'credit-card' },
  { value: 'timesheet', label: 'Timesheet', icon: 'clock' },
  { value: 'leaves', label: 'Leaves', icon: 'plane' },
  { value: 'documents', label: 'Documents', icon: 'file-text' },
] as const

const NOTICES: Record<string, NoticeCopy> = {
  invited: {
    tone: 'success',
    message:
      'Invitation sent. The link lets them choose their own password and expires in 7 days — send another if it lapses.',
  },
  invite_refused: { tone: 'warning', message: 'Invitation not sent.' },
  refused: { tone: 'warning', message: 'That could not be done.' },
}

const GENDERS = [
  { value: 'MALE', label: 'Male' },
  { value: 'FEMALE', label: 'Female' },
  { value: 'OTHER', label: 'Other' },
]
const ROLES = [
  { value: 'EMPLOYEE', label: 'Employee' },
  { value: 'ACCOUNT_MANAGER', label: 'Account manager' },
  { value: 'ADMIN', label: 'HR administrator' },
]
const ACCOUNT_TYPES = [
  { value: 'Full-time', label: 'Full-time' },
  { value: 'Contract', label: 'Contract' },
  { value: 'Intern', label: 'Intern' },
]
const TAX_REGIMES = [
  { value: 'NEW', label: 'New regime' },
  { value: 'OLD', label: 'Old regime' },
]
const STATUSES = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'RESIGNED', label: 'Resigned' },
  { value: 'TERMINATED', label: 'Terminated' },
]

const FORM_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-5)',
}

interface EmployeeDetail {
  id: string
  employeeCode: string
  firstName: string
  lastName: string
  email: string
  role: 'ADMIN' | 'ACCOUNT_MANAGER' | 'EMPLOYEE'
  status: 'ACTIVE' | 'RESIGNED' | 'TERMINATED'
  phone: string | null
  joiningDate: string
  profilePictureFileId: string | null
  designation: { id: string; name: string } | null
  dateOfBirth: string | null
  gender: 'MALE' | 'FEMALE' | 'OTHER' | null
  address: string | null
  accountType: string | null
  relievingDate: string | null
  timesheetRequired: boolean
  taxRegime: 'NEW' | 'OLD'
  bankName: string | null
  branchName: string | null
  reportsTo: { id: string; firstName: string; lastName: string; employeeCode: string } | null
  financialDetails: {
    hasPan: boolean
    hasBankDetails: boolean
    panMasked: string | null
    accountNumberMasked: string | null
  }
}

function toDateInputValue(iso: string | null): string | undefined {
  return iso ? iso.slice(0, 10) : undefined
}

async function loadEmployee(id: string): Promise<EmployeeDetail> {
  try {
    return await serverFetch<EmployeeDetail>(`hrms/employees/${id}`)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound()
    throw error
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const employee = await loadEmployee(id)
  return { title: `${employee.firstName} ${employee.lastName}` }
}

export default async function HrAdminEmployeeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{
    section?: string
    edit?: string
    error?: string
    notice?: string
    reason?: string
    fy?: string
    verify?: string
    month?: string
    docKind?: string
    docError?: string
  }>
}) {
  await requireHrRole(['ADMIN'])
  const { id } = await params
  const sp = await searchParams
  const section = resolveSection(SECTIONS, sp.section)
  const financialYear = sp.fy && isValidFinancialYear(sp.fy) ? sp.fy : currentFinancialYear()
  const month =
    sp.month && Number(sp.month) >= 1 && Number(sp.month) <= 12
      ? Number(sp.month)
      : new Date().getMonth() + 1

  const employee = await loadEmployee(id)
  // Timesheet is only offered for employees expected to keep one — the same
  // rule the employee's own portal applies to its sidebar.
  const visibleSections = employee.timesheetRequired
    ? SECTIONS
    : SECTIONS.filter((s) => s.value !== 'timesheet')

  const [designations, managers] = await Promise.all([
    loadDesignationOptions(),
    loadManagerOptions(),
  ])
  const designationOptions = withStoredOption(
    designations,
    employee.designation
      ? { value: employee.designation.id, label: employee.designation.name }
      : null,
  )
  const managerOptions = withStoredOption(
    managers,
    employee.reportsTo
      ? {
          value: employee.reportsTo.id,
          label: `${employee.reportsTo.firstName} ${employee.reportsTo.lastName} (${employee.reportsTo.employeeCode})`,
        }
      : null,
  )

  const displayName = `${employee.firstName} ${employee.lastName}`
  const detailPath = `${BASE}/${id}`
  const sectionQuery = section === SECTIONS[0].value ? '' : `?section=${section}`
  const closedHref = `${detailPath}${sectionQuery}`

  return (
    <HrPageShell
      crumbs={[{ label: 'Employees', href: BASE }, { label: displayName }]}
      root={{ label: 'Admin', href: BASE }}
      eyebrow="Employees"
      title={displayName}
      subtitle={`${employee.employeeCode} · ${employee.email}`}
      badges={<StatusBadge status={employee.status} />}
      tabs={<SectionTabs basePath={detailPath} tabs={visibleSections} active={section} />}
    >
      {/* A `reason` carries the API's own sentence, which says more than any
          code-to-copy mapping here could. When one is present it replaces the
          generic text for whichever code came with it. */}
      <Notice
        code={sp.notice}
        notices={
          sp.notice && sp.reason
            ? { ...NOTICES, [sp.notice]: { tone: 'warning', message: sp.reason } }
            : NOTICES
        }
      />

      {sp.error === 'rejected' ? (
        <div
          role="alert"
          style={{
            padding: 'var(--space-4) var(--space-5)',
            background: 'var(--status-error-bg)',
            color: 'var(--status-error-fg)',
            borderRadius: 'var(--radius-input)',
            fontSize: 'var(--type-body-sm-size)',
          }}
        >
          Some of the details entered were rejected. Check the values and try again.
        </div>
      ) : null}

      {section === 'basic' ? (
        <>
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <Button
              href={`${detailPath}?edit=status`}
              variant="secondary"
              size="sm"
              iconLeft="user-check"
            >
              Change status
            </Button>
            {/* Offered for anyone still here, not only the newly added: the
                same link is what rescues a lapsed invitation or an address
                that was wrong the first time. */}
            {employee.status === 'ACTIVE' ? (
              <form action={sendEmployeeInvitation.bind(null, id)}>
                <SubmitButton variant="secondary" size="sm" iconLeft="mail" pendingLabel="Sending…">
                  Send sign-in invitation
                </SubmitButton>
              </form>
            ) : null}
          </div>

          <Panel
            title="Personal information"
            actions={
              <Button href={`${detailPath}?edit=personal`} variant="secondary" size="sm">
                Edit
              </Button>
            }
          >
            <div
              style={{
                display: 'flex',
                gap: 'var(--space-5)',
                alignItems: 'center',
                marginBottom: 'var(--space-6)',
              }}
            >
              <HrAvatar name={displayName} fileId={employee.profilePictureFileId} size="lg" />
              <SingleFileUpload
                endpoint="/admin/upload"
                scope="profile-picture"
                accept="image/png,image/jpeg,image/webp"
                label={employee.profilePictureFileId ? 'Replace photo' : 'Upload photo'}
                onUploaded={attachProfilePicture.bind(null, id)}
              />
            </div>
            <DescriptionList
              items={[
                { label: 'First name', value: employee.firstName },
                { label: 'Last name', value: employee.lastName },
                {
                  label: 'Date of birth',
                  value: employee.dateOfBirth
                    ? new Date(employee.dateOfBirth).toLocaleDateString()
                    : null,
                },
                { label: 'Gender', value: employee.gender },
                { label: 'Phone', value: employee.phone },
                { label: 'Address', value: employee.address, wide: true },
              ]}
            />
          </Panel>

          <Panel
            title="Employment information"
            actions={
              <Button href={`${detailPath}?edit=employment`} variant="secondary" size="sm">
                Edit
              </Button>
            }
          >
            <DescriptionList
              items={[
                { label: 'Employee code', value: employee.employeeCode },
                { label: 'Designation', value: employee.designation?.name },
                { label: 'Role', value: <StatusBadge status={employee.role} /> },
                { label: 'Employment type', value: employee.accountType },
                {
                  label: 'Account manager',
                  value: employee.reportsTo
                    ? `${employee.reportsTo.firstName} ${employee.reportsTo.lastName}`
                    : null,
                },
                {
                  label: 'Joining date',
                  value: new Date(employee.joiningDate).toLocaleDateString(),
                },
                {
                  label: 'Relieving date',
                  value: employee.relievingDate
                    ? new Date(employee.relievingDate).toLocaleDateString()
                    : null,
                },
                { label: 'Timesheet required', value: employee.timesheetRequired ? 'Yes' : 'No' },
              ]}
            />
          </Panel>

          <Panel
            title="Financial information"
            actions={
              <Button href={`${detailPath}?edit=financial`} variant="secondary" size="sm">
                Edit
              </Button>
            }
          >
            <DescriptionList
              items={[
                {
                  label: 'Tax regime',
                  value: employee.taxRegime === 'NEW' ? 'New regime' : 'Old regime',
                },
                { label: 'PAN', value: employee.financialDetails.panMasked ?? '—' },
                { label: 'Bank name', value: employee.bankName },
                { label: 'Branch name', value: employee.branchName },
                {
                  label: 'Account number',
                  value: employee.financialDetails.accountNumberMasked ?? '—',
                },
              ]}
            />
            {employee.financialDetails.hasPan || employee.financialDetails.hasBankDetails ? (
              <div style={{ marginTop: 'var(--space-5)' }}>
                <HrRevealFinancialDetails employeeId={employee.id} />
              </div>
            ) : null}
          </Panel>
        </>
      ) : section === 'salary' ? (
        <SalaryTab
          employeeId={employee.id}
          detailPath={detailPath}
          financialYear={financialYear}
          editing={sp.edit}
        />
      ) : section === 'tax' ? (
        <TaxTab employeeId={employee.id} detailPath={detailPath} financialYear={financialYear} />
      ) : section === 'investments' ? (
        <InvestmentsTab
          employeeId={employee.id}
          detailPath={detailPath}
          financialYear={financialYear}
          verifying={sp.verify}
        />
      ) : section === 'payslip' ? (
        <PayslipTab
          employeeId={employee.id}
          detailPath={detailPath}
          financialYear={financialYear}
        />
      ) : section === 'timesheet' ? (
        <TimesheetTab
          employeeId={employee.id}
          detailPath={detailPath}
          financialYear={financialYear}
          month={month}
        />
      ) : section === 'leaves' ? (
        <LeavesTab employeeId={employee.id} detailPath={detailPath} financialYear={financialYear} />
      ) : section === 'documents' ? (
        <DocumentsTab
          employeeId={employee.id}
          detailPath={detailPath}
          kind={sp.docKind}
          error={sp.docError}
        />
      ) : (
        <EmptyState
          icon={SECTIONS.find((s) => s.value === section)?.icon}
          title="Coming soon"
          description="This section will be built out in a later phase."
        />
      )}

      <Modal
        open={sp.edit === 'personal'}
        closedHref={closedHref}
        title="Edit personal information"
      >
        <TrackedForm action={updatePersonalDetails.bind(null, id)} style={FORM_STYLE}>
          <Field label="First name" htmlFor="firstName" required>
            <Input
              id="firstName"
              name="firstName"
              required
              maxLength={80}
              defaultValue={employee.firstName}
            />
          </Field>
          <Field
            label="Email"
            htmlFor="email"
            required
            hint="This is what the employee signs in with."
          >
            <Input
              id="email"
              name="email"
              type="email"
              required
              maxLength={255}
              defaultValue={employee.email}
            />
          </Field>
          <Field label="Last name" htmlFor="lastName" required>
            <Input
              id="lastName"
              name="lastName"
              required
              maxLength={80}
              defaultValue={employee.lastName}
            />
          </Field>
          <Field label="Date of birth" htmlFor="dateOfBirth">
            <Input
              id="dateOfBirth"
              name="dateOfBirth"
              type="date"
              defaultValue={toDateInputValue(employee.dateOfBirth)}
            />
          </Field>
          <Field label="Gender" htmlFor="gender">
            <Select
              id="gender"
              name="gender"
              options={GENDERS}
              placeholder="Select gender"
              defaultValue={employee.gender ?? ''}
            />
          </Field>
          <Field label="Phone" htmlFor="phone">
            <Input id="phone" name="phone" type="tel" defaultValue={employee.phone ?? ''} />
          </Field>
          <Field label="Address" htmlFor="address">
            <Input
              id="address"
              name="address"
              maxLength={500}
              defaultValue={employee.address ?? ''}
            />
          </Field>
          <SubmitButton variant="primary" fullWidth pendingLabel="Saving…">
            Save
          </SubmitButton>
        </TrackedForm>
      </Modal>

      <Modal
        open={sp.edit === 'employment'}
        closedHref={closedHref}
        title="Edit employment information"
      >
        <TrackedForm action={updateEmploymentDetails.bind(null, id)} style={FORM_STYLE}>
          <Field label="Designation" htmlFor="designationId">
            <Select
              id="designationId"
              name="designationId"
              options={designationOptions}
              placeholder="Select designation"
              defaultValue={employee.designation?.id ?? ''}
            />
          </Field>
          <Field label="Role" htmlFor="role" required>
            <Select id="role" name="role" options={ROLES} defaultValue={employee.role} />
          </Field>
          <Field label="Employment type" htmlFor="accountType">
            <Select
              id="accountType"
              name="accountType"
              options={ACCOUNT_TYPES}
              placeholder="Select type"
              defaultValue={employee.accountType ?? ''}
            />
          </Field>
          <Field label="Account manager" htmlFor="reportsToId">
            <Select
              id="reportsToId"
              name="reportsToId"
              options={managerOptions}
              placeholder="Select manager"
              defaultValue={employee.reportsTo?.id ?? ''}
            />
          </Field>
          <Field label="Joining date" htmlFor="joiningDate" required>
            <Input
              id="joiningDate"
              name="joiningDate"
              type="date"
              required
              defaultValue={toDateInputValue(employee.joiningDate)}
            />
          </Field>
          <Checkbox
            id="timesheetRequired"
            name="timesheetRequired"
            label="Timesheet required"
            defaultChecked={employee.timesheetRequired}
          />
          <SubmitButton variant="primary" fullWidth pendingLabel="Saving…">
            Save
          </SubmitButton>
        </TrackedForm>
      </Modal>

      <Modal
        open={sp.edit === 'financial'}
        closedHref={closedHref}
        title="Edit financial information"
      >
        <TrackedForm action={updateFinancialDetails.bind(null, id)} style={FORM_STYLE}>
          <Field label="Tax regime" htmlFor="taxRegime" required>
            <Select
              id="taxRegime"
              name="taxRegime"
              options={TAX_REGIMES}
              defaultValue={employee.taxRegime}
            />
          </Field>
          <Field
            label="PAN number"
            htmlFor="panNumber"
            hint="Leave blank to keep the existing value."
          >
            <Input
              id="panNumber"
              name="panNumber"
              maxLength={10}
              style={{ textTransform: 'uppercase' }}
            />
          </Field>
          <Field label="Bank name" htmlFor="bankName">
            <Input
              id="bankName"
              name="bankName"
              maxLength={120}
              defaultValue={employee.bankName ?? ''}
            />
          </Field>
          <Field label="Branch name" htmlFor="branchName">
            <Input
              id="branchName"
              name="branchName"
              maxLength={120}
              defaultValue={employee.branchName ?? ''}
            />
          </Field>
          <Field
            label="Account holder name"
            htmlFor="accountName"
            hint="Leave blank to keep the existing value."
          >
            <Input id="accountName" name="accountName" maxLength={120} />
          </Field>
          <Field
            label="Account number"
            htmlFor="accountNumber"
            hint="Leave blank to keep the existing value."
          >
            <Input id="accountNumber" name="accountNumber" maxLength={34} />
          </Field>
          <Field
            label="IFSC code"
            htmlFor="ifscCode"
            hint="Leave blank to keep the existing value."
          >
            <Input
              id="ifscCode"
              name="ifscCode"
              maxLength={11}
              style={{ textTransform: 'uppercase' }}
            />
          </Field>
          <SubmitButton variant="primary" fullWidth pendingLabel="Saving…">
            Save
          </SubmitButton>
        </TrackedForm>
      </Modal>

      <Modal
        open={sp.edit === 'status'}
        closedHref={closedHref}
        title="Change employment status"
        closeOnBackdropClick={false}
      >
        <TrackedForm action={changeEmployeeStatus.bind(null, id)} style={FORM_STYLE}>
          <Field label="Status" htmlFor="status" required>
            <Select id="status" name="status" options={STATUSES} defaultValue={employee.status} />
          </Field>
          <Field
            label="Relieving date"
            htmlFor="relievingDate"
            hint="Used when moving to resigned or terminated."
          >
            <Input
              id="relievingDate"
              name="relievingDate"
              type="date"
              defaultValue={toDateInputValue(employee.relievingDate)}
            />
          </Field>
          <SubmitButton variant="primary" fullWidth pendingLabel="Saving…">
            Save status
          </SubmitButton>
        </TrackedForm>
      </Modal>
    </HrPageShell>
  )
}
