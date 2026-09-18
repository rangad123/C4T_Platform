import type { Metadata } from 'next'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { currentFinancialYear, isValidFinancialYear } from '@/lib/hrms/financial-year'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { HrFinancialYearPicker } from '@/components/hrms/HrFinancialYearPicker'
import { HrTaxBreakdown, type HrTaxCalculation } from '@/components/hrms/HrTaxBreakdown'
import { Panel } from '@/components/admin/Panel'
import { EmptyState } from '@/components/ds/admin/EmptyState'

export const metadata: Metadata = { title: 'Tax calculation' }

export default async function HrEmployeeTaxPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string }>
}) {
  const params = await searchParams
  const financialYear =
    params.fy && isValidFinancialYear(params.fy) ? params.fy : currentFinancialYear()

  let calculation: HrTaxCalculation | null = null
  let missingSlab = false
  try {
    calculation = await serverFetch<HrTaxCalculation>('hrms/me/tax', { query: { financialYear } })
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      missingSlab = true
    } else {
      throw error
    }
  }

  return (
    <HrPageShell
      crumbs={[{ label: 'Tax calculation' }]}
      root={{ label: 'Employee', href: '/employee' }}
      eyebrow="Tax calculation"
      title="Tax calculation"
      subtitle="How your tax for the year is worked out."
    >
      <HrFinancialYearPicker action="/employee/tax" financialYear={financialYear} />

      <Panel
        title="Tax calculation"
        description={
          calculation
            ? `${calculation.regime === 'NEW' ? 'New' : 'Old'} regime, computed from your salary, investments and TDS on file.`
            : undefined
        }
      >
        {missingSlab ? (
          <EmptyState
            icon="line-chart"
            title="No tax slab configured"
            description={`Tax slabs for ${financialYear} haven't been set up yet. Contact HR.`}
          />
        ) : !calculation ? (
          <EmptyState icon="line-chart" title="Nothing to calculate yet" />
        ) : (
          <HrTaxBreakdown calculation={calculation} financialYear={financialYear} />
        )}
      </Panel>
    </HrPageShell>
  )
}
