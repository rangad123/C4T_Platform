import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), count: vi.fn() }))

vi.mock('../../src/lib/prisma.js', () => ({ prisma: { hrEmployee: mocks } }))

import { assertNotLastAdministrator } from '../../src/modules/hrms/hr-employees.service.js'
import { BadRequestError } from '../../src/lib/errors.js'

const { findFirst, count } = mocks

function target(role: string, status: string) {
  findFirst.mockResolvedValue({ role, status })
}

describe('assertNotLastAdministrator', () => {
  beforeEach(() => {
    findFirst.mockReset()
    count.mockReset()
  })

  it('refuses when the only active administrator is the one being changed', async () => {
    target('ADMIN', 'ACTIVE')
    count.mockResolvedValue(0)

    const attempt = assertNotLastAdministrator('emp-1', 'changing their status')
    await expect(attempt).rejects.toBeInstanceOf(BadRequestError)
    await expect(attempt).rejects.toThrow('only active HR administrator')
  })

  it('allows it when another active administrator exists', async () => {
    target('ADMIN', 'ACTIVE')
    count.mockResolvedValue(1)
    await expect(
      assertNotLastAdministrator('emp-1', 'changing their status'),
    ).resolves.toBeUndefined()
  })

  it('counts only other, active, undeleted administrators', async () => {
    target('ADMIN', 'ACTIVE')
    count.mockResolvedValue(1)
    await assertNotLastAdministrator('emp-1', 'changing their status')
    expect(count).toHaveBeenCalledWith({
      where: { id: { not: 'emp-1' }, role: 'ADMIN', status: 'ACTIVE', deletedAt: null },
    })
  })

  it('does not interfere with anyone who is not an active administrator', async () => {
    const cases: [string, string][] = [
      ['EMPLOYEE', 'ACTIVE'],
      ['ACCOUNT_MANAGER', 'ACTIVE'],
      ['ADMIN', 'RESIGNED'],
    ]
    for (const [role, status] of cases) {
      target(role, status)
      await expect(
        assertNotLastAdministrator('emp-1', 'changing their status'),
      ).resolves.toBeUndefined()
    }
    expect(count).not.toHaveBeenCalled()
  })

  it('leaves an unknown employee to the caller to report', async () => {
    findFirst.mockResolvedValue(null)
    await expect(
      assertNotLastAdministrator('nobody', 'changing their status'),
    ).resolves.toBeUndefined()
  })
})
