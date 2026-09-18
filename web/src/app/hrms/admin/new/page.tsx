import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { ApiError } from '@/lib/api/types'
import { requireHrRole } from '@/lib/hrms/hr-session'
import { hrActionFetch } from '@/lib/hrms/hr-action-fetch'
import { loadDesignationOptions, loadManagerOptions } from '@/lib/hrms/hr-catalog'
import { formTrimmed, formString } from '@/lib/form-data'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { Panel } from '@/components/admin/Panel'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Checkbox } from '@/components/ds/forms/Checkbox'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Button } from '@/components/ds/core/Button'
import { Icon } from '@/components/ds/core/Icon'

export const metadata: Metadata = { title: 'Add employee' }

const BASE = '/admin'

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

const ERROR_MESSAGES: Record<string, string> = {
  email_taken: 'An employee with this email already exists.',
  rejected:
    'Some of the details entered were rejected. Check the highlighted fields and try again.',
  missing: 'Fill in every required field.',
}

async function createEmployee(formData: FormData): Promise<void> {
  'use server'
  await requireHrRole(['ADMIN'])

  const firstName = formTrimmed(formData, 'firstName')
  const lastName = formTrimmed(formData, 'lastName')
  const email = formTrimmed(formData, 'email')
  const password = formString(formData, 'password')
  const joiningDate = formString(formData, 'joiningDate')
  if (!firstName || !lastName || !email || !password || !joiningDate) {
    redirect(`${BASE}/new?error=missing`)
  }

  const body: Record<string, unknown> = {
    firstName,
    lastName,
    email,
    password,
    joiningDate,
    role: formString(formData, 'role') || undefined,
    designationId: formString(formData, 'designationId') || undefined,
    accountType: formString(formData, 'accountType') || undefined,
    reportsToId: formString(formData, 'reportsToId') || undefined,
    dateOfBirth: formString(formData, 'dateOfBirth') || undefined,
    gender: formString(formData, 'gender') || undefined,
    phone: formTrimmed(formData, 'phone') || undefined,
    address: formTrimmed(formData, 'address') || undefined,
    timesheetRequired: formData.get('timesheetRequired') != null,
    taxRegime: formString(formData, 'taxRegime') || undefined,
    panNumber: formTrimmed(formData, 'panNumber') || undefined,
    accountNumber: formTrimmed(formData, 'accountNumber') || undefined,
    accountName: formTrimmed(formData, 'accountName') || undefined,
    ifscCode: formTrimmed(formData, 'ifscCode') || undefined,
    bankName: formTrimmed(formData, 'bankName') || undefined,
    branchName: formTrimmed(formData, 'branchName') || undefined,
  }

  let id: string
  try {
    const created = await hrActionFetch<{ id: string }>('hrms/employees', { method: 'POST', body })
    id = created.id
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) redirect(`${BASE}/new?error=email_taken`)
    if (error instanceof ApiError && error.status === 422) redirect(`${BASE}/new?error=rejected`)
    throw error
  }

  revalidatePath(BASE)
  redirect(`${BASE}/${id}`)
}

