import type { Metadata } from 'next'
import { requireHrEmployee } from '@/lib/hrms/hr-session'
import { serverFetchOrNull } from '@/lib/api/server'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Modal } from '@/components/admin/Modal'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { HrAvatar } from '@/components/hrms/HrAvatar'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { updateMyFinancialDetails, updateMyPersonalDetails } from './actions'

export const metadata: Metadata = { title: 'Basic details' }

const BASE = '/employee'

/** What GET /v1/hrms/me returns beyond the session's own fields. */
interface HrSelfDetail {
  employeeCode: string
  firstName: string
  lastName: string
  email: string
  phone: string | null
  address: string | null
  dateOfBirth: string | null
  gender: 'MALE' | 'FEMALE' | 'OTHER' | null
  joiningDate: string
  relievingDate: string | null
  accountType: string | null
  taxRegime: 'OLD' | 'NEW'
  status: string
  designation: { name: string } | null
  reportsTo: { firstName: string; lastName: string } | null
  bankName: string | null
  branchName: string | null
  financialDetails: {
    hasPan: boolean
    hasBankDetails: boolean
    panMasked: string | null
    accountNumberMasked: string | null
  }
}

function date(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : '—'
}

const GENDERS: Record<string, string> = { MALE: 'Male', FEMALE: 'Female', OTHER: 'Other' }
const GENDER_OPTIONS = Object.entries(GENDERS).map(([value, label]) => ({ value, label }))

const NOTICES: Record<string, NoticeCopy> = {
  saved: { tone: 'success', message: 'Your details have been saved.' },
}

const FORM_ERRORS: Record<string, string> = {
  incorrect: 'Your password is incorrect.',
  rejected:
    'Some details were not accepted. Check the phone number, PAN (like ABCDE1234F) and IFSC code (like HDFC0001234).',
}

