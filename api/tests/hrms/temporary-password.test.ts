import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  sessionUpdateMany: vi.fn(),
  tokenUpdateMany: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    hrEmployee: { findFirst: mocks.findFirst, update: mocks.update },
    hrSession: { updateMany: mocks.sessionUpdateMany },
    hrPasswordResetToken: { updateMany: mocks.tokenUpdateMany },
    $transaction: mocks.transaction,
  },
}))

import { setTemporaryPassword } from '../../src/modules/hrms/hr-employees.service.js'
import { setTemporaryPasswordSchema } from '../../src/modules/hrms/hr-employees.schema.js'
import { generateTemporaryPassword } from '../../src/lib/hrms/hr-temporary-password.js'
import { BadRequestError, NotFoundError } from '../../src/lib/errors.js'

describe('generateTemporaryPassword', () => {
  it('is four groups of five, easy to read out and paste', () => {
    expect(generateTemporaryPassword()).toMatch(/^[A-Za-z0-9]{5}(-[A-Za-z0-9]{5}){3}$/)
  })

  it('leaves out the characters that are misread by eye', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateTemporaryPassword()).not.toMatch(/[0OIl1]/)
    }
  })

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateTemporaryPassword()))
    expect(seen.size).toBe(500)
  })
})

describe('setTemporaryPasswordSchema', () => {
  it('lets HR leave it blank to have one generated', () => {
    expect(setTemporaryPasswordSchema.parse({})).toEqual({})
  })

  it('holds a typed password to the same twelve-character floor as every other', () => {
    expect(setTemporaryPasswordSchema.safeParse({ password: 'short' }).success).toBe(false)
    expect(setTemporaryPasswordSchema.safeParse({ password: 'long-enough-1234' }).success).toBe(
      true,
    )
  })
})

describe('setTemporaryPassword', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.update.mockReturnValue('update')
    mocks.sessionUpdateMany.mockReturnValue('sessions')
    mocks.tokenUpdateMany.mockReturnValue('tokens')
    mocks.transaction.mockResolvedValue([])
  })

  it('will not set your own, which would only sign you out', async () => {
    await expect(setTemporaryPassword('me', 'me')).rejects.toBeInstanceOf(BadRequestError)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('reports someone who does not exist', async () => {
    mocks.findFirst.mockResolvedValue(null)
    await expect(setTemporaryPassword('them', 'admin')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('refuses someone who has left, since they cannot sign in anyway', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'them', status: 'RESIGNED' })
    await expect(setTemporaryPassword('them', 'admin')).rejects.toThrow('active employee')
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('returns a generated password once, and stores only its hash', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'them', status: 'ACTIVE' })

    const { password } = await setTemporaryPassword('them', 'admin')

    expect(password).toMatch(/^[A-Za-z0-9]{5}(-[A-Za-z0-9]{5}){3}$/)
    const saved = mocks.update.mock.calls[0]?.[0] as { data: { passwordHash: string } }
    expect(saved.data.passwordHash).toMatch(/^\$argon2id\$/)
    expect(JSON.stringify(mocks.update.mock.calls)).not.toContain(password)
  })

  it('uses the password HR typed when there is one', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'them', status: 'ACTIVE' })
    const { password } = await setTemporaryPassword('them', 'admin', 'chosen-by-hr-1234')
    expect(password).toBe('chosen-by-hr-1234')
  })

  it('closes every other way in: sessions, lockout and unused links', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'them', status: 'ACTIVE' })

    await setTemporaryPassword('them', 'admin')

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'them' },
        data: expect.objectContaining({ failedLoginCount: 0, lockedUntil: null }),
      }),
    )
    expect(mocks.sessionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { employeeId: 'them', revokedAt: null } }),
    )
    expect(mocks.tokenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { employeeId: 'them', usedAt: null } }),
    )
    // All three happen together or not at all.
    expect(mocks.transaction).toHaveBeenCalledWith(['update', 'sessions', 'tokens'])
  })
})
