import type { Metadata } from 'next'
import { requireHrRole } from '@/lib/hrms/hr-session'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { HrProfileContent } from '@/components/hrms/HrProfileContent'

export const metadata: Metadata = { title: 'Your profile' }

export default async function HrAdminProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>
}) {
  const employee = await requireHrRole(['ADMIN'])
  const params = await searchParams

  return (
    <HrPageShell
      crumbs={[{ label: 'Your profile' }]}
      root={{ label: 'Admin', href: '/admin' }}
      eyebrow="Account"
      title="Your profile"
    >
      <HrProfileContent
        employee={employee}
        returnPath="/admin/profile"
        notice={params.notice}
        error={params.error}
      />
    </HrPageShell>
  )
}
