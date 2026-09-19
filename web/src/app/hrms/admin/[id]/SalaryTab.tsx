import { serverFetchOrNull } from '@/lib/api/server'
import { loadIncentiveTypeOptions } from '@/lib/hrms/hr-catalog'
import { financialYearMonths } from '@/lib/hrms/financial-year'
import { HrFinancialYearPicker } from '@/components/hrms/HrFinancialYearPicker'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
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
  updateSalaryStructure,
  addOldSalary,
  deleteOldSalary,
  addMonthlyIncentive,
  deleteMonthlyIncentive,
} from './actions'

interface SalaryStructure {
  basic: number
  hra: number
  specialAllowance: number
  totalFixedAnnual: number
  performanceIncentive: number
  projectIncentive: number
  extraHoursIncentive: number
  totalVariableAnnual: number
}

interface OldSalaryRow {
  id: string
  ctc: number
  fromDate: string
  toDate: string
}

interface MonthlyIncentiveRow {
  id: string
  month: number
  amount: number
  incentiveType: { id: string; name: string }
}

function money(value: number): string {
  return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}

export async function SalaryTab({
  employeeId,
  detailPath,
  financialYear,
  editing,
}: {
  employeeId: string
  detailPath: string
  financialYear: string
  editing: string | undefined
}) {
  const [structure, oldSalaries, incentives, incentiveTypes] = await Promise.all([
    serverFetchOrNull<SalaryStructure>(`hrms/employees/${employeeId}/salary-structure`, {
      query: { financialYear },
    }),
    serverFetchOrNull<OldSalaryRow[]>(`hrms/employees/${employeeId}/old-salaries`),
    serverFetchOrNull<MonthlyIncentiveRow[]>(`hrms/employees/${employeeId}/monthly-incentives`, {
      query: { financialYear },
    }),
    loadIncentiveTypeOptions(),
  ])

  const closedHref = `${detailPath}?section=salary&fy=${financialYear}`

  const oldSalaryColumns: readonly TableColumn<OldSalaryRow>[] = [
    { key: 'ctc', header: 'CTC', render: (row) => money(row.ctc) },
    {
      key: 'period',
      header: 'Period',
      render: (row) =>
        `${new Date(row.fromDate).toLocaleDateString()} – ${new Date(row.toDate).toLocaleDateString()}`,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      interactive: true,
      render: (row) => (
        <form action={deleteOldSalary.bind(null, employeeId, row.id, financialYear)}>
          <ConfirmSubmit question="Remove this old salary record?" size="sm" iconLeft="trash-2">
            Remove
          </ConfirmSubmit>
        </form>
      ),
    },
  ]

  const incentiveColumns: readonly TableColumn<MonthlyIncentiveRow>[] = [
    {
      key: 'month',
      header: 'Month',
      render: (row) =>
        financialYearMonths(financialYear).find((m) => m.month === row.month)?.label ?? row.month,
    },
    { key: 'type', header: 'Type', render: (row) => row.incentiveType.name },
    { key: 'amount', header: 'Amount', render: (row) => money(row.amount) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      interactive: true,
      render: (row) => (
        <form action={deleteMonthlyIncentive.bind(null, employeeId, row.id, financialYear)}>
          <ConfirmSubmit question="Remove this incentive?" size="sm" iconLeft="trash-2">
            Remove
          </ConfirmSubmit>
        </form>
      ),
    },
  ]

  return (
    <>
      <HrFinancialYearPicker action={detailPath} section="salary" financialYear={financialYear} />

      <Panel
        title="Salary structure"
        description={`Fixed and variable annual pay for ${financialYear}.`}
        actions={
          <Button href={`${closedHref}&edit=salary-structure`} variant="secondary" size="sm">
            {structure ? 'Edit' : 'Set up'}
          </Button>
        }
      >
        {structure ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            <DescriptionList
              items={[
                { label: 'Basic', value: money(structure.basic) },
                { label: 'HRA', value: money(structure.hra) },
                { label: 'Special allowance', value: money(structure.specialAllowance) },
                { label: 'Total fixed annual', value: money(structure.totalFixedAnnual) },
              ]}
            />
            <div>
              <p
                style={{
                  margin: '0 0 var(--space-3)',
                  color: 'var(--text-muted)',
                  fontSize: 'var(--type-body-sm-size)',
                }}
              >
                Variable pay is the total of the incentives recorded below, not a figure typed here
                — adding or removing one updates these straight away.
              </p>
              <DescriptionList
                items={[
                  { label: 'Performance incentive', value: money(structure.performanceIncentive) },
                  { label: 'Project incentive', value: money(structure.projectIncentive) },
                  { label: 'Extra hours incentive', value: money(structure.extraHoursIncentive) },
                  {
                    label: 'Total variable annual',
                    value: money(structure.totalVariableAnnual),
                  },
                ]}
              />
            </div>
          </div>
        ) : (
          <EmptyState
            icon="banknote"
            title="No salary structure for this year"
            description="Set up the fixed and variable components to get started."
          />
        )}
      </Panel>

      <Panel title="Old salaries" description="CTC history.">
        {oldSalaries && oldSalaries.length > 0 ? (
          <Table
            ariaLabel="Old salaries"
            columns={oldSalaryColumns}
            rows={oldSalaries}
            rowKey={(row) => row.id}
          />
        ) : (
          <EmptyState icon="banknote" title="No old salary records" />
        )}
        <TrackedForm
          action={addOldSalary.bind(null, employeeId)}
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 'var(--space-4)',
            marginTop: 'var(--space-6)',
            alignItems: 'end',
          }}
        >
          <input type="hidden" name="financialYear" value={financialYear} />
          <Field label="CTC" htmlFor="ctc" required>
            <Input id="ctc" name="ctc" type="number" min={0} step="0.01" required />
          </Field>
          <Field label="From" htmlFor="fromDate" required>
            <Input id="fromDate" name="fromDate" type="date" required />
          </Field>
          <Field label="To" htmlFor="toDate" required>
            <Input id="toDate" name="toDate" type="date" required />
          </Field>
          <SubmitButton variant="secondary" pendingLabel="Adding…">
            Add old salary
          </SubmitButton>
        </TrackedForm>
      </Panel>

      <Panel title="Monthly incentives" description={`Actual incentives paid in ${financialYear}.`}>
        {incentives && incentives.length > 0 ? (
          <Table
            ariaLabel="Monthly incentives"
            columns={incentiveColumns}
            rows={incentives}
            rowKey={(row) => row.id}
          />
        ) : (
          <EmptyState icon="banknote" title="No monthly incentives logged yet" />
        )}
        <TrackedForm
          action={addMonthlyIncentive.bind(null, employeeId)}
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 'var(--space-4)',
            marginTop: 'var(--space-6)',
            alignItems: 'end',
          }}
        >
          <input type="hidden" name="financialYear" value={financialYear} />
          <Field label="Month" htmlFor="month" required>
            <Select
              id="month"
              name="month"
              required
              options={financialYearMonths(financialYear).map((m) => ({
                value: String(m.month),
                label: m.label,
              }))}
            />
          </Field>
          <Field label="Type" htmlFor="incentiveTypeId" required>
            <Select
              id="incentiveTypeId"
              name="incentiveTypeId"
              required
              options={incentiveTypes}
              placeholder="Select type"
            />
          </Field>
          <Field label="Amount" htmlFor="amount" required>
            <Input id="amount" name="amount" type="number" min={0} step="0.01" required />
          </Field>
          <SubmitButton variant="secondary" pendingLabel="Adding…">
            Add incentive
          </SubmitButton>
        </TrackedForm>
      </Panel>

      <Modal
        open={editing === 'salary-structure'}
        closedHref={closedHref}
        title={structure ? 'Edit salary structure' : 'Set up salary structure'}
      >
        <TrackedForm
          action={updateSalaryStructure.bind(null, employeeId)}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
        >
          <input type="hidden" name="financialYear" value={financialYear} />
          <Field label="Basic" htmlFor="basic" required>
            <Input
              id="basic"
              name="basic"
              type="number"
              min={0}
              step="0.01"
              required
              defaultValue={structure?.basic ?? 0}
            />
          </Field>
          <Field label="HRA" htmlFor="hra" required>
            <Input
              id="hra"
              name="hra"
              type="number"
              min={0}
              step="0.01"
              required
              defaultValue={structure?.hra ?? 0}
            />
          </Field>
          <Field label="Special allowance" htmlFor="specialAllowance" required>
            <Input
              id="specialAllowance"
              name="specialAllowance"
              type="number"
              min={0}
              step="0.01"
              required
              defaultValue={structure?.specialAllowance ?? 0}
            />
          </Field>
          <SubmitButton variant="primary" fullWidth pendingLabel="Saving…">
            Save
          </SubmitButton>
        </TrackedForm>
      </Modal>
    </>
  )
}
