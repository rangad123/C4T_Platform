import type { CrmRole } from './hr-types'

/**
 * Mirrors `api/src/lib/hrms/hr-crm-capabilities.ts` exactly — same convention
 * as `HrRole` in `hr-types.ts`: hand-duplicated rather than imported, because
 * the web app cannot import from the API package. Used here only to decide
 * what to SHOW (which sidebar links, which quick-link buttons); the API's own
 * copy is what actually enforces anything. If the two ever drift, the API
 * wins — a shown-but-refused button is a bug to fix here, not a security
 * problem.
 */
export type CrmCapability =
  | 'view_dashboard'
  | 'view_leads'
  | 'create_leads'
  | 'edit_leads'
  | 'delete_leads'
  | 'assign_leads'
  | 'change_status'
  | 'manage_contacts'
  | 'add_activity'
  | 'manage_catalog'
  | 'add_employee'

const MATRIX: Record<CrmRole, ReadonlySet<CrmCapability>> = {
  ADMIN: new Set<CrmCapability>([
    'view_dashboard',
    'view_leads',
    'create_leads',
    'edit_leads',
    'delete_leads',
    'assign_leads',
    'change_status',
    'manage_contacts',
    'add_activity',
    'manage_catalog',
    'add_employee',
  ]),
  MANAGER: new Set<CrmCapability>([
    'view_dashboard',
    'view_leads',
    'create_leads',
    'edit_leads',
    'assign_leads',
    'change_status',
    'manage_contacts',
    'add_activity',
  ]),
  EMPLOYEE: new Set<CrmCapability>([
    'view_dashboard',
    'view_leads',
    'create_leads',
    'edit_leads',
    'change_status',
    'manage_contacts',
    'add_activity',
  ]),
}

export function hasCrmCapability(role: CrmRole, capability: CrmCapability): boolean {
  return MATRIX[role].has(capability)
}

/** See the API's identically-named function for the full reasoning. */
export function canAddEmployeeFromCrm(
  crmRole: CrmRole,
  hrRole: 'ADMIN' | 'ACCOUNT_MANAGER' | 'EMPLOYEE',
): boolean {
  return hasCrmCapability(crmRole, 'add_employee') && hrRole === 'ADMIN'
}