const FORM_STYLE = { display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' } as const

function FormError({ code }: { code: string | undefined }) {
  if (!code) return null
  return (
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
      {FORM_ERRORS[code] ?? 'Could not save your details.'}
    </p>
  )
}

/**
 * The employee's home, and where a new starter lands after choosing their
 * password. HR adds them from four details; everything else about them is
 * filled in here, by them, so this page leads with what is still missing.
 *
 * What they can change is personal details and PAN and bank details. Name and
 * email are HR's (the email is the sign-in identity), and everything under
 * Employment is HR's to set.
 */
export default async function HrEmployeeBasicDetailsPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; notice?: string; error?: string }>
}) {
  const session = await requireHrEmployee()
  const params = await searchParams
  const detail = await serverFetchOrNull<HrSelfDetail>('hrms/me/profile')

  const displayName =
    `${detail?.firstName ?? session.firstName} ${detail?.lastName ?? session.lastName}`.trim()

  const missing: string[] = []
  if (detail) {
    if (!detail.dateOfBirth) missing.push('date of birth')
    if (!detail.gender) missing.push('gender')
    if (!detail.phone) missing.push('phone number')
    if (!detail.address) missing.push('address')
    if (!detail.financialDetails.hasPan) missing.push('PAN')
    if (!detail.financialDetails.hasBankDetails) missing.push('bank account')
  }
  const personalMissing = Boolean(
    detail && (!detail.dateOfBirth || !detail.gender || !detail.phone || !detail.address),
  )
  const financialMissing = Boolean(
    detail && (!detail.financialDetails.hasPan || !detail.financialDetails.hasBankDetails),
  )

  return (
    <HrPageShell
      crumbs={[{ label: 'Basic details' }]}
      root={{ label: 'Employee', href: BASE }}
      eyebrow="Basic details"
      title="Basic details"
      subtitle="Your personal, employment and financial information."
    >
      <Notice code={params.notice} notices={NOTICES} />

      {missing.length > 0 ? (
        <Panel title="Complete your details" description={`Still to add: ${missing.join(', ')}.`}>
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            {personalMissing ? (
              <Button href={`${BASE}?edit=personal`} variant="primary" iconLeft="user-check">
                Add personal details
              </Button>
            ) : null}
            {financialMissing ? (
              <Button
                href={`${BASE}?edit=financial`}
                variant={personalMissing ? 'secondary' : 'primary'}
                iconLeft="landmark"
              >
                Add PAN and bank details
              </Button>
            ) : null}
          </div>
        </Panel>
      ) : null}

      <Panel
        title="Personal"
        description="Your name and email are set by HR."
        actions={
          <Button href={`${BASE}?edit=personal`} variant="secondary" size="sm">
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
          <HrAvatar name={displayName} fileId={session.profilePictureFileId} size="lg" />
        </div>
        <DescriptionList
          items={[
            { label: 'Name', value: displayName },
            { label: 'Employee code', value: detail?.employeeCode ?? session.employeeCode },
            { label: 'Email', value: detail?.email ?? session.email },
            { label: 'Phone', value: detail?.phone ?? '—' },
            { label: 'Date of birth', value: date(detail?.dateOfBirth ?? null) },
            { label: 'Gender', value: detail?.gender ? (GENDERS[detail.gender] ?? '—') : '—' },
            { label: 'Address', value: detail?.address ?? '—' },
          ]}
        />
      </Panel>

      <Panel title="Employment">
        <DescriptionList
          items={[
            { label: 'Designation', value: detail?.designation?.name ?? '—' },
            { label: 'Role', value: <StatusBadge status={session.role} /> },
            { label: 'Status', value: <StatusBadge status={detail?.status ?? session.status} /> },
            { label: 'Employment type', value: detail?.accountType ?? '—' },
            {
              label: 'Reporting to',
              value: detail?.reportsTo
                ? `${detail.reportsTo.firstName} ${detail.reportsTo.lastName}`.trim()
                : '—',
            },
            { label: 'Joining date', value: date(detail?.joiningDate ?? null) },
            ...(detail?.relievingDate
              ? [{ label: 'Relieving date', value: date(detail.relievingDate) }]
              : []),
            { label: 'Tax regime', value: detail?.taxRegime === 'OLD' ? 'Old' : 'New' },
          ]}
        />
      </Panel>

      <Panel
        title="Financial"
        description="Shown masked. Saving changes here needs your password."
        actions={
          <Button href={`${BASE}?edit=financial`} variant="secondary" size="sm">
            Edit
          </Button>
        }
      >
        <DescriptionList
          items={[
            { label: 'PAN', value: detail?.financialDetails.panMasked ?? '—' },
            { label: 'Bank', value: detail?.bankName ?? '—' },
            { label: 'Branch', value: detail?.branchName ?? '—' },
            { label: 'Account number', value: detail?.financialDetails.accountNumberMasked ?? '—' },
          ]}
        />
      </Panel>

      <Modal open={params.edit === 'personal'} closedHref={BASE} title="Your personal details">
        <TrackedForm action={updateMyPersonalDetails} style={FORM_STYLE}>
          <FormError code={params.edit === 'personal' ? params.error : undefined} />
          <Field label="Phone" htmlFor="myPhone">
            <Input id="myPhone" name="phone" type="tel" defaultValue={detail?.phone ?? ''} />
          </Field>
          <Field label="Date of birth" htmlFor="myDateOfBirth">
            <Input
              id="myDateOfBirth"
              name="dateOfBirth"
              type="date"
              defaultValue={detail?.dateOfBirth ? detail.dateOfBirth.slice(0, 10) : undefined}
            />
          </Field>
          <Field label="Gender" htmlFor="myGender">
            <Select
              id="myGender"
              name="gender"
              options={GENDER_OPTIONS}
              placeholder="Select gender"
              defaultValue={detail?.gender ?? ''}
            />
          </Field>
          <Field label="Address" htmlFor="myAddress">
            <Input
              id="myAddress"
              name="address"
              maxLength={500}
              defaultValue={detail?.address ?? ''}
            />
          </Field>
          <SubmitButton variant="primary" fullWidth pendingLabel="Saving…">
            Save
          </SubmitButton>
        </TrackedForm>
      </Modal>

      <Modal open={params.edit === 'financial'} closedHref={BASE} title="Your PAN and bank details">
        <TrackedForm action={updateMyFinancialDetails} style={FORM_STYLE}>
          <FormError code={params.edit === 'financial' ? params.error : undefined} />
          <Field
            label="Your password"
            htmlFor="myPassword"
            required
            hint="Needed to save PAN and bank details."
          >
            <Input
              id="myPassword"
              name="currentPassword"
              type="password"
              required
              autoComplete="current-password"
              showPasswordToggle
            />
          </Field>
          <Field
            label="PAN number"
            htmlFor="myPan"
            hint={
              detail?.financialDetails.hasPan
                ? 'Leave blank to keep the existing value.'
                : 'For example ABCDE1234F.'
            }
          >
            <Input
              id="myPan"
              name="panNumber"
              maxLength={10}
              style={{ textTransform: 'uppercase' }}
            />
          </Field>
          <Field label="Bank name" htmlFor="myBankName">
            <Input
              id="myBankName"
              name="bankName"
              maxLength={120}
              defaultValue={detail?.bankName ?? ''}
            />
          </Field>
          <Field label="Branch name" htmlFor="myBranchName">
            <Input
              id="myBranchName"
              name="branchName"
              maxLength={120}
              defaultValue={detail?.branchName ?? ''}
            />
          </Field>
          <Field
            label="Account holder name"
            htmlFor="myAccountName"
            hint={
              detail?.financialDetails.hasBankDetails
                ? 'Leave blank to keep the existing value.'
                : undefined
            }
          >
            <Input id="myAccountName" name="accountName" maxLength={120} />
          </Field>
          <Field
            label="Account number"
            htmlFor="myAccountNumber"
            hint={
              detail?.financialDetails.hasBankDetails
                ? 'Leave blank to keep the existing value.'
                : undefined
            }
          >
            <Input id="myAccountNumber" name="accountNumber" maxLength={34} inputMode="numeric" />
          </Field>
          <Field
            label="IFSC code"
            htmlFor="myIfsc"
            hint={
              detail?.financialDetails.hasBankDetails
                ? 'Leave blank to keep the existing value.'
                : 'For example HDFC0001234.'
            }
          >
            <Input
              id="myIfsc"
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
    </HrPageShell>
  )
}
