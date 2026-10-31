import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { FileScope, Role, TransactionType } from '@prisma/client'
import { prisma } from '../../src/lib/prisma.js'
import { listLeads } from '../../src/modules/hrms/hr-crm-leads.service.js'
import { listLeadsQuery } from '../../src/modules/hrms/hr-crm-leads.schema.js'
import { resetDatabase, seedWorld, type World } from '../helpers/fixtures.js'
import { Client } from '../helpers/client.js'

/**
 * A query filter must never widen what a caller can read, a `user.write` holder
 * must never reach an administrator, and a scope is not the client's to choose.
 *
 * The first group exists because `{ ...scope, ...filters }` lets a filter on the
 * same key replace the scope, so `?counterpartyId=<someone else>` read that
 * person's payment records. Each read is asserted from three sides: the attack
 * is refused, the caller's own rows still come back, and an admin's filter still
 * works, because the lazy fix (drop the filter) passes the first check alone.
 */

let world: World
let admin: Client
let subAdminFull: Client
let subAdminLimited: Client
let customerA: Client
let customerAMember: Client
let customerB: Client
let testerActive: Client
let testerOther: Client

const ids = (body: { data: { id: string }[] }) => body.data.map((row) => row.id)

beforeAll(async () => {
  await resetDatabase()
  world = await seedWorld()
  ;[
    admin,
    subAdminFull,
    subAdminLimited,
    customerA,
    customerAMember,
    customerB,
    testerActive,
    testerOther,
  ] = await Promise.all([
    Client.signIn(world.admin.email),
    Client.signIn(world.subAdminFull.email),
    Client.signIn(world.subAdminLimited.email),
    Client.signIn(world.customerA.email),
    Client.signIn(world.customerAMember.email),
    Client.signIn(world.customerB.email),
    Client.signIn(world.testerActive.email),
    Client.signIn(world.testerOther.email),
  ])
}, 60_000)

afterAll(async () => {
  await prisma.$disconnect()
})

