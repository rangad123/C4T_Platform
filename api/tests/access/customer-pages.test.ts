import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { BugSeverity, BugStatus, RatingSubjectType, TransactionType } from '@prisma/client'
import { prisma } from '../../src/lib/prisma.js'
import { resetDatabase, seedWorld, type World } from '../helpers/fixtures.js'
import { Client } from '../helpers/client.js'

/**
 * The reads behind the customer Ratings and Transactions pages, and the
 * per-project bug analytics on both project dashboards.
 *
 * Each is asserted from both sides of the organisation wall: the owning
 * customer sees their rows, another organisation's customer and a tester see
 * nothing of them.
 */

let world: World
let admin: Client
let customerA: Client
let customerB: Client
let testerActive: Client

const ids = (body: { data: { id: string }[] }) => body.data.map((row) => row.id)

beforeAll(async () => {
  await resetDatabase()
  world = await seedWorld()
  ;[admin, customerA, customerB, testerActive] = await Promise.all([
    Client.signIn(world.admin.email),
    Client.signIn(world.customerA.email),
    Client.signIn(world.customerB.email),
    Client.signIn(world.testerActive.email),
  ])
}, 60_000)

afterAll(async () => {
  await prisma.$disconnect()
})

describe('GET /v1/reports/by-project/:projectId/bug-analytics', () => {
  const url = () => `/v1/reports/by-project/${world.projectA.id}/bug-analytics`

  beforeAll(async () => {
    // A second bug five weeks after the first, so the weekly series has gaps
    // to zero-fill, and a deleted one that must not count anywhere.
    const first = await prisma.bug.findUniqueOrThrow({
      where: { id: world.bugA.id },
      select: { createdAt: true },
    })
    const later = new Date(first.createdAt.getTime() + 35 * 24 * 60 * 60 * 1000)
    const base = {
      projectId: world.projectA.id,
      buildId: world.projectA.buildId,
      reportedById: world.testerActive.id,
      description: 'd',
      stepsToReproduce: 's',
    }
    await prisma.bug.create({
      data: {
        ...base,
        reference: 'BUG-TEST-0002',
        title: 'Second',
        severity: BugSeverity.LOW,
        status: BugStatus.CONFIRMED,
        createdAt: later,
      },
    })
    await prisma.bug.create({
      data: {
        ...base,
        reference: 'BUG-TEST-0003',
        title: 'Deleted',
        severity: BugSeverity.CRITICAL,
        deletedAt: new Date(),
      },
    })
  })

  it('gives the owning customer every cut of their project', async () => {
    const res = await customerA.get(url())
    expect(res.status).toBe(200)
    const data = res.body.data
    expect(data.total).toBe(2)
    expect(data.bySeverity).toEqual({ HIGH: 1, LOW: 1 })
    expect(data.byStatus).toEqual({ NEW: 1, CONFIRMED: 1 })
    expect(data.byBuild).toEqual([
      { id: world.projectA.buildId, name: expect.any(String), count: 2 },
    ])
    expect(data.byTester).toHaveLength(1)
    expect(data.byTester[0]).toMatchObject({ id: world.testerActive.id, count: 2 })
    expect(data.byTester[0]).not.toHaveProperty('email')
    expect(data.overTime.bucket).toBe('week')
    const points: { start: string; count: number }[] = data.overTime.points
    expect(points.reduce((sum, p) => sum + p.count, 0)).toBe(2)
    expect(points.length).toBeGreaterThanOrEqual(6)
    expect(points[0]!.count).toBe(1)
    expect(points[points.length - 1]!.count).toBe(1)
    expect(new Date(points[0]!.start).getUTCDay()).toBe(1)
  })

  it('works for an admin too', async () => {
    const res = await admin.get(url())
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(2)
  })

  it("gives another organisation's customer nothing", async () => {
    // 403, as the project report itself answers: the shared access check.
    const res = await customerB.get(url())
    expect(res.status).toBe(403)
    expect(res.body.data).toBeUndefined()
  })

  it('gives a tester nothing, even one active on the project', async () => {
    const res = await testerActive.get(url())
    expect(res.status).toBe(403)
    expect(res.body.data).toBeUndefined()
  })

  it('answers an empty project with zeroes, not an error', async () => {
    const res = await customerB.get(`/v1/reports/by-project/${world.projectB.id}/bug-analytics`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      total: 0,
      byBuild: [],
      byTester: [],
      overTime: { bucket: 'week', points: [] },
    })
  })
})

describe('GET /v1/transactions as a customer', () => {
  let onA: string
  let onB: string

  beforeAll(async () => {
    const record = (reference: string, organisationId: string, counterpartyId?: string) =>
      prisma.transaction.create({
        data: {
          reference,
          type: counterpartyId ? TransactionType.TESTER_PAYOUT : TransactionType.CUSTOMER_INVOICE,
          amountMinor: 120_000n,
          organisationId,
          counterpartyId,
          recordedById: world.admin.id,
          occurredAt: new Date(),
        },
        select: { id: true },
      })
    onA = (await record('TXN-CUST-0001', world.orgA.id, world.testerActive.id)).id
    onB = (await record('TXN-CUST-0002', world.orgB.id)).id
  })

  it("lists only the customer's own organisation's rows, without the payee's email", async () => {
    const res = await customerA.get('/v1/transactions')
    expect(res.status).toBe(200)
    expect(ids(res.body)).toEqual([onA])
    expect(res.body.data[0].counterparty).not.toHaveProperty('email')
    expect(res.body.meta.totalsByType).toEqual([
      { type: 'TESTER_PAYOUT', currency: 'INR', amountMinor: '120000' },
    ])
  })

  it("does not widen to another organisation's rows through a filter", async () => {
    const res = await customerA.get(`/v1/transactions?organisationId=${world.orgB.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
    expect(ids((await customerB.get('/v1/transactions')).body)).toEqual([onB])
  })

  it("does not show a tester the organisation's invoices", async () => {
    const res = await testerActive.get('/v1/transactions?type=CUSTOMER_INVOICE')
    expect(res.body.data ?? []).toEqual([])
  })
})

describe('GET /v1/ratings as a customer', () => {
  let onA: string

  beforeAll(async () => {
    onA = (
      await prisma.rating.create({
        data: {
          subjectType: RatingSubjectType.PROJECT,
          projectId: world.projectA.id,
          authorId: world.testerActive.id,
          score: 4,
        },
        select: { id: true },
      })
    ).id
    await prisma.rating.create({
      data: {
        subjectType: RatingSubjectType.PROJECT,
        projectId: world.projectA.id,
        authorId: world.testerActive.id,
        score: 1,
        isVisible: false,
      },
    })
  })

  it('shows the owning customer the visible ratings on their project', async () => {
    const res = await customerA.get(`/v1/ratings?projectId=${world.projectA.id}`)
    expect(res.status).toBe(200)
    expect(ids(res.body)).toEqual([onA])
  })

  it("shows another organisation's customer none of them", async () => {
    const res = await customerB.get(`/v1/ratings?projectId=${world.projectA.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })
})

describe('POST /v1/ratings about a customer', () => {
  it('links the customer to their own portal, not the tester one', async () => {
    const res = await testerActive.post('/v1/ratings', {
      subjectType: 'CUSTOMER',
      subjectUserId: world.customerA.id,
      projectId: world.projectA.id,
      score: 5,
    })
    expect(res.status).toBe(201)
    const note = await prisma.notification.findFirstOrThrow({
      where: { userId: world.customerA.id, type: 'RATING_RECEIVED' },
      select: { link: true },
    })
    expect(note.link).toBe('/app/customer/ratings')
  })
})
