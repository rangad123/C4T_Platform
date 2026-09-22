import 'server-only'
import { serverFetchOrNull } from '@/lib/api/server'

/**
 * Options for the Employees form's fixed dropdowns — mirrors
 * `lib/catalog/target-options.ts`'s shape (a plain `{value,label}[]` per
 * list), reading from the HRMS catalog endpoints instead of the platform's
 * `GET /v1/catalog`.
 */

export interface HrOption {
  value: string
  label: string
}

interface DesignationRow {
  id: string
  name: string
}

interface ManagerRow {
  id: string
  firstName: string
  lastName: string
  employeeCode: string
}

interface IncentiveTypeRow {
  id: string
  name: string
}

interface InvestmentSectionRow {
  id: string
  code: string
  name: string
}

interface LeaveTypeRow {
  id: string
  name: string
}

interface CrmCatalogRow {
  id: string
  name: string
}

interface AssignableEmployeeRow {
  id: string
  firstName: string
  lastName: string
  employeeCode: string
}

export async function loadDesignationOptions(): Promise<readonly HrOption[]> {
  const rows = await serverFetchOrNull<DesignationRow[]>('hrms/catalog/designations')
  return (rows ?? []).map((row) => ({ value: row.id, label: row.name }))
}

export async function loadManagerOptions(): Promise<readonly HrOption[]> {
  const rows = await serverFetchOrNull<ManagerRow[]>('hrms/employees/managers')
  return (rows ?? []).map((row) => ({
    value: row.id,
    label: `${row.firstName} ${row.lastName} (${row.employeeCode})`,
  }))
}

export async function loadIncentiveTypeOptions(): Promise<readonly HrOption[]> {
  const rows = await serverFetchOrNull<IncentiveTypeRow[]>('hrms/catalog/incentive-types')
  return (rows ?? []).map((row) => ({ value: row.id, label: row.name }))
}

export async function loadInvestmentSectionOptions(): Promise<readonly HrOption[]> {
  const rows = await serverFetchOrNull<InvestmentSectionRow[]>('hrms/catalog/investment-sections')
  return (rows ?? []).map((row) => ({ value: row.id, label: `${row.code} — ${row.name}` }))
}

export async function loadLeaveTypeOptions(): Promise<readonly HrOption[]> {
  const rows = await serverFetchOrNull<LeaveTypeRow[]>('hrms/catalog/leave-types')
  return (rows ?? []).map((row) => ({ value: row.id, label: row.name }))
}

export async function loadCrmIndustryOptions(): Promise<readonly HrOption[]> {
  const rows = await serverFetchOrNull<CrmCatalogRow[]>('hrms/catalog/crm-industries')
  return (rows ?? []).map((row) => ({ value: row.id, label: row.name }))
}

export async function loadCrmLeadSourceOptions(): Promise<readonly HrOption[]> {
  const rows = await serverFetchOrNull<CrmCatalogRow[]>('hrms/catalog/crm-lead-sources')
  return (rows ?? []).map((row) => ({ value: row.id, label: row.name }))
}

/** Active, CRM-enabled employees — who a lead can be assigned to. Requires `assign_leads`. */
export async function loadCrmAssignableEmployeeOptions(): Promise<readonly HrOption[]> {
  const rows = await serverFetchOrNull<AssignableEmployeeRow[]>(
    'hrms/crm/leads/assignable-employees',
  )
  return (rows ?? []).map((row) => ({
    value: row.id,
    label: `${row.firstName} ${row.lastName} (${row.employeeCode})`,
  }))
}

/**
 * Keeps a stored value the catalog no longer offers (a retired designation,
 * a manager who left) visible and selected, rather than the field silently
 * reverting to the placeholder — same reasoning as the platform's own
 * `withStored` in `lib/catalog/target-options.ts`.
 */
export function withStoredOption(
  options: readonly HrOption[],
  current: { value: string; label: string } | null | undefined,
): readonly HrOption[] {
  if (!current || options.some((option) => option.value === current.value)) return options
  return [current, ...options]
}
