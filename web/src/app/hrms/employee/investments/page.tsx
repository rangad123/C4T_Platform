import type { Metadata } from 'next'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { EmptyState } from '@/components/ds/admin/EmptyState'

export const metadata: Metadata = { title: 'Investments' }

export default function HrEmployeeInvestmentsPage() {
  return (
    <HrPageShell
      crumbs={[{ label: 'Investments' }]}
      root={{ label: 'Employee', href: '/employee' }}
      eyebrow="Investments"
      title="Investments"
      subtitle="Monthly tax deductions and section-wise investment declarations."
    >
      <EmptyState
        icon="landmark"
        title="No investment declarations yet"
        description="Declare your investments for this financial year."
      />
    </HrPageShell>
  )
}