export default async function HrAdminNewEmployeePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  await requireHrRole(['ADMIN'])
  const params = await searchParams
  const message = params.error
    ? (ERROR_MESSAGES[params.error] ?? 'Could not add this employee.')
    : null

  const [designations, managers] = await Promise.all([
    loadDesignationOptions(),
    loadManagerOptions(),
  ])

  return (
    <HrPageShell
      crumbs={[{ label: 'Employees', href: BASE }, { label: 'Add employee' }]}
      root={{ label: 'Admin', href: BASE }}
      eyebrow="Employees"
      title="Add employee"
    >
      {message ? (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--space-3)',
            padding: 'var(--space-4) var(--space-5)',
            background: 'var(--status-error-bg)',
            color: 'var(--status-error-fg)',
            borderRadius: 'var(--radius-input)',
            fontSize: 'var(--type-body-sm-size)',
          }}
        >
          <Icon name="alert-triangle" size={18} style={{ flex: 'none', marginTop: 2 }} />
          <span>{message}</span>
        </div>
      ) : null}

      <TrackedForm
        action={createEmployee}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}
      >
        <Panel title="Personal information">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 'var(--space-5)',
            }}
          >
            <Field label="First name" htmlFor="firstName" required>
              <Input id="firstName" name="firstName" required maxLength={80} />
            </Field>
            <Field label="Last name" htmlFor="lastName" required>
              <Input id="lastName" name="lastName" required maxLength={80} />
            </Field>
            <Field label="Email" htmlFor="email" required>
              <Input id="email" name="email" type="email" required maxLength={255} />
            </Field>
            <Field
              label="Temporary password"
              htmlFor="password"
              required
              hint="At least 12 characters."
            >
              <Input
                id="password"
                name="password"
                type="password"
                required
                minLength={12}
                showPasswordToggle
              />
            </Field>
            <Field label="Date of birth" htmlFor="dateOfBirth">
              <Input id="dateOfBirth" name="dateOfBirth" type="date" />
            </Field>
            <Field label="Gender" htmlFor="gender">
              <Select id="gender" name="gender" options={GENDERS} placeholder="Select gender" />
            </Field>
            <Field label="Phone" htmlFor="phone">
              <Input id="phone" name="phone" type="tel" placeholder="+91 98765 43210" />
            </Field>
            <Field label="Address" htmlFor="address">
              <Input id="address" name="address" maxLength={500} />
            </Field>
          </div>
        </Panel>

        <Panel title="Employment information">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 'var(--space-5)',
            }}
          >
            <Field label="Designation" htmlFor="designationId">
              <Select
                id="designationId"
                name="designationId"
                options={designations}
                placeholder="Select designation"
              />
            </Field>
            <Field label="Role" htmlFor="role" required>
              <Select id="role" name="role" options={ROLES} defaultValue="EMPLOYEE" />
            </Field>
            <Field label="Employment type" htmlFor="accountType">
              <Select
                id="accountType"
                name="accountType"
                options={ACCOUNT_TYPES}
                placeholder="Select type"
              />
            </Field>
            <Field label="Account manager" htmlFor="reportsToId">
              <Select
                id="reportsToId"
                name="reportsToId"
                options={managers}
                placeholder="Select manager"
              />
            </Field>
            <Field label="Joining date" htmlFor="joiningDate" required>
              <Input id="joiningDate" name="joiningDate" type="date" required />
            </Field>
          </div>
          <div style={{ marginTop: 'var(--space-5)' }}>
            <Checkbox
              id="timesheetRequired"
              name="timesheetRequired"
              label="Timesheet required"
              defaultChecked
            />
          </div>
        </Panel>

        <Panel
          title="Financial information"
          description="Encrypted at rest. Leave blank if not yet available — these can be added later."
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 'var(--space-5)',
            }}
          >
            <Field label="Tax regime" htmlFor="taxRegime" required>
              <Select id="taxRegime" name="taxRegime" options={TAX_REGIMES} defaultValue="NEW" />
            </Field>
            <Field label="PAN number" htmlFor="panNumber" hint="e.g. ABCDE1234F">
              <Input
                id="panNumber"
                name="panNumber"
                maxLength={10}
                style={{ textTransform: 'uppercase' }}
              />
            </Field>
            <Field label="Bank name" htmlFor="bankName">
              <Input id="bankName" name="bankName" maxLength={120} />
            </Field>
            <Field label="Branch name" htmlFor="branchName">
              <Input id="branchName" name="branchName" maxLength={120} />
            </Field>
            <Field label="Account holder name" htmlFor="accountName">
              <Input id="accountName" name="accountName" maxLength={120} />
            </Field>
            <Field label="Account number" htmlFor="accountNumber">
              <Input id="accountNumber" name="accountNumber" maxLength={34} />
            </Field>
            <Field label="IFSC code" htmlFor="ifscCode" hint="e.g. HDFC0001234">
              <Input
                id="ifscCode"
                name="ifscCode"
                maxLength={11}
                style={{ textTransform: 'uppercase' }}
              />
            </Field>
          </div>
        </Panel>

        <div style={{ display: 'flex', gap: 'var(--space-4)' }}>
          <SubmitButton variant="primary" pendingLabel="Adding employee…">
            Add employee
          </SubmitButton>
          <Button href={BASE} variant="secondary">
            Cancel
          </Button>
        </div>
      </TrackedForm>
    </HrPageShell>
  )
}