describe('GET /v1/transactions — counterpartyId', () => {
  let mine: string
  let theirs: string

  beforeAll(async () => {
    const record = (reference: string, counterpartyId: string) =>
      prisma.transaction.create({
        data: {
          reference,
          type: TransactionType.TESTER_EARNING,
          amountMinor: 50_000n,
          counterpartyId,
          recordedById: world.admin.id,
          occurredAt: new Date(),
        },
        select: { id: true },
      })
    mine = (await record('TXN-TEST-0001', world.testerActive.id)).id
    theirs = (await record('TXN-TEST-0002', world.testerOther.id)).id
  })

  it("does not show a tester another tester's records", async () => {
    const res = await testerActive.get(`/v1/transactions?counterpartyId=${world.testerOther.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
    expect(res.body.meta.totalsByType).toEqual([])
  })

  it('still returns a tester their own records, filtered or not', async () => {
    const plain = await testerActive.get('/v1/transactions')
    expect(ids(plain.body)).toEqual([mine])
    const filtered = await testerActive.get(
      `/v1/transactions?counterpartyId=${world.testerActive.id}`,
    )
    expect(ids(filtered.body)).toEqual([mine])
  })

  it("does not show a tester's records to a customer who only asks for them", async () => {
    const res = await customerA.get(`/v1/transactions?counterpartyId=${world.testerOther.id}`)
    expect(res.body.data).toEqual([])
  })

  it("still applies an admin's filter", async () => {
    const res = await admin.get(`/v1/transactions?counterpartyId=${world.testerOther.id}`)
    expect(ids(res.body)).toEqual([theirs])
  })
})

describe('GET /v1/projects — testerId', () => {
  it("does not show a tester a project through another tester's roster row", async () => {
    const res = await testerActive.get(`/v1/projects?testerId=${world.testerOther.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('still returns a tester their own projects, filtered or not', async () => {
    expect(ids((await testerActive.get('/v1/projects')).body)).toEqual([world.projectA.id])
    const filtered = await testerActive.get(`/v1/projects?testerId=${world.testerActive.id}`)
    expect(ids(filtered.body)).toEqual([world.projectA.id])
  })

  it("still applies an admin's filter", async () => {
    const res = await admin.get(`/v1/projects?testerId=${world.testerOther.id}`)
    expect(ids(res.body)).toEqual([world.projectB.id])
  })
})

describe('GET /v1/badges/awards — testerUserId', () => {
  let mine: string
  let theirs: string

  beforeAll(async () => {
    const badge = await prisma.badge.create({
      data: { slug: 'scope-test', name: 'Scope test' },
      select: { id: true },
    })
    const award = (testerId: string, projectId: string) =>
      prisma.testerBadge.create({
        data: { badgeId: badge.id, testerId, projectId, awardedById: world.admin.id },
        select: { id: true },
      })
    mine = (await award(world.testerActive.id, world.projectA.id)).id
    theirs = (await award(world.testerOther.id, world.projectB.id)).id
  })

  it("does not show a tester another tester's awards", async () => {
    const res = await testerActive.get(`/v1/badges/awards?testerUserId=${world.testerOther.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('still returns a tester their own', async () => {
    const res = await testerActive.get(`/v1/badges/awards?testerUserId=${world.testerActive.id}`)
    expect(ids(res.body)).toEqual([mine])
  })

  it("still applies an admin's filter", async () => {
    const res = await admin.get(`/v1/badges/awards?testerUserId=${world.testerOther.id}`)
    expect(ids(res.body)).toEqual([theirs])
  })
})

describe('CRM leads — assignedToId', () => {
  it("does not show an employee a colleague's leads", async () => {
    const employee = (code: string) =>
      prisma.hrEmployee.create({
        data: {
          employeeCode: code,
          firstName: code,
          lastName: 'Test',
          email: `${code}@test.local`,
          passwordHash: 'unused',
          joiningDate: new Date(),
        },
        select: { id: true },
      })
    const [one, two] = [await employee('emp-one'), await employee('emp-two')]
    const lead = (companyName: string, assignedToId: string) =>
      prisma.crmLead.create({
        data: { companyName, createdById: assignedToId, assignedToId },
        select: { id: true },
      })
    const own = await lead('Own Ltd', one.id)
    const theirs = await lead('Theirs Ltd', two.id)
    const askingFor = listLeadsQuery.parse({ assignedToId: two.id })

    const attack = await listLeads({ id: one.id, role: 'EMPLOYEE' }, askingFor)
    expect(attack.items).toEqual([])

    const plain = await listLeads({ id: one.id, role: 'EMPLOYEE' }, listLeadsQuery.parse({}))
    expect(plain.items.map((row) => row.id)).toEqual([own.id])

    const manager = await listLeads({ id: one.id, role: 'MANAGER' }, askingFor)
    expect(manager.items.map((row) => row.id)).toEqual([theirs.id])
  })
})

describe('GET /v1/ratings', () => {
  let onA: string
  let hiddenOnA: string
  let onB: string

  beforeAll(async () => {
    const rate = (data: {
      authorId: string
      subjectUserId: string
      projectId: string
      isVisible?: boolean
    }) =>
      prisma.rating.create({
        data: { ...data, subjectType: 'TESTER', score: 4 },
        select: { id: true },
      })
    onA = (
      await rate({
        authorId: world.customerA.id,
        subjectUserId: world.testerActive.id,
        projectId: world.projectA.id,
      })
    ).id
    hiddenOnA = (
      await rate({
        authorId: world.admin.id,
        subjectUserId: world.testerActive.id,
        projectId: world.projectA.id,
        isVisible: false,
      })
    ).id
    onB = (
      await rate({
        authorId: world.customerB.id,
        subjectUserId: world.testerOther.id,
        projectId: world.projectB.id,
      })
    ).id
  })

  it('shows a tester nothing about somebody else, however they ask', async () => {
    expect(ids((await testerOther.get('/v1/ratings')).body)).toEqual([onB])
    const res = await testerOther.get(`/v1/ratings?subjectUserId=${world.testerActive.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it("does not show a customer ratings on another organisation's project", async () => {
    const res = await customerB.get(`/v1/ratings?projectId=${world.projectA.id}`)
    expect(res.body.data).toEqual([])
  })

  it('still shows the subject, the author and the project their ratings', async () => {
    expect(ids((await testerActive.get('/v1/ratings')).body)).toEqual([onA])
    expect(ids((await customerA.get(`/v1/ratings?projectId=${world.projectA.id}`)).body)).toEqual([
      onA,
    ])
    expect(
      ids((await customerAMember.get(`/v1/ratings?projectId=${world.projectA.id}`)).body),
    ).toEqual([onA])
  })

  it('keeps hidden ratings and filters working for the admin side', async () => {
    const res = await admin.get(`/v1/ratings?subjectUserId=${world.testerActive.id}`)
    expect(ids(res.body).sort()).toEqual([onA, hiddenOnA].sort())
  })
})

describe('users — only an ADMIN touches an ADMIN', () => {
  it('refuses a sub-admin promoting themselves', async () => {
    const res = await subAdminFull.post(`/v1/users/${world.subAdminFull.id}/role`, {
      role: 'ADMIN',
    })
    expect(res.status).toBe(403)
    const row = await prisma.user.findUnique({
      where: { id: world.subAdminFull.id },
      select: { role: true },
    })
    expect(row?.role).toBe(Role.SUB_ADMIN)
  })

  it('refuses a sub-admin creating an administrator', async () => {
    const res = await subAdminFull.post('/v1/users', {
      email: 'minted-admin@test.local',
      password: 'TestPassword!2026',
      role: 'ADMIN',
      firstName: 'Minted',
    })
    expect(res.status).toBe(403)
    expect(await prisma.user.count({ where: { email: 'minted-admin@test.local' } })).toBe(0)
  })

  it('refuses a sub-admin changing, suspending or deleting an administrator', async () => {
    const target = `/v1/users/${world.admin.id}`
    expect((await subAdminFull.patch(target, { firstName: 'Mallory' })).status).toBe(403)
    expect((await subAdminFull.post(`${target}/role`, { role: 'TESTER' })).status).toBe(403)
    expect((await subAdminFull.post(`${target}/status`, { status: 'SUSPENDED' })).status).toBe(403)
    expect((await subAdminFull.delete(target)).status).toBe(403)

    const row = await prisma.user.findUnique({
      where: { id: world.admin.id },
      select: { firstName: true, role: true, status: true, deletedAt: true },
    })
    expect(row).toMatchObject({ firstName: 'Admin', role: Role.ADMIN, status: 'ACTIVE' })
    expect(row?.deletedAt).toBeNull()
  })

  it('leaves a sub-admin able to manage everybody else', async () => {
    const res = await subAdminFull.post(`/v1/users/${world.testerUnassigned.id}/status`, {
      status: 'SUSPENDED',
    })
    expect(res.status).toBe(200)
    await admin.post(`/v1/users/${world.testerUnassigned.id}/status`, { status: 'ACTIVE' })
  })

  it('lets an ADMIN promote, by either route', async () => {
    const promoted = await admin.post(`/v1/users/${world.testerUnassigned.id}/role`, {
      role: 'ADMIN',
    })
    expect(promoted.status).toBe(200)
    expect(promoted.body.data.role).toBe('ADMIN')
    await admin.post(`/v1/users/${world.testerUnassigned.id}/role`, { role: 'TESTER' })

    const created = await admin.post('/v1/users', {
      email: 'real-admin@test.local',
      password: 'TestPassword!2026',
      role: 'ADMIN',
      firstName: 'Real',
    })
    expect(created.status).toBe(201)
  })
})

describe('users — nobody grants what they do not hold', () => {
  let target: string

  const codes = async () =>
    (
      await prisma.userPermission.findMany({
        where: { userId: target },
        select: { permission: { select: { code: true } } },
      })
    )
      .map((grant) => grant.permission.code)
      .sort()

  beforeAll(async () => {
    // Enough to reach the routes, and nothing that writes money or the blog.
    const manage = await prisma.permission.findMany({
      where: { code: { in: ['user.write', 'subadmin.manage'] } },
      select: { id: true },
    })
    await prisma.userPermission.createMany({
      data: manage.map((p) => ({ userId: world.subAdminLimited.id, permissionId: p.id })),
    })
    const created = await admin.post('/v1/users', {
      email: 'grant-target@test.local',
      password: 'TestPassword!2026',
      role: 'SUB_ADMIN',
      firstName: 'Target',
      permissionCodes: ['project.read', 'blog.write'],
    })
    target = created.body.data.id as string
  })

  it('refuses a code the granter lacks and changes nothing', async () => {
    const res = await subAdminLimited.put(`/v1/users/${target}/permissions`, {
      permissionCodes: ['project.read', 'blog.write', 'transaction.write'],
    })
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).toContain('transaction.write')
    expect(await codes()).toEqual(['blog.write', 'project.read'])
  })

  it('allows a code the granter holds, and keeps one the target already has', async () => {
    const res = await subAdminLimited.put(`/v1/users/${target}/permissions`, {
      permissionCodes: ['project.read', 'blog.write', 'audit.read'],
    })
    expect(res.status).toBe(200)
    expect(await codes()).toEqual(['audit.read', 'blog.write', 'project.read'])
  })

  it('refuses the same grant through POST /users', async () => {
    const base = { password: 'TestPassword!2026', role: 'SUB_ADMIN', firstName: 'New' }
    const refused = await subAdminLimited.post('/v1/users', {
      ...base,
      email: 'new-sub-1@test.local',
      permissionCodes: ['transaction.write'],
    })
    expect(refused.status).toBe(403)
    const allowed = await subAdminLimited.post('/v1/users', {
      ...base,
      email: 'new-sub-2@test.local',
      permissionCodes: ['project.read'],
    })
    expect(allowed.status).toBe(201)
  })

  it('refuses the default grant set when it goes beyond the granter', async () => {
    const res = await subAdminLimited.post(`/v1/users/${world.testerUnassigned.id}/role`, {
      role: 'SUB_ADMIN',
    })
    expect(res.status).toBe(403)
  })

  it('lets an ADMIN grant anything', async () => {
    const res = await admin.put(`/v1/users/${target}/permissions`, {
      permissionCodes: ['transaction.write'],
    })
    expect(res.status).toBe(200)
    expect(await codes()).toEqual(['transaction.write'])
  })
})

describe('POST /v1/uploads/presign — scope', () => {
  const presign = (client: Client, scope: FileScope, mimeType = 'image/png') =>
    client.post('/v1/uploads/presign', {
      scope,
      originalName: 'file.png',
      mimeType,
      sizeBytes: 10,
    })

  it('refuses a tester the public blog scope and reserves nothing', async () => {
    const res = await presign(testerActive, FileScope.BLOG_FEATURED_IMAGE)
    expect(res.status).toBe(403)
    expect(await prisma.fileObject.count({ where: { uploadedById: testerActive.userId } })).toBe(0)
  })

  it('refuses a customer the public blog scope', async () => {
    expect((await presign(customerA, FileScope.BLOG_FEATURED_IMAGE)).status).toBe(403)
  })

  it('refuses a sub-admin who cannot write the blog', async () => {
    expect((await presign(subAdminLimited, FileScope.BLOG_FEATURED_IMAGE)).status).toBe(403)
  })

  it('allows those who can write the blog', async () => {
    expect((await presign(admin, FileScope.BLOG_FEATURED_IMAGE)).status).toBe(201)
    expect((await presign(subAdminFull, FileScope.BLOG_FEATURED_IMAGE)).status).toBe(201)
  })

  it('keeps each role to the scopes its web route uses', async () => {
    const allowed: [Client, FileScope][] = [
      [testerActive, FileScope.AVATAR],
      [testerActive, FileScope.TESTER_DOCUMENT],
      [testerActive, FileScope.BUG_ATTACHMENT],
      [customerA, FileScope.PROJECT_LOGO],
      [customerA, FileScope.PROJECT_MATERIAL],
      [admin, FileScope.PLATFORM_DOCUMENT],
      [admin, FileScope.PROJECT_LOGO],
      [subAdminLimited, FileScope.PROJECT_MATERIAL],
    ]
    for (const [client, scope] of allowed) {
      expect((await presign(client, scope)).status, `${client.email} ${scope}`).toBe(201)
    }
    const refused: [Client, FileScope][] = [
      [testerActive, FileScope.PLATFORM_DOCUMENT],
      [testerActive, FileScope.PROJECT_MATERIAL],
      [customerA, FileScope.PLATFORM_DOCUMENT],
      [customerA, FileScope.BUG_ATTACHMENT],
      [admin, FileScope.OTHER],
    ]
    for (const [client, scope] of refused) {
      expect((await presign(client, scope)).status, `${client.email} ${scope}`).toBe(403)
    }
  })
})
