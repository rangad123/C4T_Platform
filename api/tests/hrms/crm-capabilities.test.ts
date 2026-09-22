import { describe, expect, it } from 'vitest'
import {
  canAddEmployeeFromCrm,
  crmCapabilityScope,
  hasCrmCapability,
  type CrmCapability,
} from '../../src/lib/hrms/hr-crm-capabilities.js'

const ALL_CAPABILITIES: readonly CrmCapability[] = [
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
]

describe('hasCrmCapability', () => {
  it('gives the administrator every capability, org-wide', () => {
    for (const capability of ALL_CAPABILITIES) {
      expect(hasCrmCapability('ADMIN', capability), capability).toBe(true)
    }
  })

  it('gives the manager everything except delete, catalog and adding an employee', () => {
    const denied: CrmCapability[] = ['delete_leads', 'manage_catalog', 'add_employee']
    for (const capability of ALL_CAPABILITIES) {
      expect(hasCrmCapability('MANAGER', capability), capability).toBe(!denied.includes(capability))
    }
  })

  it('gives the employee only their own-scoped day-to-day capabilities', () => {
    const granted: CrmCapability[] = [
      'view_dashboard',
      'view_leads',
      'create_leads',
      'edit_leads',
      'change_status',
      'manage_contacts',
      'add_activity',
    ]
    for (const capability of ALL_CAPABILITIES) {
      expect(hasCrmCapability('EMPLOYEE', capability), capability).toBe(
        granted.includes(capability),
      )
    }
  })

  it('never lets the employee tier delete, assign, manage the catalog or add an employee', () => {
    for (const capability of [
      'delete_leads',
      'assign_leads',
      'manage_catalog',
      'add_employee',
    ] as const) {
      expect(hasCrmCapability('EMPLOYEE', capability)).toBe(false)
    }
  })
})

describe('crmCapabilityScope', () => {
  it('is "all" for the tiers that see every lead', () => {
    expect(crmCapabilityScope('ADMIN', 'view_leads')).toBe('all')
    expect(crmCapabilityScope('MANAGER', 'view_leads')).toBe('all')
  })

  it('is "own" for the employee tier, so a service can build the ownership filter', () => {
    expect(crmCapabilityScope('EMPLOYEE', 'view_leads')).toBe('own')
    expect(crmCapabilityScope('EMPLOYEE', 'edit_leads')).toBe('own')
  })

  it('is null when the tier does not have the capability at all', () => {
    expect(crmCapabilityScope('EMPLOYEE', 'manage_catalog')).toBeNull()
    expect(crmCapabilityScope('MANAGER', 'delete_leads')).toBeNull()
  })

  it('has no ownership concept for capabilities that are org-wide-or-nothing', () => {
    // assign_leads/manage_catalog/add_employee never appear as 'own' for any tier.
    for (const role of ['ADMIN', 'MANAGER', 'EMPLOYEE'] as const) {
      for (const capability of ['assign_leads', 'manage_catalog', 'add_employee'] as const) {
        expect(crmCapabilityScope(role, capability)).not.toBe('own')
      }
    }
  })
})

describe('canAddEmployeeFromCrm', () => {
  it('needs both a CRM administrator and an HR administrator', () => {
    expect(canAddEmployeeFromCrm('ADMIN', 'ADMIN')).toBe(true)
  })

  it('refuses a CRM administrator who is not an HR administrator, to avoid a dead link', () => {
    expect(canAddEmployeeFromCrm('ADMIN', 'EMPLOYEE')).toBe(false)
    expect(canAddEmployeeFromCrm('ADMIN', 'ACCOUNT_MANAGER')).toBe(false)
  })

  it('refuses anyone who is not a CRM administrator, even if they are an HR administrator', () => {
    expect(canAddEmployeeFromCrm('MANAGER', 'ADMIN')).toBe(false)
    expect(canAddEmployeeFromCrm('EMPLOYEE', 'ADMIN')).toBe(false)
  })
})
