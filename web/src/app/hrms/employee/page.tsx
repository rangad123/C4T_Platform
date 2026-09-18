import type { Metadata } from 'next'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { EmptyState } from '@/components/ds/admin/EmptyState'

export const metadata: Metadata = { title: 'Basic details' }

/** Basic details — Phase 1 fills this with Personal/Employment/Financial tabs. */
export default function HrEmployeeBasicDetailsPage() {
  return (
    <HrPageShell
      crumbs={[{ label: 'Basic details' }]}
      root={{ label: 'Employee', href: '/employee' }}
      eyebrow="Basic details"
      title="Basic details"
      subtitle="Your personal, employment and financial information."
    >
      <EmptyState
        icon="user-check"
        title="Your details haven't been set up yet"
        description="Contact HR if your information looks incomplete."
      />
    </HrPageShell>
  )
}
