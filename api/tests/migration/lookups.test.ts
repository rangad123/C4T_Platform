import { describe, expect, it } from 'vitest'
import { BugStatus, Role } from '@prisma/client'
import {
  ASSIGNMENT_STATUS,
  BUG_STATUS_BY_LEGACY_ID,
  BUILD_STATUS,
  PAYMENT_METHOD,
  ROLE_BY_LEGACY_ID,
  TRANSACTION_STATUS,
  TRANSACTION_TYPE,
} from '../../scripts/migration/mapping/lookups.js'
import { enumValue } from '../../scripts/migration/transform/values.js'

/**
 * The legacy→new value tables.
 *
 * These are not obvious constants: every one below was read off the live legacy
 * database rather than inferred from column names, and the first version of
 * several of them was wrong in a way nothing caught. A bad entry here does not
 * fail — it silently mislabels thousands of rows and reports itself only as a
 * "defaulted" line in a CSV nobody reads twice. So the values that were
 * expensive to establish are pinned here.
 */

describe('ROLE_BY_LEGACY_ID', () => {
  /*
    From the legacy `roles` table:
      1 Admin · 2 Company · 3 Manager · 4 Beta Tester
      5 QA Tester · 6 Developer · 7 Crowd Tester · 8 Sub Admin
  */
  it('maps Crowd Tester, which is nearly every account on the platform', () => {
    // 6,357 of 6,706 users carry role 7. An earlier table had no entry for it
    // at all, so they all migrated as USER and their devices and browsers
    // orphaned for want of a TesterProfile.
    expect(ROLE_BY_LEGACY_ID['7']).toBe(Role.TESTER)
  })

  it('maps all three tester roles to TESTER', () => {
    expect(ROLE_BY_LEGACY_ID['4']).toBe(Role.TESTER) // Beta Tester
    expect(ROLE_BY_LEGACY_ID['5']).toBe(Role.TESTER) // QA Tester
    expect(ROLE_BY_LEGACY_ID['7']).toBe(Role.TESTER) // Crowd Tester
  })

  it('maps both staff roles to SUB_ADMIN, and Company to CUSTOMER', () => {
    expect(ROLE_BY_LEGACY_ID['3']).toBe(Role.SUB_ADMIN) // Manager
    expect(ROLE_BY_LEGACY_ID['8']).toBe(Role.SUB_ADMIN) // Sub Admin
    expect(ROLE_BY_LEGACY_ID['1']).toBe(Role.ADMIN)
    expect(ROLE_BY_LEGACY_ID['2']).toBe(Role.CUSTOMER)
  })

  it('covers every id the roles table defines', () => {
    for (const id of ['1', '2', '3', '4', '5', '6', '7', '8']) {
      expect(ROLE_BY_LEGACY_ID[id], `role id ${id} is unmapped`).toBeDefined()
    }
  })
})

describe('BUG_STATUS_BY_LEGACY_ID', () => {
  /*
    bugs_report.bug_status is an integer with no reference table. The names
    were recovered by joining each bug's last "Status changed from X to Y"
    comment to its stored code — unanimous over thousands of rows.
  */
  it('maps the six codes the transition comments named unanimously', () => {
    expect(BUG_STATUS_BY_LEGACY_ID['0']).toBe(BugStatus.NEW)
    expect(BUG_STATUS_BY_LEGACY_ID['1']).toBe(BugStatus.DUPLICATE)
    expect(BUG_STATUS_BY_LEGACY_ID['2']).toBe(BugStatus.REJECTED) // Invalid
    expect(BUG_STATUS_BY_LEGACY_ID['3']).toBe(BugStatus.IN_PROGRESS)
    expect(BUG_STATUS_BY_LEGACY_ID['4']).toBe(BugStatus.FIXED)
    expect(BUG_STATUS_BY_LEGACY_ID['5']).toBe(BugStatus.VERIFIED) // Closed
  })

  it('maps the three statuses added in September 2018', () => {
    expect(BUG_STATUS_BY_LEGACY_ID['6']).toBe(BugStatus.TRIAGED) // Need More Info
    expect(BUG_STATUS_BY_LEGACY_ID['7']).toBe(BugStatus.FEATURE_REQUEST)
    expect(BUG_STATUS_BY_LEGACY_ID['8']).toBe(BugStatus.REJECTED) // Cant Reproduce
  })

  it('resolves through enumValue, which is how the loader reads it', () => {
    // The column arrives as a number, not a string.
    expect(enumValue(5, BUG_STATUS_BY_LEGACY_ID, BugStatus.NEW, 'bug_status')).toEqual({
      value: BugStatus.VERIFIED,
      problem: null,
    })
  })
})

describe('the values the legacy columns actually hold', () => {
  const resolves = (raw: unknown, table: Record<string, string>, fallback: string) =>
    enumValue(raw, table, fallback, 'field')

  it('maps ind_bank_acc, the spelling payment_acc_details uses', () => {
    // 941 rows across two tables were defaulting because only "bank",
    // "indian_bank" and friends were listed.
    expect(resolves('ind_bank_acc', PAYMENT_METHOD, 'PAYPAL').problem).toBeNull()
    expect(resolves('ind_bank_acc', PAYMENT_METHOD, 'PAYPAL').value).toBe('IND_BANK_ACCOUNT')
  })

  it('reads a payment_history credit as a tester earning', () => {
    expect(resolves('credit', TRANSACTION_TYPE, 'ADJUSTMENT').value).toBe('TESTER_EARNING')
    expect(resolves('debit', TRANSACTION_TYPE, 'ADJUSTMENT').value).toBe('TESTER_PAYOUT')
  })

  it('maps pmt_status "new", the only value all 6,700 rows carry', () => {
    const result = resolves('new', TRANSACTION_STATUS, 'PENDING')
    expect(result.value).toBe('PAID')
    expect(result.problem).toBeNull()
  })

  it('maps the test_status names an assignment can hold', () => {
    // 1 Assigned · 2 Tested · 3 Reviewed · 4 Closed · 5 invited · 6 joined
    expect(resolves('Assigned', ASSIGNMENT_STATUS, 'COMPLETED').value).toBe('ACTIVE')
    expect(resolves('Tested', ASSIGNMENT_STATUS, 'INVITED').value).toBe('COMPLETED')
    expect(resolves('Reviewed', ASSIGNMENT_STATUS, 'INVITED').value).toBe('COMPLETED')
    expect(resolves('joined', ASSIGNMENT_STATUS, 'INVITED').value).toBe('ACCEPTED')
  })

  it('maps every build_test_status value, which used to be hardcoded CLOSED', () => {
    for (const [legacy, expected] of [
      ['new', 'NEW'],
      ['assigned', 'ASSIGNED'],
      ['tested', 'TESTED'],
      ['closed', 'CLOSED'],
    ] as const) {
      const result = resolves(legacy, BUILD_STATUS, 'CLOSED')
      expect(result.value, `build_test_status=${legacy}`).toBe(expected)
      expect(result.problem).toBeNull()
    }
  })
})
