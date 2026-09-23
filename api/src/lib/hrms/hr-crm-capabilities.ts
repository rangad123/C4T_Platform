/**
 * What each CRM tier may do — a pure function, no I/O, so it can be tested
 * without a database and read by both the API (to refuse a request) and the
 * web app (to decide what to show, never as the only guard — see the routes).
 *
 * There is no generic permission-grant table anywhere in HRMS to extend (only
 * `HrRole`, a 3-value enum, plus a few plain booleans like
 * `timesheetRequired`). Building one just for CRM's 10 checkboxes would be
 * its own new system, which is exactly what was asked not to build. A small
 * capability matrix keyed by `CrmRole` is the minimum real extension:
 * everything a tier can do is derived from one place, so a rule can never
 * drift between two screens the way a scattered set of `if (role === ...)`
 * checks would.
 *
 * `own` capabilities are additionally scoped to rows the employee owns
 * (`assignedToId` on the lead) — that scoping happens in the service layer,
 * not here; this function only answers "can this tier do this at all".
 */
export type CrmRole = 'ADMIN' | 'MANAGER' | 'EMPLOYEE'

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

/**
 * Whether a capability applies to every lead or only ones the employee is
 * assigned to. Absent from this map (`delete_leads`, `assign_leads`,
 * `manage_catalog`) means the capability has no per-row ownership concept —
 * a tier either has it org-wide or not at all.
 */
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

/** Whether a tier has a capability at all, own-scoped or not. */
export function hasCrmCapability(role: CrmRole, capability: CrmCapability): boolean {
  return MATRIX[role][capability] !== undefined
}

/**
 * `'all' | 'own' | null` — `null` means the tier does not have the
 * capability. Callers that need to build a `WHERE assignedToId = self`
 * clause read this instead of `hasCrmCapability`; everything else can use
 * the boolean.
 */
export function crmCapabilityScope(
  role: CrmRole,
  capability: CrmCapability,
): CrmCapabilityScope | null {
  return MATRIX[role][capability] ?? null
}
