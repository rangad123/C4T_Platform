import { describe, expect, it } from 'vitest'
import {
  createEmployeeSchema,
  updateOwnDetailsSchema,
} from '../../src/modules/hrms/hr-employees.schema.js'
import { todayInIndia } from '../../src/lib/hrms/hr-calendar.js'

describe('createEmployeeSchema', () => {
  it('needs only a name, an email and a role', () => {
    const parsed = createEmployeeSchema.parse({
      firstName: ' Asha ',
      lastName: 'Rao',
      email: ' Asha.Rao@Example.com ',
      role: 'ACCOUNT_MANAGER',
    })
    expect(parsed).toEqual({
      firstName: 'Asha',
      lastName: 'Rao',
      email: 'asha.rao@example.com',
      role: 'ACCOUNT_MANAGER',
    })
  })

  it('defaults the role to a plain employee', () => {
    expect(
      createEmployeeSchema.parse({ firstName: 'A', lastName: 'B', email: 'a@b.co' }).role,
    ).toBe('EMPLOYEE')
  })

  it('ignores everything the new starter fills in later, including a typed password', () => {
    const parsed = createEmployeeSchema.parse({
      firstName: 'A',
      lastName: 'B',
      email: 'a@b.co',
      password: 'a-password-nobody-should-pass-on',
      joiningDate: '2020-01-01',
      phone: '+91 98765 43210',
      panNumber: 'ABCDE1234F',
    })
    expect(Object.keys(parsed).sort()).toEqual(['email', 'firstName', 'lastName', 'role'])
  })

  it('still rejects a missing name or a bad email', () => {
    expect(
      createEmployeeSchema.safeParse({ firstName: '', lastName: 'B', email: 'a@b.co' }).success,
    ).toBe(false)
    expect(
      createEmployeeSchema.safeParse({ firstName: 'A', lastName: 'B', email: 'nope' }).success,
    ).toBe(false)
  })
})

describe('updateOwnDetailsSchema', () => {
  it('lets an employee fill in personal details without a password', () => {
    const parsed = updateOwnDetailsSchema.parse({
      dateOfBirth: '1994-05-17',
      gender: 'FEMALE',
      phone: '+91 98765 43210',
      address: '12 MG Road, Bengaluru',
    })
    expect(parsed.gender).toBe('FEMALE')
    expect(parsed.dateOfBirth).toBeInstanceOf(Date)
  })

  it('asks for the password whenever a bank or PAN field is present', () => {
    for (const field of [
      { panNumber: 'ABCDE1234F' },
      { accountNumber: '123456789012' },
      { accountName: 'Asha Rao' },
      { ifscCode: 'HDFC0001234' },
      { bankName: 'HDFC Bank' },
      { branchName: 'Indiranagar' },
    ]) {
      const result = updateOwnDetailsSchema.safeParse(field)
      expect(result.success, JSON.stringify(field)).toBe(false)
    }
  })

  it('accepts bank and PAN details together with the password', () => {
    const result = updateOwnDetailsSchema.safeParse({
      panNumber: 'abcde1234f',
      accountNumber: '123456789012',
      ifscCode: 'hdfc0001234',
      currentPassword: 'their-own-password',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.panNumber).toBe('ABCDE1234F')
      expect(result.data.ifscCode).toBe('HDFC0001234')
    }
  })

  it('cannot be used to change anything that is HR’s to set', () => {
    const parsed = updateOwnDetailsSchema.parse({
      phone: '+91 98765 43210',
      role: 'ADMIN',
      email: 'someone-else@example.com',
      firstName: 'Changed',
      designationId: 'ckx0000000000000000000000',
      reportsToId: 'ckx0000000000000000000001',
      joiningDate: '2001-01-01',
      relievingDate: '2030-01-01',
      taxRegime: 'OLD',
      timesheetRequired: false,
      status: 'ACTIVE',
    })
    expect(Object.keys(parsed)).toEqual(['phone'])
  })
})

describe('todayInIndia', () => {
  it('is the calendar day in India, at UTC midnight', () => {
    expect(todayInIndia(new Date('2026-09-20T10:00:00Z')).toISOString()).toBe(
      '2026-09-20T00:00:00.000Z',
    )
  })

  it('is already tomorrow in India late in the UTC evening', () => {
    // 20:00 UTC is 01:30 the next morning in India; someone added then joins
    // "today" there, not on the UTC date the server clock shows.
    expect(todayInIndia(new Date('2026-09-20T20:00:00Z')).toISOString()).toBe(
      '2026-09-21T00:00:00.000Z',
    )
  })

  it('rolls over the month and year correctly', () => {
    expect(todayInIndia(new Date('2026-12-31T19:00:00Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    )
  })
})
