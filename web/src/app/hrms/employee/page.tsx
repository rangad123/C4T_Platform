import type { Metadata } from 'next'
import { requireHrEmployee } from '@/lib/hrms/hr-session'
import { serverFetchOrNull } from '@/lib/api/server'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { HrAvatar } from '@/components/hrms/HrAvatar'

export const metadata: Metadata = { title: 'Basic details' }

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

export default async function HrEmployeeBasicDetailsPage() {
  const session = await requireHrEmployee()
  const detail = await serverFetchOrNull<HrSelfDetail>('hrms/me/profile')

  const displayName =
    `${detail?.firstName ?? session.firstName} ${detail?.lastName ?? session.lastName}`.trim()

  return (
    <HrPageShell
      crumbs={[{ label: 'Basic details' }]}
      root={{ label: 'Employee', href: '/employee' }}
      eyebrow="Basic details"
      title="Basic details"
      subtitle="Your personal, employment and financial information."
    >
      <Panel title="Personal">
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
        description="Shown masked. Contact HR to correct any of these details."
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
    </HrPageShell>
  )
}
