import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { Request } from 'express'
import {
  BugSeverity,
  FileScope,
  PaymentAccountCountry,
  PaymentMethod,
  Role,
  TransactionType,
  UserStatus,
} from '@prisma/client'
import { prisma } from '../../src/lib/prisma.js'
import { hashPassword } from '../../src/lib/password.js'
import { clientAddress } from '../../src/lib/http.js'
import { signInWithGoogle } from '../../src/modules/auth/auth.service.js'
import { PERMISSIONS } from '../../src/config/permissions.js'
import { PASSWORD, resetDatabase, seedWorld, type World } from '../helpers/fixtures.js'
import { Client, anon } from '../helpers/client.js'

/**
 * Follow-ups from the security audit of the public repository: each block is
 * one finding, asserted from both sides (the hole is shut, the legitimate use
 * still works).
 */

let world: World
let admin: Client
let subAdminLimited: Client
let customerA: Client
let testerActive: Client

let fileSeq = 0
async function makeFile(uploadedById: string, scope: FileScope = FileScope.PROJECT_MATERIAL) {
  fileSeq += 1
  return prisma.fileObject.create({
    data: {
      scope,
      storageKey: `test/audit-followups/${fileSeq}`,
      driver: 'local',
      originalName: `file-${fileSeq}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 10,
      uploadedById,
      isComplete: true,
    },
    select: { id: true },
  })
}

async function makeSubAdmin(email: string, codes: string[]) {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(PASSWORD),
      role: Role.SUB_ADMIN,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
      firstName: 'Sub',
      lastName: 'Test',
    },
    select: { id: true },
  })
  const permissions = await prisma.permission.findMany({
    where: { code: { in: codes } },
    select: { id: true },
  })
  await prisma.userPermission.createMany({
    data: permissions.map((p) => ({ userId: user.id, permissionId: p.id })),
  })
  return user
}

beforeAll(async () => {
  await resetDatabase()
  world = await seedWorld()
  ;[admin, subAdminLimited, customerA, testerActive] = await Promise.all([
    Client.signIn(world.admin.email),
    Client.signIn(world.subAdminLimited.email),
    Client.signIn(world.customerA.email),
    Client.signIn(world.testerActive.email),
  ])
}, 60_000)

afterAll(async () => {
  await prisma.$disconnect()
})

// ─── 1. Google sign-in into an account nobody verified ──────────────────────

describe('Google sign-in linking to an existing account', () => {
  async function accountWithPassword(email: string, verified: boolean) {
    return prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(PASSWORD),
        role: Role.TESTER,
        status: verified ? UserStatus.ACTIVE : UserStatus.PENDING,
        emailVerifiedAt: verified ? new Date() : null,
        firstName: 'Linked',
      },
      select: { id: true },
    })
  }

  it('drops the password and sessions of an unverified account the real owner claims', async () => {
    const email = 'claimed@test.local'
    const squatted = await accountWithPassword(email, false)
    const squatter = await Client.signIn(email)
    expect((await squatter.get('/v1/auth/me')).status).toBe(200)

    await signInWithGoogle(
      { subject: 'google-sub-claimed', email, emailVerified: true },
      Role.TESTER,
      {},
    )

    expect((await squatter.get('/v1/auth/me')).status).toBe(401)
    const login = await anon().post('/v1/auth/login').send({ email, password: PASSWORD })
    expect(login.status).toBe(401)
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: squatted.id },
      select: { passwordHash: true, emailVerifiedAt: true },
    })
    expect(row.passwordHash).toBeNull()
    expect(row.emailVerifiedAt).not.toBeNull()
  })

  it('leaves a verified account its password and sessions', async () => {
    const email = 'verified-owner@test.local'
    await accountWithPassword(email, true)
    const owner = await Client.signIn(email)

    await signInWithGoogle(
      { subject: 'google-sub-verified', email, emailVerified: true },
      Role.TESTER,
      {},
    )

    expect((await owner.get('/v1/auth/me')).status).toBe(200)
    const login = await anon().post('/v1/auth/login').send({ email, password: PASSWORD })
    expect(login.status).toBe(200)
  })
})

// ─── 2. x-c4t-client-ip only from the web server's own calls ────────────────

describe('clientAddress', () => {
  function fakeRequest(peer: string, headers: Record<string, string>): Request {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    return {
      ip: headers['x-forwarded-for']?.split(',').pop()?.trim() ?? peer,
      socket: { remoteAddress: peer },
      get: (name: string) => lower[name.toLowerCase()],
    } as unknown as Request
  }

  it("believes the web server's direct loopback call", () => {
    const req = fakeRequest('::ffff:127.0.0.1', { 'x-c4t-client-ip': '203.0.113.7' })
    expect(clientAddress(req)).toBe('203.0.113.7')
  })

  it('ignores the header on a request nginx forwarded from the internet', () => {
    const req = fakeRequest('127.0.0.1', {
      'x-c4t-client-ip': '203.0.113.7',
      'x-forwarded-for': '198.51.100.9',
    })
    expect(clientAddress(req)).toBe('198.51.100.9')
  })

  it('ignores the header from a peer that is not loopback', () => {
    const req = fakeRequest('198.51.100.9', { 'x-c4t-client-ip': '203.0.113.7' })
    expect(clientAddress(req)).toBe('198.51.100.9')
  })
})

// ─── 3. Sub-Admins read only what their permissions allow ───────────────────

describe('Sub-Admin reads follow their read permissions', () => {
  let noReads: Client
  let txId: string

  beforeAll(async () => {
    const user = await makeSubAdmin('sub-none@test.local', [])
    // A manager of project A: their own relation to it still counts.
    await prisma.managerAssignment.create({
      data: { managerId: user.id, projectId: world.projectA.id },
    })
    noReads = await Client.signIn('sub-none@test.local')
    txId = (
      await prisma.transaction.create({
        data: {
          reference: 'TXN-AUDIT-0001',
          type: TransactionType.TESTER_EARNING,
          amountMinor: 1_000n,
          counterpartyId: world.testerOther.id,
          recordedById: world.admin.id,
          occurredAt: new Date(),
        },
        select: { id: true },
      })
    ).id
  })

  it('without transaction.read: no transactions, list or single', async () => {
    const list = await noReads.get('/v1/transactions')
    expect(list.status).toBe(200)
    expect(list.body.data).toEqual([])
    expect((await noReads.get(`/v1/transactions/${txId}`)).status).toBe(404)
  })

  it('with transaction.read: the transactions are there', async () => {
    const list = await subAdminLimited.get('/v1/transactions')
    expect(list.body.data.map((t: { id: string }) => t.id)).toContain(txId)
    expect((await subAdminLimited.get(`/v1/transactions/${txId}`)).status).toBe(200)
  })

  it('without project.read: only the projects they manage', async () => {
    const list = await noReads.get('/v1/projects')
    expect(list.status).toBe(200)
    expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([world.projectA.id])
    const all = await subAdminLimited.get('/v1/projects')
    expect(all.body.data).toHaveLength(2)
  })

  it('without bug.read: only bugs on the projects they manage', async () => {
    const bugB = await prisma.bug.create({
      data: {
        reference: 'BUG-AUDIT-0002',
        projectId: world.projectB.id,
        buildId: world.projectB.buildId,
        reportedById: world.testerOther.id,
        title: 'Other project bug',
        description: 'x',
        stepsToReproduce: 'x',
        severity: BugSeverity.LOW,
      },
      select: { id: true },
    })
    const ids = (await noReads.get('/v1/bugs')).body.data.map((b: { id: string }) => b.id)
    expect(ids).toContain(world.bugA.id)
    expect(ids).not.toContain(bugB.id)
  })

  it('without organisation.read: no organisations', async () => {
    const list = await noReads.get('/v1/organisations')
    expect(list.status).toBe(200)
    expect(list.body.data).toEqual([])
    expect((await subAdminLimited.get('/v1/organisations')).body.data.length).toBe(2)
  })

  it('without communication.read: only threads they take part in', async () => {
    const theirs = await prisma.thread.create({
      data: {
        type: 'DIRECT',
        createdById: world.customerA.id,
        lastMessageAt: new Date(),
        participants: { create: [{ userId: world.customerA.id }] },
      },
      select: { id: true },
    })
    const list = await noReads.get('/v1/communication/threads')
    expect(list.status).toBe(200)
    expect(list.body.data.map((t: { id: string }) => t.id)).not.toContain(theirs.id)
    const all = await subAdminLimited.get('/v1/communication/threads')
    expect(all.body.data.map((t: { id: string }) => t.id)).toContain(theirs.id)
  })
})

describe('A Sub-Admin scoped to assigned projects', () => {
  let scoped: Client
  let fileOnA: string
  let fileOnB: string

  beforeAll(async () => {
    const user = await makeSubAdmin('sub-scoped@test.local', [
      PERMISSIONS.PROJECT_READ,
      PERMISSIONS.PROJECT_ASSIGN,
      PERMISSIONS.PROJECT_SCOPE_TO_ASSIGNED,
    ])
    await prisma.managerAssignment.create({
      data: { managerId: user.id, projectId: world.projectA.id },
    })
    scoped = await Client.signIn('sub-scoped@test.local')

    fileOnA = (await makeFile(world.customerA.id)).id
    fileOnB = (await makeFile(world.customerB.id)).id
    await prisma.projectMaterial.createMany({
      data: [
        {
          projectId: world.projectA.id,
          buildId: world.projectA.buildId,
          title: 'A',
          fileId: fileOnA,
        },
        {
          projectId: world.projectB.id,
          buildId: world.projectB.buildId,
          title: 'B',
          fileId: fileOnB,
        },
      ],
    })
  })

  it('downloads files only from projects they manage', async () => {
    expect((await scoped.get(`/v1/uploads/${fileOnA}/download-url`)).status).toBe(200)
    expect((await scoped.get(`/v1/uploads/${fileOnB}/download-url`)).status).toBe(403)
    expect((await admin.get(`/v1/uploads/${fileOnB}/download-url`)).status).toBe(200)
  })

  it('staffs only projects they manage', async () => {
    const other = await scoped.post(`/v1/projects/${world.projectB.id}/assignments`, {
      testerIds: [world.testerUnassigned.id],
    })
    expect(other.status).toBe(403)
    const own = await scoped.post(`/v1/projects/${world.projectA.id}/assignments`, {
      testerIds: [world.testerUnassigned.id],
    })
    expect(own.status).toBeLessThan(300)
  })
})

// ─── 4. One payout request, however many arrive at once ─────────────────────

describe('POST /v1/transactions/payouts/request in parallel', () => {
  it('creates exactly one request', async () => {
    const tester = await Client.signIn(world.testerUnassigned.email)
    await prisma.paymentAccount.create({
      data: {
        userId: world.testerUnassigned.id,
        country: PaymentAccountCountry.INDIAN,
        paymentType: PaymentMethod.IND_BANK_ACCOUNT,
        secureDetails: Buffer.from('opaque'),
      },
    })
    await prisma.transaction.create({
      data: {
        reference: 'TXN-AUDIT-0100',
        type: TransactionType.TESTER_EARNING,
        amountMinor: 200_000n,
        counterpartyId: world.testerUnassigned.id,
        recordedById: world.admin.id,
        occurredAt: new Date(),
      },
    })

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        tester.post('/v1/transactions/payouts/request', { amountMinor: 60_000 }),
      ),
    )
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1)
    expect(responses.filter((r) => r.status === 400)).toHaveLength(3)
    expect(
      await prisma.payoutRequest.count({ where: { testerId: world.testerUnassigned.id } }),
    ).toBe(1)
  })
})

// ─── 5. The upload budget is per person ─────────────────────────────────────

describe('uploadLimiter', () => {
  it('keys on the signed-in user, not the shared address', async () => {
    for (let i = 0; i < 30; i += 1) {
      await customerA.post('/v1/uploads/presign', {})
    }
    expect((await customerA.post('/v1/uploads/presign', {})).status).toBe(429)
    // Same address (supertest), different person: their own budget.
    expect((await testerActive.post('/v1/uploads/presign', {})).status).not.toBe(429)
  })
})

// ─── 6. Smaller ones ────────────────────────────────────────────────────────

describe('a project creator’s email address', () => {
  it('is hidden from testers, list and detail', async () => {
    const detail = await testerActive.get(`/v1/projects/${world.projectA.id}`)
    expect(detail.status).toBe(200)
    expect(detail.body.data.createdBy.firstName).toBe('CustA')
    expect(detail.body.data.createdBy).not.toHaveProperty('email')
    const list = await testerActive.get('/v1/projects')
    for (const project of list.body.data) expect(project.createdBy).not.toHaveProperty('email')
  })

  it('is still shown to the customer', async () => {
    const detail = await customerA.get(`/v1/projects/${world.projectA.id}`)
    expect(detail.body.data.createdBy.email).toBe(world.customerA.email)
  })
})

describe('attaching a file to a project or build', () => {
  let someoneElses: string
  let mine: string

  beforeAll(async () => {
    someoneElses = (await makeFile(world.testerOther.id, FileScope.TESTER_DOCUMENT)).id
    mine = (await makeFile(world.customerA.id)).id
  })

  it('refuses a file the caller did not upload', async () => {
    const base = `/v1/projects/${world.projectA.id}`
    expect(
      (await customerA.post(`${base}/materials`, { title: 'x', fileId: someoneElses })).status,
    ).toBe(400)
    expect(
      (
        await customerA.patch(`${base}/builds/${world.projectA.buildId}`, {
          testDocumentFileId: someoneElses,
        })
      ).status,
    ).toBe(400)
    expect(
      (await customerA.post(`${base}/builds`, { name: 'B2', testDocumentFileId: someoneElses }))
        .status,
    ).toBe(400)
    expect((await admin.patch(base, { logoFileId: someoneElses })).status).toBe(400)
  })

  it('accepts their own, and a re-save of what is already attached', async () => {
    const base = `/v1/projects/${world.projectA.id}`
    expect((await customerA.post(`${base}/materials`, { title: 'x', fileId: mine })).status).toBe(
      201,
    )
    const build = `${base}/builds/${world.projectA.buildId}`
    expect((await customerA.patch(build, { testDocumentFileId: mine })).status).toBe(200)
    // An admin re-saving the build form that still carries the customer's file.
    expect((await admin.patch(build, { testDocumentFileId: mine })).status).toBe(200)
  })
})

describe('starting a conversation', () => {
  const start = (client: Client, participantIds: string[], projectId?: string) =>
    client.post('/v1/communication/threads', {
      type: projectId ? 'PROJECT' : 'DIRECT',
      projectId,
      participantIds,
      message: 'Hello',
    })

  it('a tester cannot open a thread with a stranger', async () => {
    expect((await start(testerActive, [world.customerB.id])).status).toBe(403)
    expect((await start(testerActive, [world.testerOther.id])).status).toBe(403)
  })

  it("a tester can still reach the project's people and the staff", async () => {
    expect((await start(testerActive, [world.customerA.id], world.projectA.id)).status).toBe(201)
    expect((await start(testerActive, [world.admin.id])).status).toBe(201)
  })
})
