import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `setUserPermissions` and the role-change clean-up, against a mocked Prisma
 * client. The integration suite (tests/access) needs a test database; these
 * pin the rules without one.
 */
const mocks = vi.hoisted(() => {
  const tx = {
    userPermission: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    permission: { findMany: vi.fn() },
    testerProfile: { upsert: vi.fn() },
    user: { update: vi.fn() },
  }
  return {
    tx,
    userFindFirst: vi.fn(),
    userFindUnique: vi.fn(),
    userCount: vi.fn(),
    grantsFindMany: vi.fn(),
    transaction: vi.fn((fn: (client: typeof tx) => unknown) => Promise.resolve(fn(tx))),
  }
})

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findFirst: mocks.userFindFirst,
      findUnique: mocks.userFindUnique,
      count: mocks.userCount,
    },
    userPermission: { findMany: mocks.grantsFindMany },
    $transaction: mocks.transaction,
  },
}))

import { changeRole, setUserPermissions } from '../../src/modules/users/users.service.js'
import { BadRequestError, ForbiddenError, NotFoundError } from '../../src/lib/errors.js'

const { tx } = mocks

/** The person making the change; an ADMIN unless a test says otherwise. */
function actor(
  id = 'actor',
  role = 'ADMIN',
  permissions: string[] = [],
): Express.AuthenticatedUser {
  return { id, role, permissions } as Express.AuthenticatedUser
}

function target(role: string) {
  mocks.userFindFirst.mockResolvedValue({ id: 'user-1', role })
}

/** Every requested code exists in the permissions table. */
function catalogueHasEverything() {
  tx.permission.findMany.mockImplementation(({ where }: { where: { code: { in: string[] } } }) =>
    Promise.resolve(where.code.in.map((code) => ({ id: `perm-${code}`, code }))),
  )
}

function holding(codes: string[]) {
  tx.userPermission.findMany.mockResolvedValue(codes.map((code) => ({ permission: { code } })))
}

beforeEach(() => {
  vi.clearAllMocks()
  catalogueHasEverything()
  holding([])
})

describe('setUserPermissions', () => {
  it('refuses a sub-admin granting an AI Studio code they do not hold, and allows one they do', async () => {
    target('TESTER')
    mocks.grantsFindMany.mockResolvedValue([])
    const granter = actor('granter', 'SUB_ADMIN', ['subadmin.manage', 'ai_studio.access'])
    await expect(
      setUserPermissions(
        granter,
        'user-1',
        ['ai_studio.access', 'ai_studio.tests.run'],
        'ai_studio',
      ),
    ).rejects.toBeInstanceOf(ForbiddenError)
    await setUserPermissions(granter, 'user-1', ['ai_studio.access'], 'ai_studio')
    expect(tx.userPermission.createMany).toHaveBeenCalled()
  })

  it('refuses an unknown user', async () => {
    mocks.userFindFirst.mockResolvedValue(null)
    await expect(setUserPermissions(actor(), 'user-1', [])).rejects.toBeInstanceOf(NotFoundError)
  })

  it('refuses administrators and unfinished sign-ups, as before', async () => {
    for (const role of ['ADMIN', 'USER']) {
      target(role)
      await expect(
        setUserPermissions(actor(), 'user-1', ['ai_studio.access']),
      ).rejects.toBeInstanceOf(BadRequestError)
    }
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('refuses changing your own permissions', async () => {
    target('SUB_ADMIN')
    await expect(setUserPermissions(actor('user-1'), 'user-1', [])).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })

  it('lets a sub-admin hold back-office and AI Studio codes together', async () => {
    target('SUB_ADMIN')
    await setUserPermissions(actor(), 'user-1', ['project.read', 'ai_studio.platform.settings'])
    expect(tx.userPermission.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } })
    expect(tx.userPermission.createMany).toHaveBeenCalledWith({
      data: [
        { userId: 'user-1', permissionId: 'perm-project.read', grantedById: 'actor' },
        {
          userId: 'user-1',
          permissionId: 'perm-ai_studio.platform.settings',
          grantedById: 'actor',
        },
      ],
      skipDuplicates: true,
    })
  })

  it('gives a tester the allowed AI Studio features', async () => {
    target('TESTER')
    const codes = ['ai_studio.access', 'ai_studio.tests.write', 'ai_studio.reports.export']
    await setUserPermissions(actor(), 'user-1', codes, 'ai_studio')
    expect(tx.userPermission.createMany).toHaveBeenCalledOnce()
  })

  it.each([
    'ai_studio.project.create',
    'ai_studio.project.members',
    'ai_studio.ai_keys.manage',
    'ai_studio.usage.view',
    'ai_studio.platform.settings',
  ])('refuses %s for a tester', async (code) => {
    target('TESTER')
    await expect(
      setUserPermissions(actor(), 'user-1', ['ai_studio.access', code], 'ai_studio'),
    ).rejects.toThrow('This feature cannot be given to a tester.')
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('refuses platform settings for a customer and allows the rest', async () => {
    target('CUSTOMER')
    await expect(
      setUserPermissions(actor(), 'user-1', ['ai_studio.platform.settings']),
    ).rejects.toThrow('This feature cannot be given to a customer.')

    await setUserPermissions(actor(), 'user-1', [
      'ai_studio.access',
      'ai_studio.usage.view',
      'ai_studio.project.create',
      'ai_studio.project.members',
      'ai_studio.ai_keys.manage',
    ])
    expect(tx.userPermission.createMany).toHaveBeenCalledOnce()
  })

  it('keeps back-office codes away from customers and testers', async () => {
    for (const role of ['CUSTOMER', 'TESTER']) {
      target(role)
      await expect(setUserPermissions(actor(), 'user-1', ['project.read'])).rejects.toThrow(
        /Only AI Studio features can be given/,
      )
    }
  })

  it('replaces only the AI Studio grants with the ai_studio scope', async () => {
    target('SUB_ADMIN')
    holding(['ai_studio.access'])
    const result = await setUserPermissions(actor(), 'user-1', ['ai_studio.tests.run'], 'ai_studio')
    const scoped = { permission: { code: { startsWith: 'ai_studio.' } } }
    expect(tx.userPermission.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', ...scoped },
    })
    expect(result.previousCodes).toEqual(['ai_studio.access'])
  })

  it('replaces only the back-office grants with the back_office scope', async () => {
    target('SUB_ADMIN')
    await setUserPermissions(actor(), 'user-1', ['project.read'], 'back_office')
    expect(tx.userPermission.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        NOT: { permission: { code: { startsWith: 'ai_studio.' } } },
      },
    })
  })

  it('refuses a code outside the requested scope', async () => {
    target('SUB_ADMIN')
    await expect(
      setUserPermissions(actor(), 'user-1', ['project.read'], 'ai_studio'),
    ).rejects.toThrow('Only AI Studio features can be set here.')
    await expect(
      setUserPermissions(actor(), 'user-1', ['ai_studio.access'], 'back_office'),
    ).rejects.toThrow('AI Studio features are set in the AI Studio access panel.')
  })

  it('still refuses an unknown code', async () => {
    target('CUSTOMER')
    tx.permission.findMany.mockResolvedValue([])
    await expect(setUserPermissions(actor(), 'user-1', ['ai_studio.nope'])).rejects.toThrow(
      'Unknown permission code(s): ai_studio.nope',
    )
  })
})

