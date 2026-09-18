/**
 * Rupee amounts across HRMS. Negative values use the true minus sign (−),
 * not a hyphen, per the project's copy rules.
 */
export function hrMoney(value: number): string {
  const rounded = Math.round(value)
  return rounded < 0
    ? `−₹${Math.abs(rounded).toLocaleString('en-IN')}`
    : `₹${rounded.toLocaleString('en-IN')}`
}
