import { serverFetchOrNull } from '@/lib/api/server'
import { loadInvestmentSectionOptions } from '@/lib/hrms/hr-catalog'
import { financialYearMonths } from '@/lib/hrms/financial-year'
import { HrFinancialYearPicker } from '@/components/hrms/HrFinancialYearPicker'
import { Panel } from '@/components/admin/Panel'
import { Modal } from '@/components/admin/Modal'
import { Button } from '@/components/ds/core/Button'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { ConfirmSubmit } from '@/components/admin/ConfirmSubmit'
import {
  addInvestmentDeclaration,
  verifyInvestmentDeclaration,
  deleteInvestmentDeclaration,
  addMonthlyDeduction,
  deleteMonthlyDeduction,
} from './actions'

interface DeclarationRow {
  id: string
  description: string | null
  declaredAmount: number
  verifiedAmount: number | null
  section: { id: string; code: string; name: string }
  verifiedBy: { id: string; firstName: string; lastName: string } | null
}

interface DeductionRow {
  id: string
  month: number
  amount: number
}

function money(value: number): string {
  return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}

export async function InvestmentsTab({
  employeeId,
  detailPath,
  financialYear,
  verifying,
}: {
  employeeId: string
  detailPath: string
  financialYear: string
  verifying: string | undefined
}) {
  const [declarations, deductions, sections] = await Promise.all([
    serverFetchOrNull<DeclarationRow[]>(`hrms/employees/${employeeId}/investment-declarations`, {
      query: { financialYear },
    }),
    serverFetchOrNull<DeductionRow[]>(`hrms/employees/${employeeId}/monthly-tax-deductions`, {
      query: { financialYear },
    }),
    loadInvestmentSectionOptions(),
  ])

  const closedHref = `${detailPath}?section=investments&fy=${financialYear}`
  const verifyingDeclaration = declarations?.find((d) => d.id === verifying) ?? null

  const declarationColumns: readonly TableColumn<DeclarationRow>[] = [
    { key: 'section', header: 'Section', render: (row) => row.section.code },
    { key: 'description', header: 'Description', render: (row) => row.description ?? '—' },
    { key: 'declared', header: 'Declared', render: (row) => money(row.declaredAmount) },
    {
      key: 'verified',
      header: 'Verified',
      render: (row) =>
        row.verifiedAmount !== null ? (
          money(row.verifiedAmount)
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>Not verified</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      interactive: true,
      render: (row) => (
        <span style={{ display: 'inline-flex', gap: 'var(--space-3)' }}>
          <Button href={`${closedHref}&verify=${row.id}`} variant="secondary" size="sm">
            {row.verifiedAmount !== null ? 'Re-verify' : 'Verify'}
          </Button>
          <form action={deleteInvestmentDeclaration.bind(null, employeeId, row.id, financialYear)}>
            <ConfirmSubmit question="Remove this declaration?" size="sm" iconLeft="trash-2">
              Remove
            </ConfirmSubmit>
          </form>
        </span>
      ),
    },
  ]

  const deductionColumns: readonly TableColumn<DeductionRow>[] = [
    {
      key: 'month',
      header: 'Month',
      render: (row) =>
        financialYearMonths(financialYear).find((m) => m.month === row.month)?.label ?? row.month,
    },
    { key: 'amount', header: 'TDS deducted', render: (row) => money(row.amount) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      interactive: true,
      render: (row) => (
        <form action={deleteMonthlyDeduction.bind(null, employeeId, row.id, financialYear)}>
          <ConfirmSubmit question="Remove this TDS entry?" size="sm" iconLeft="trash-2">
            Remove
          </ConfirmSubmit>
        </form>
      ),
    },
  ]

  return (
    <>
      <HrFinancialYearPicker
        action={detailPath}
        section="investments"
        financialYear={financialYear}
      />

      <Panel
        title="Investment declarations"
        description={`Section-wise declarations for ${financialYear}. Verified amounts (once set) drive the tax calculation.`}
      >
        {declarations && declarations.length > 0 ? (
          <Table
            ariaLabel="Investment declarations"
            columns={declarationColumns}
            rows={declarations}
            rowKey={(row) => row.id}
          />
        ) : (
          <EmptyState icon="landmark" title="No investment declarations yet" />
        )}
        <TrackedForm
          action={addInvestmentDeclaration.bind(null, employeeId)}
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 'var(--space-4)',
            marginTop: 'var(--space-6)',
            alignItems: 'end',
          }}
        >
          <input type="hidden" name="financialYear" value={financialYear} />
          <Field label="Section" htmlFor="sectionId" required>
            <Select
              id="sectionId"
              name="sectionId"
              required
              options={sections}
              placeholder="Select section"
            />
          </Field>
          <Field label="Description" htmlFor="description">
            <Input id="description" name="description" maxLength={500} />
          </Field>
          <Field label="Declared amount" htmlFor="declaredAmount" required>
            <Input
              id="declaredAmount"
              name="declaredAmount"
              type="number"
              min={0}
              step="0.01"
              required
            />
          </Field>
          <SubmitButton variant="secondary" pendingLabel="Adding…">
            Add declaration
          </SubmitButton>
        </TrackedForm>
      </Panel>

      <Panel
        title="Monthly tax deductions"
        description={`TDS already deducted for ${financialYear}.`}
      >
        {deductions && deductions.length > 0 ? (
          <Table
            ariaLabel="Monthly tax deductions"
            columns={deductionColumns}
            rows={deductions}
            rowKey={(row) => row.id}
          />
        ) : (
          <EmptyState icon="landmark" title="No TDS entries yet" />
        )}
        <TrackedForm
          action={addMonthlyDeduction.bind(null, employeeId)}
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 'var(--space-4)',
            marginTop: 'var(--space-6)',
            alignItems: 'end',
          }}
        >
          <input type="hidden" name="financialYear" value={financialYear} />
          <Field label="Month" htmlFor="deductionMonth" required>
            <Select
              id="deductionMonth"
              name="month"
              required
              options={financialYearMonths(financialYear).map((m) => ({
                value: String(m.month),
                label: m.label,
              }))}
            />
          </Field>
          <Field label="Amount" htmlFor="deductionAmount" required>
            <Input id="deductionAmount" name="amount" type="number" min={0} step="0.01" required />
          </Field>
          <SubmitButton variant="secondary" pendingLabel="Saving…">
            Save TDS
          </SubmitButton>
        </TrackedForm>
      </Panel>

      <Modal
        open={verifyingDeclaration !== null}
        closedHref={closedHref}
        title={`Verify ${verifyingDeclaration?.section.code ?? ''} declaration`}
      >
        {verifyingDeclaration ? (
          <TrackedForm
            action={verifyInvestmentDeclaration.bind(null, employeeId)}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
          >
            <input type="hidden" name="financialYear" value={financialYear} />
            <input type="hidden" name="declarationId" value={verifyingDeclaration.id} />
            <p
              style={{
                margin: 0,
                color: 'var(--text-secondary)',
                fontSize: 'var(--type-body-sm-size)',
              }}
            >
              Declared: {money(verifyingDeclaration.declaredAmount)}
              {verifyingDeclaration.description ? ` — ${verifyingDeclaration.description}` : ''}
            </p>
            <Field
              label="Verified amount"
              htmlFor="verifiedAmount"
              required
              hint="The amount actually allowed for this section."
            >
              <Input
                id="verifiedAmount"
                name="verifiedAmount"
                type="number"
                min={0}
                step="0.01"
                required
                defaultValue={
                  verifyingDeclaration.verifiedAmount ?? verifyingDeclaration.declaredAmount
                }
              />
            </Field>
            <SubmitButton variant="primary" fullWidth pendingLabel="Saving…">
              Save verification
            </SubmitButton>
          </TrackedForm>
        ) : null}
      </Modal>
    </>
  )
}
