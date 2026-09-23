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

/** `'own'` capabilities are additionally scoped to leads the employee is assigned to. */
export type CrmCapabilityScope = 'all' | 'own'

const MATRIX: Record<CrmRole, Partial<Record<CrmCapability, CrmCapabilityScope>>> = {
  ADMIN: {
    view_dashboard: 'all',
    view_leads: 'all',
    create_leads: 'all',
    edit_leads: 'all',
    delete_leads: 'all',
    assign_leads: 'all',
    change_status: 'all',
    manage_contacts: 'all',
    add_activity: 'all',
    manage_catalog: 'all',
  },
  MANAGER: {
    view_dashboard: 'all',
    view_leads: 'all',
    create_leads: 'all',
    edit_leads: 'all',
    assign_leads: 'all',
    change_status: 'all',
    manage_contacts: 'all',
    add_activity: 'all',
  },
  EMPLOYEE: {
    view_dashboard: 'own',
    view_leads: 'own',
    create_leads: 'own',
    edit_leads: 'own',
    change_status: 'own',
    manage_contacts: 'own',
    add_activity: 'own',
  },
}

export function hasCrmCapability(role: CrmRole, capability: CrmCapability): boolean {
  return MATRIX[role][capability] !== undefined
}

/** Same as the API's — used here only to decide what to SHOW (an assignee filter/picker), never to enforce anything. */
export function crmCapabilityScope(
  role: CrmRole,
  capability: CrmCapability,
): CrmCapabilityScope | null {
  return MATRIX[role][capability] ?? null
}
