import type { Metadata } from 'next'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { EmptyState } from '@/components/ds/admin/EmptyState'

export const metadata: Metadata = { title: 'Payslip' }

export default function HrEmployeePayslipPage() {
  return (
    <HrPageShell
      crumbs={[{ label: 'Payslip' }]}
      root={{ label: 'Employee', href: '/employee' }}
      eyebrow="Payslip"
      title="Payslip"
      subtitle="View and download your payslips."
    >
      <EmptyState
        icon="credit-card"
        title="No payslips available"
        description="Your payslips will appear here once HR generates them."
      />
    </HrPageShell>
  )
}
