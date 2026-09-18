import type { Metadata } from 'next'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { EmptyState } from '@/components/ds/admin/EmptyState'

export const metadata: Metadata = { title: 'Tax calculation' }

/** Phase 2 fills this with the real tax engine's line-by-line breakdown. */
export default function HrEmployeeTaxPage() {
  return (
    <HrPageShell
      crumbs={[{ label: 'Tax calculation' }]}
      root={{ label: 'Employee', href: '/employee' }}
      eyebrow="Tax calculation"
      title="Tax calculation"
      subtitle="Computed from your salary structure and investment declarations for the selected financial year."
    >
      <EmptyState
        icon="line-chart"
        title="Nothing to calculate yet"
        description="A tax breakdown appears once your salary structure is set up."
      />
    </HrPageShell>
  )
}
