import { LiveGetForm, LiveFormStatus } from '@/components/admin/LiveGetForm'
import { Select } from '@/components/ds/forms/Select'
import { recentFinancialYears } from '@/lib/hrms/financial-year'

export interface HrFinancialYearPickerProps {
  /** The page path this navigates within — the employee detail path. */
  action: string
  /** Carried through unchanged so switching years doesn't drop the open tab. */
  section: string
  financialYear: string
}

/**
 * The financial-year selector every compensation tab (Salary, Tax,
 * Investments) needs. A `LiveGetForm` — no submit button, picking a year
 * re-navigates immediately — with `section` carried as a hidden field so the
 * URL stays `?section=salary&fy=2026-2027` rather than dropping back to the
 * default tab.
 */
export function HrFinancialYearPicker({
  action,
  section,
  financialYear,
}: HrFinancialYearPickerProps) {
  const options = recentFinancialYears(6).map((fy) => ({ value: fy, label: fy }))

  return (
    <LiveGetForm
      action={action}
      style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}
    >
      <input type="hidden" name="section" value={section} />
      <label
        htmlFor="hr-fy-picker"
        style={{ fontSize: 'var(--type-body-sm-size)', color: 'var(--text-secondary)' }}
      >
        Financial year
      </label>
      <Select id="hr-fy-picker" name="fy" defaultValue={financialYear} options={options} />
      <LiveFormStatus />
    </LiveGetForm>
  )
}