describe('changeRole clean-up', () => {
  beforeEach(() => {
    tx.user.update.mockResolvedValue({ id: 'user-1' })
  })

  function from(role: string) {
    mocks.userFindFirst.mockResolvedValue({ id: 'user-1', role })
  }

  it('clears every grant when leaving sub-admin', async () => {
    from('SUB_ADMIN')
    holding(['project.read', 'ai_studio.access'])
    const result = await changeRole(actor(), 'user-1', 'CUSTOMER')
    expect(result.revokedPermissionCodes).toEqual(['project.read', 'ai_studio.access'])
    expect(tx.userPermission.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        permission: { code: { in: ['project.read', 'ai_studio.access'] } },
      },
    })
  })

  it('drops only what a tester may not hold when a customer becomes a tester', async () => {
    from('CUSTOMER')
    holding(['ai_studio.access', 'ai_studio.usage.view', 'ai_studio.tests.run'])
    const result = await changeRole(actor(), 'user-1', 'TESTER')
    expect(result.revokedPermissionCodes).toEqual(['ai_studio.usage.view'])
  })

  it('keeps a tester set when a tester becomes a customer', async () => {
    from('TESTER')
    holding(['ai_studio.access', 'ai_studio.tests.run'])
    const result = await changeRole(actor(), 'user-1', 'CUSTOMER')
    expect(result.revokedPermissionCodes).toEqual([])
    expect(tx.userPermission.deleteMany).not.toHaveBeenCalled()
  })

  it('drops AI Studio grants when a customer becomes an administrator', async () => {
    from('CUSTOMER')
    holding(['ai_studio.access'])
    const result = await changeRole(actor(), 'user-1', 'ADMIN')
    expect(result.revokedPermissionCodes).toEqual(['ai_studio.access'])
  })

  it('keeps AI Studio grants and adds the defaults when a tester becomes a sub-admin', async () => {
    from('TESTER')
    holding(['ai_studio.access'])
    const result = await changeRole(actor(), 'user-1', 'SUB_ADMIN')
    expect(result.revokedPermissionCodes).toEqual([])
    expect(tx.userPermission.createMany).toHaveBeenCalledOnce()
  })
})
