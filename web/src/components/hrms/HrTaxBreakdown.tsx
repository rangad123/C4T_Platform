import { DescriptionList } from '@/components/admin/DescriptionList'
import { hrMoney } from './hr-money'

export interface HrTaxCalculation {
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

/**
 * The 20-line tax breakdown, shared by the admin tab and the employee's own
 * view — the two render identical figures, so they read from one component
 * rather than two copies that can drift apart.
 */
export function HrTaxBreakdown({
  calculation,
  financialYear,
}: {
  calculation: HrTaxCalculation
  financialYear: string
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      {!calculation.hasSalaryStructure ? (
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
          No salary structure is on file for {financialYear} — this calculation assumes zero pay.
        </p>
      ) : null}
      <DescriptionList
        items={[
          { label: 'Gross salary', value: hrMoney(calculation.grossSalary) },
          { label: 'Standard deduction', value: hrMoney(calculation.standardDeduction) },
          { label: 'Income from salary', value: hrMoney(calculation.incomeFromSalary) },
          {
            label: 'Chapter VI-A deductions',
            value:
              calculation.regime === 'OLD'
                ? hrMoney(calculation.chapterVIADeductions)
                : 'Not applicable (new regime)',
          },
          { label: 'Total taxable income', value: hrMoney(calculation.totalTaxableIncome) },
        ]}
      />
      <DescriptionList
        items={[
          { label: 'Tax on total income', value: hrMoney(calculation.taxOnTotalIncome) },
          { label: 'Rebate under §87A', value: hrMoney(calculation.rebate87A) },
          { label: 'Tax after rebate', value: hrMoney(calculation.taxAfterRebate) },
          { label: 'Health & education cess', value: hrMoney(calculation.cess) },
          { label: 'Total tax liability', value: hrMoney(calculation.totalTaxLiability) },
        ]}
      />
      <DescriptionList
        items={[
          { label: 'TDS deducted till date', value: hrMoney(calculation.tdsDeductedTillDate) },
          {
            label: calculation.taxPayableOrRefundable >= 0 ? 'Tax payable' : 'Tax refundable',
            value: hrMoney(Math.abs(calculation.taxPayableOrRefundable)),
          },
        ]}
      />
    </div>
  )
}
