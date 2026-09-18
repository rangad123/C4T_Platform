import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { HrFinancialYearPicker } from '@/components/hrms/HrFinancialYearPicker'
import { Panel } from '@/components/admin/Panel'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { HrTaxBreakdown, type HrTaxCalculation } from '@/components/hrms/HrTaxBreakdown'

type TaxCalculation = HrTaxCalculation

export async function TaxTab({
  employeeId,
  detailPath,
  financialYear,
}: {
  employeeId: string
  detailPath: string
  financialYear: string
}) {
  let calculation: TaxCalculation | null = null
  let missingSlab = false
  try {
    calculation = await serverFetch<TaxCalculation>(
      `hrms/employees/${employeeId}/tax-calculation`,
      {
        query: { financialYear },
      },
    )
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      missingSlab = true
    } else {
      throw error
    }
  }
  return (
    <>
      <HrFinancialYearPicker action={detailPath} section="tax" financialYear={financialYear} />

      <Panel
        title="Tax calculation"
        description={
          calculation
            ? `${calculation.regime === 'NEW' ? 'New' : 'Old'} regime, computed from salary, investments and TDS on file.`
            : undefined
        }
      >
        {missingSlab ? (
          <EmptyState
            icon="line-chart"
            title="No tax slab configured"
            description={`An administrator needs to set up tax slabs for ${financialYear} before this can be calculated.`}
          />
        ) : !calculation ? (
          <EmptyState icon="line-chart" title="Nothing to calculate yet" />
        ) : (
          <HrTaxBreakdown calculation={calculation} financialYear={financialYear} />
        )}
      </Panel>
    </>
  )
}
