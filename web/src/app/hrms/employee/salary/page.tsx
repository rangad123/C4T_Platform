import type { Metadata } from 'next'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { EmptyState } from '@/components/ds/admin/EmptyState'

export const metadata: Metadata = { title: 'Salary details' }

export default function HrEmployeeSalaryPage() {
  return (
    <HrPageShell
      crumbs={[{ label: 'Salary details' }]}
      root={{ label: 'Employee', href: '/employee' }}
      eyebrow="Salary details"
      title="Salary details"
      subtitle="Fixed and variable components, old salaries and monthly incentives."
    >
      <EmptyState
        icon="banknote"
        title="No salary structure on file"
        description="Your salary components will appear here once HR sets them up."
      />
    </HrPageShell>
  )
}
