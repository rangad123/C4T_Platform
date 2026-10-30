import { beforeAll, describe, expect, it, vi } from 'vitest'

// Read by config/env.ts at import time, so it is set before the app loads.
const TOKEN = vi.hoisted(() => {
  const token = 'integration-test-service-token-0123456789'
  process.env.AI_STUDIO_SERVICE_TOKEN = token
  return token
})

import { resetDatabase, seedWorld, type World } from '../helpers/fixtures.js'
import { Client, anon } from '../helpers/client.js'

/**
 * AI Studio access, end to end against the test database:
 *
 *   - customers and testers can now hold `ai_studio.*` grants, and see them
 *     in `/auth/me`, which is how AI Studio reads them;
 *   - the never-lists are refused by the API, not only hidden;
 *   - an AI Studio grant does not open any of this API's own admin routes;
 *   - the `/v1/ai-studio` reads answer to the service token and nothing else.
 */

let world: World
let admin: Client
let tester: Client
let customer: Client

beforeAll(async () => {
  await resetDatabase()
  world = await seedWorld()
  ;[admin, tester, customer] = await Promise.all([
    Client.signIn(world.admin.email),
    Client.signIn(world.testerActive.email),
    Client.signIn(world.customerA.email),
  ])
}, 60_000)

function service(path: string) {
  return anon().get(path).set('authorization', `Bearer ${TOKEN}`)
}

describe('granting AI Studio features', () => {
  it('gives a tester AI Studio features, visible in /auth/me', async () => {
    const response = await admin.put(`/v1/users/${world.testerActive.id}/permissions`, {
      permissionCodes: ['ai_studio.access', 'ai_studio.tests.run'],
      scope: 'ai_studio',
    })
    expect(response.status).toBe(200)

    const me = await tester.get('/v1/auth/me')
    expect(me.body.data.user.permissions.sort()).toEqual([
      'ai_studio.access',
      'ai_studio.tests.run',
    ])
  })

  it('refuses a tester the usage view with a clear message', async () => {
    const response = await admin.put(`/v1/users/${world.testerActive.id}/permissions`, {
      permissionCodes: ['ai_studio.usage.view'],
      scope: 'ai_studio',
    })
    expect(response.status).toBe(400)
    expect(response.body.error.message).toBe('This feature cannot be given to a tester.')
  })

  it('refuses a customer the platform settings, and any back-office code', async () => {
    const settings = await admin.put(`/v1/users/${world.customerA.id}/permissions`, {
      permissionCodes: ['ai_studio.platform.settings'],
    })
    expect(settings.status).toBe(400)

    const backOffice = await admin.put(`/v1/users/${world.customerA.id}/permissions`, {
      permissionCodes: ['project.read'],
    })
    expect(backOffice.status).toBe(400)
  })

  it('does not let an AI Studio grant open the admin API', async () => {
    await admin.put(`/v1/users/${world.customerA.id}/permissions`, {
      permissionCodes: ['ai_studio.access', 'ai_studio.usage.view'],
      scope: 'ai_studio',
    })
    const response = await customer.get('/v1/users')
    expect(response.status).toBe(403)
  })

  it('keeps a sub-admin back-office grants when only AI Studio is saved', async () => {
    const before = await admin.get(`/v1/users/${world.subAdminLimited.id}/permissions`)
    const backOffice = (before.body.data as { code: string }[]).map((p) => p.code)

    await admin.put(`/v1/users/${world.subAdminLimited.id}/permissions`, {
      permissionCodes: ['ai_studio.access'],
      scope: 'ai_studio',
    })
    const after = await admin.get(`/v1/users/${world.subAdminLimited.id}/permissions`)
    expect((after.body.data as { code: string }[]).map((p) => p.code).sort()).toEqual(
      [...backOffice, 'ai_studio.access'].sort(),
    )
  })

  it('offers a tester only the codes a tester may hold', async () => {
    const response = await admin.get('/v1/users/permissions/catalogue?grantableTo=TESTER')
    const codes = (response.body.data as { code: string }[]).map((p) => p.code)
    expect(codes).toHaveLength(11)
    expect(codes).not.toContain('ai_studio.usage.view')
  })

  it('drops what a tester may not hold when a customer becomes a tester', async () => {
    const id = world.customerAMember.id
    await admin.put(`/v1/users/${id}/permissions`, {
      permissionCodes: ['ai_studio.access', 'ai_studio.usage.view'],
      scope: 'ai_studio',
    })
    const response = await admin.post(`/v1/users/${id}/role`, { role: 'TESTER' })
    expect(response.status).toBe(200)

    const after = await admin.get(`/v1/users/${id}/permissions`)
    expect((after.body.data as { code: string }[]).map((p) => p.code)).toEqual(['ai_studio.access'])
  })
})

describe('/v1/ai-studio service reads', () => {
  it('refuses a user session, even an administrator', async () => {
    const response = await admin.get('/v1/ai-studio/organisations')
    expect(response.status).toBe(401)
  })

  it('lists organisations with id, name and status only', async () => {
    const response = await service('/v1/ai-studio/organisations')
    expect(response.status).toBe(200)
    const orgA = (response.body.data as Record<string, unknown>[]).find(
      (org) => org.id === world.orgA.id,
    )
    expect(Object.keys(orgA!).sort()).toEqual(['id', 'name', 'status'])
  })

  it("lists an organisation's projects", async () => {
    const response = await service(`/v1/ai-studio/organisations/${world.orgA.id}/projects`)
    expect(response.status).toBe(200)
    expect(response.body.data).toContainEqual(
      expect.objectContaining({ id: world.projectA.id, reference: world.projectA.reference }),
    )
    expect(response.body.data).not.toContainEqual(
      expect.objectContaining({ id: world.projectB.id }),
    )
  })

  it('answers 404 for an unknown organisation', async () => {
    const response = await service('/v1/ai-studio/organisations/does-not-exist/projects')
    expect(response.status).toBe(404)
  })

  it('searches people by kind and organisation', async () => {
    const response = await service(
      `/v1/ai-studio/people?kind=CUSTOMER&organisationId=${world.orgA.id}`,
    )
    expect(response.status).toBe(200)
    const people = response.body.data as { id: string; kind: string; organisationId: string }[]
    expect(people.length).toBeGreaterThan(0)
    expect(people.length).toBeLessThanOrEqual(20)
    for (const person of people) {
      expect(person.kind).toBe('CUSTOMER')
      expect(person.organisationId).toBe(world.orgA.id)
    }
  })
})
