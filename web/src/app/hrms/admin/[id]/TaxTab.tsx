import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { HrFinancialYearPicker } from '@/components/hrms/HrFinancialYearPicker'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { EmptyState } from '@/components/ds/admin/EmptyState'

interface TaxCalculation {
  financialYear: string
  regime: 'OLD' | 'NEW'
  hasSalaryStructure: boolean
  grossSalary: number
  standardDeduction: number
  incomeFromSalary: number
  chapterVIADeductions: number
  totalTaxableIncome: number
  taxOnTotalIncome: number
  rebate87A: number
  taxAfterRebate: number
  cess: number
  totalTaxLiability: number
  tdsDeductedTillDate: number
  taxPayableOrRefundable: number
}

function money(value: number): string {
  const rounded = Math.round(value)
  return rounded < 0
    ? `−₹${Math.abs(rounded).toLocaleString('en-IN')}`
    : `₹${rounded.toLocaleString('en-IN')}`
}

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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            {!calculation.hasSalaryStructure ? (
              <p
                style={{
                  margin: 0,
                  color: 'var(--text-muted)',
                  fontSize: 'var(--type-body-sm-size)',
                }}
              >
                No salary structure is on file for {financialYear} — this calculation assumes zero
                pay.
              </p>
            ) : null}
            <DescriptionList
              items={[
                { label: 'Gross salary', value: money(calculation.grossSalary) },
                { label: 'Standard deduction', value: money(calculation.standardDeduction) },
                { label: 'Income from salary', value: money(calculation.incomeFromSalary) },
                {
                  label: 'Chapter VI-A deductions',
                  value:
                    calculation.regime === 'OLD'
                      ? money(calculation.chapterVIADeductions)
                      : 'Not applicable (new regime)',
                },
                { label: 'Total taxable income', value: money(calculation.totalTaxableIncome) },
              ]}
            />
            <DescriptionList
              items={[
                { label: 'Tax on total income', value: money(calculation.taxOnTotalIncome) },
                { label: 'Rebate under §87A', value: money(calculation.rebate87A) },
                { label: 'Tax after rebate', value: money(calculation.taxAfterRebate) },
                { label: 'Health & education cess', value: money(calculation.cess) },
                { label: 'Total tax liability', value: money(calculation.totalTaxLiability) },
              ]}
            />
            <DescriptionList
              items={[
                { label: 'TDS deducted till date', value: money(calculation.tdsDeductedTillDate) },
                {
                  label: calculation.taxPayableOrRefundable >= 0 ? 'Tax payable' : 'Tax refundable',
                  value: money(Math.abs(calculation.taxPayableOrRefundable)),
                },
              ]}
            />
          </div>
        )}
      </Panel>
    </>
  )
}
