import { describe, expect, it } from 'vitest'
import { Role } from '@prisma/client'
import { PERMISSION_CATALOGUE, PERMISSIONS } from '../../src/config/permissions.js'
import {
  AI_STUDIO_NEVER_FOR_CUSTOMER,
  AI_STUDIO_NEVER_FOR_TESTER,
  assertGrantable,
  codesKeptOnRoleChange,
  inScope,
  isGrantable,
  permissionRefusal,
} from '../../src/modules/users/permission-rules.js'
import { BadRequestError } from '../../src/lib/errors.js'

const AI_STUDIO = PERMISSION_CATALOGUE.filter((p) => p.code.startsWith('ai_studio.')).map(
  (p) => p.code,
)
const BACK_OFFICE = PERMISSION_CATALOGUE.filter((p) => !p.code.startsWith('ai_studio.')).map(
  (p) => p.code,
)

describe('the AI Studio catalogue', () => {
  it('has the sixteen codes of ACCESS_MODEL.md, in the AI Studio group', () => {
    expect(AI_STUDIO.sort()).toEqual(
      [
        'ai_studio.access',
        'ai_studio.project.create',
        'ai_studio.project.settings',
        'ai_studio.project.members',
        'ai_studio.tests.write',
        'ai_studio.tests.generate',
        'ai_studio.tests.approve',
        'ai_studio.tests.run',
        'ai_studio.agent.run',
        'ai_studio.reports.export',
        'ai_studio.tests.delete',
        'ai_studio.runners.manage',
        'ai_studio.ai_keys.manage',
        'ai_studio.usage.view',
        'ai_studio.security.use',
        'ai_studio.platform.settings',
      ].sort(),
    )
    for (const entry of PERMISSION_CATALOGUE.filter((p) => p.code.startsWith('ai_studio.'))) {
      expect(entry.group).toBe('AI Studio')
      expect(entry.label.length).toBeGreaterThan(0)
      expect(entry.description).toMatch(/\.$/)
    }
  })

  it('has no duplicate codes', () => {
    const codes = PERMISSION_CATALOGUE.map((p) => p.code)
    expect(new Set(codes).size).toBe(codes.length)
  })
})

describe('permissionRefusal', () => {
  it('lets a sub-admin hold any code', () => {
    for (const code of [...AI_STUDIO, ...BACK_OFFICE]) {
      expect(isGrantable(Role.SUB_ADMIN, code)).toBe(true)
    }
  })

  it('never gives a tester the five tester-excluded features', () => {
    expect([...AI_STUDIO_NEVER_FOR_TESTER].sort()).toEqual(
      [
        PERMISSIONS.AI_STUDIO_PROJECT_CREATE,
        PERMISSIONS.AI_STUDIO_PROJECT_MEMBERS,
        PERMISSIONS.AI_STUDIO_AI_KEYS_MANAGE,
        PERMISSIONS.AI_STUDIO_USAGE_VIEW,
        PERMISSIONS.AI_STUDIO_PLATFORM_SETTINGS,
      ].sort(),
    )
    for (const code of AI_STUDIO_NEVER_FOR_TESTER) {
      expect(permissionRefusal(Role.TESTER, code)).toBe('This feature cannot be given to a tester.')
    }
  })

  it('gives a tester every other AI Studio feature', () => {
    const allowed = AI_STUDIO.filter((code) => !AI_STUDIO_NEVER_FOR_TESTER.includes(code))
    expect(allowed).toHaveLength(11)
    for (const code of allowed) expect(isGrantable(Role.TESTER, code)).toBe(true)
  })

  it('never gives a customer the platform settings', () => {
    expect(AI_STUDIO_NEVER_FOR_CUSTOMER).toEqual([PERMISSIONS.AI_STUDIO_PLATFORM_SETTINGS])
    expect(permissionRefusal(Role.CUSTOMER, PERMISSIONS.AI_STUDIO_PLATFORM_SETTINGS)).toBe(
      'This feature cannot be given to a customer.',
    )
    const allowed = AI_STUDIO.filter((code) => code !== PERMISSIONS.AI_STUDIO_PLATFORM_SETTINGS)
    for (const code of allowed) expect(isGrantable(Role.CUSTOMER, code)).toBe(true)
  })

  it('keeps every back-office code away from customers and testers', () => {
    for (const code of BACK_OFFICE) {
      expect(permissionRefusal(Role.CUSTOMER, code)).toBe(
        'Only AI Studio features can be given to a customer.',
      )
      expect(permissionRefusal(Role.TESTER, code)).toBe(
        'Only AI Studio features can be given to a tester.',
      )
    }
  })

  it('refuses administrators and unfinished sign-ups everything', () => {
    for (const code of [...AI_STUDIO, ...BACK_OFFICE]) {
      expect(isGrantable(Role.ADMIN, code)).toBe(false)
      expect(isGrantable(Role.USER, code)).toBe(false)
    }
  })
})

describe('assertGrantable', () => {
  it('passes an allowed set', () => {
    expect(() =>
      assertGrantable(Role.TESTER, [PERMISSIONS.AI_STUDIO_ACCESS, PERMISSIONS.AI_STUDIO_TESTS_RUN]),
    ).not.toThrow()
    expect(() => assertGrantable(Role.TESTER, [])).not.toThrow()
  })

  it('throws a 400 with the refusal message and every refused code', () => {
    try {
      assertGrantable(Role.TESTER, [
        PERMISSIONS.AI_STUDIO_ACCESS,
        PERMISSIONS.AI_STUDIO_USAGE_VIEW,
        PERMISSIONS.PROJECT_READ,
      ])
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestError)
      expect((error as BadRequestError).message).toBe('This feature cannot be given to a tester.')
      expect((error as BadRequestError).details).toEqual({
        refused: [PERMISSIONS.AI_STUDIO_USAGE_VIEW, PERMISSIONS.PROJECT_READ],
      })
    }
  })
})

describe('inScope', () => {
  it('splits the catalogue into AI Studio and back office', () => {
    expect(inScope('ai_studio', 'ai_studio.access')).toBe(true)
    expect(inScope('ai_studio', 'project.read')).toBe(false)
    expect(inScope('back_office', 'project.read')).toBe(true)
    expect(inScope('back_office', 'ai_studio.access')).toBe(false)
    expect(inScope('all', 'ai_studio.access')).toBe(true)
    expect(inScope('all', 'project.read')).toBe(true)
  })
})

describe('codesKeptOnRoleChange', () => {
  const testerSet = [PERMISSIONS.AI_STUDIO_ACCESS, PERMISSIONS.AI_STUDIO_TESTS_RUN]
  const customerSet = [
    PERMISSIONS.AI_STUDIO_ACCESS,
    PERMISSIONS.AI_STUDIO_USAGE_VIEW,
    PERMISSIONS.AI_STUDIO_PROJECT_CREATE,
  ]

  it('clears everything when leaving sub-admin, as before', () => {
    const held = [PERMISSIONS.PROJECT_READ, PERMISSIONS.AI_STUDIO_ACCESS]
    for (const to of [Role.CUSTOMER, Role.TESTER, Role.ADMIN, Role.USER]) {
      expect(codesKeptOnRoleChange(Role.SUB_ADMIN, to, held)).toEqual([])
    }
  })

  it('drops the tester never-list when a customer becomes a tester', () => {
    expect(codesKeptOnRoleChange(Role.CUSTOMER, Role.TESTER, customerSet)).toEqual([
      PERMISSIONS.AI_STUDIO_ACCESS,
    ])
  })

  it('keeps a tester grant set when a tester becomes a customer', () => {
    expect(codesKeptOnRoleChange(Role.TESTER, Role.CUSTOMER, testerSet)).toEqual(testerSet)
  })

  it('keeps AI Studio grants when a customer or tester becomes a sub-admin', () => {
    expect(codesKeptOnRoleChange(Role.CUSTOMER, Role.SUB_ADMIN, customerSet)).toEqual(customerSet)
  })

  it('drops everything when the new role holds nothing explicitly', () => {
    expect(codesKeptOnRoleChange(Role.CUSTOMER, Role.ADMIN, customerSet)).toEqual([])
    expect(codesKeptOnRoleChange(Role.TESTER, Role.USER, testerSet)).toEqual([])
  })
})
