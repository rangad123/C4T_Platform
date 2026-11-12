import { beforeAll, describe, expect, it } from 'vitest'
import { BuildStatus, TransactionType, WalletMove } from '@prisma/client'
import { prisma } from '../../src/lib/prisma.js'
import { resetDatabase, seedWorld, type World } from '../helpers/fixtures.js'
import { anon, Client } from '../helpers/client.js'

/**
 * Customer finance: an organisation's wallet (balance + locked), escrow per
 * build, plans, and the per-build tester reward.
 *
 * The money rules: every move is one ledger row in the same DB transaction as
 * the change to the two figures; a retried move (same key) never moves money
 * twice; neither figure goes below zero, even under concurrent requests; a
 * tester earning on a funded build draws from its lock; releasing a closed
 * build returns what is left to the balance, once.
 */

let world: World
let admin: Client
let subLimited: Client
let customerA: Client
let customerB: Client
let tester: Client

let keyCounter = 0
const newKey = () => `test-key-${Date.now()}-${++keyCounter}`

interface Wallet {
  currency: string
  balanceMinor: string
  lockedMinor: string
  builds: { id: string; remainingMinor: string; lockedTotalMinor: string; drawnMinor: string }[]
  currentPlan: { plan: { name: string } } | null
  history: {
    walletMove: string
    amountMinor: string
    counterparty: Record<string, unknown> | null
  }[]
}

async function wallet(orgId = world.orgA.id): Promise<Wallet> {
  const res = await admin.get(`/v1/org-finance/organisations/${orgId}`)
  expect(res.status).toBe(200)
  return res.body.data as Wallet
}

function topUp(amountMinor: number, key = newKey(), orgId = world.orgA.id) {
  return admin.post(`/v1/org-finance/organisations/${orgId}/top-ups`, { amountMinor, key })
}

function lock(amountMinor: number, key = newKey(), buildId = world.projectA.buildId) {
  return admin.post(`/v1/org-finance/builds/${buildId}/lock`, { amountMinor, key })
}

function earn(amountMinor: number, buildId = world.projectA.buildId) {
  return admin.post('/v1/transactions', {
    type: TransactionType.TESTER_EARNING,
    amountMinor,
    counterpartyId: world.testerActive.id,
    buildId,
  })
}

async function testerAvailable(): Promise<string> {
  const res = await admin.get(`/v1/transactions/payouts/${world.testerActive.id}`)
  expect(res.status).toBe(200)
  return res.body.data.creditedMinor as string
}

beforeAll(async () => {
  await resetDatabase()
  world = await seedWorld()
  ;[admin, subLimited, customerA, customerB, tester] = await Promise.all([
    Client.signIn(world.admin.email),
    Client.signIn(world.subAdminLimited.email),
    Client.signIn(world.customerA.email),
    Client.signIn(world.customerB.email),
    Client.signIn(world.testerActive.email),
  ])
})

describe('who can see and move an organisation wallet', () => {
  it('a customer reads their own wallet, never another organisation’s', async () => {
    expect((await customerA.get(`/v1/org-finance/organisations/${world.orgA.id}`)).status).toBe(200)
    expect((await customerA.get(`/v1/org-finance/organisations/${world.orgB.id}`)).status).toBe(404)
    const mine = await customerB.get('/v1/org-finance/mine')
    expect(mine.status).toBe(200)
    expect(
      mine.body.data.map((w: Wallet & { organisation: { id: string } }) => w.organisation.id),
    ).toEqual([world.orgB.id])
  })

  it('a tester and a signed-out caller get nothing', async () => {
    expect((await tester.get(`/v1/org-finance/organisations/${world.orgA.id}`)).status).toBe(403)
    expect((await tester.get('/v1/org-finance/mine')).status).toBe(403)
    expect((await anon().get(`/v1/org-finance/organisations/${world.orgA.id}`)).status).toBe(401)
  })

  it('only transaction.write records a move; a read-only sub-admin can read', async () => {
    expect((await subLimited.get(`/v1/org-finance/organisations/${world.orgA.id}`)).status).toBe(
      200,
    )
    const body = { amountMinor: 100, key: newKey() }
    for (const client of [subLimited, customerA, tester]) {
      expect(
        (await client.post(`/v1/org-finance/organisations/${world.orgA.id}/top-ups`, body)).status,
      ).toBe(403)
      expect(
        (await client.post(`/v1/org-finance/builds/${world.projectA.buildId}/lock`, body)).status,
      ).toBe(403)
      expect(
        (await client.post(`/v1/org-finance/builds/${world.projectA.buildId}/release`)).status,
      ).toBe(403)
      expect(
        (
          await client.put(`/v1/org-finance/builds/${world.projectA.buildId}/reward`, {
            testerRewardMinor: 100,
          })
        ).status,
      ).toBe(403)
      expect((await client.post('/v1/org-finance/plans', { name: 'Nope' })).status).toBe(403)
    }
    expect((await wallet()).balanceMinor).toBe('0')
  })
})

describe('top-up, lock, draw, release', () => {
  it('a top-up is a customer payment row and raises the balance once, however often it is retried', async () => {
    const key = newKey()
    const first = await topUp(100_000, key)
    expect(first.status).toBe(201)
    expect(first.body.data).toMatchObject({
      type: TransactionType.CUSTOMER_PAYMENT,
      walletMove: WalletMove.TOP_UP,
    })
    const retry = await topUp(100_000, key)
    expect(retry.status).toBe(200)
    expect(retry.body.meta.replayed).toBe(true)
    expect(retry.body.data.id).toBe(first.body.data.id)
    expect((await topUp(5, key)).status).toBe(409)
    expect(await wallet()).toMatchObject({ balanceMinor: '100000', lockedMinor: '0' })
  })

  it('refuses a top-up in another currency', async () => {
    const res = await admin.post(`/v1/org-finance/organisations/${world.orgA.id}/top-ups`, {
      amountMinor: 100,
      currency: 'USD',
      key: newKey(),
    })
    expect(res.status).toBe(400)
  })

  it('locking moves balance to locked, and a retried lock does not lock twice', async () => {
    const key = newKey()
    expect((await lock(30_000, key)).status).toBe(201)
    expect((await lock(30_000, key)).status).toBe(200)
    const w = await wallet()
    expect(w).toMatchObject({ balanceMinor: '70000', lockedMinor: '30000' })
    expect(w.builds.find((b) => b.id === world.projectA.buildId)?.remainingMinor).toBe('30000')
  })

  it('refuses to lock more than the balance, leaving both figures alone', async () => {
    const res = await lock(70_001)
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/more than the organisation has/)
    expect(await wallet()).toMatchObject({ balanceMinor: '70000', lockedMinor: '30000' })
  })

  it('a tester earning on the funded build draws from its lock; the tester wallet is credited as before', async () => {
    const before = BigInt(await testerAvailable())
    const res = await earn(10_000)
    expect(res.status).toBe(201)
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: res.body.data.id } })
    expect(row.walletMove).toBe(WalletMove.DRAW)
    expect(row.organisationId).toBe(world.orgA.id)
    expect(BigInt(await testerAvailable())).toBe(before + 10_000n)
    const w = await wallet()
    expect(w).toMatchObject({ balanceMinor: '70000', lockedMinor: '20000' })
    expect(w.builds.find((b) => b.id === world.projectA.buildId)).toMatchObject({
      drawnMinor: '10000',
      remainingMinor: '20000',
    })
  })

  it('refuses an earning bigger than what is left locked, and records nothing', async () => {
    const count = await prisma.transaction.count()
    const res = await earn(20_001)
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/more than is left locked/)
    expect(await prisma.transaction.count()).toBe(count)
    expect((await wallet()).lockedMinor).toBe('20000')
  })

  it('an earning on a build with nothing locked is recorded exactly as before', async () => {
    const res = await earn(5_000, world.projectB.buildId)
    expect(res.status).toBe(201)
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: res.body.data.id } })
    expect(row.walletMove).toBeNull()
    expect(row.organisationId).toBeNull()
    expect(await wallet(world.orgB.id)).toMatchObject({ balanceMinor: '0', lockedMinor: '0' })
  })

  it('release waits for the build to close, then returns the rest once', async () => {
    const release = () => admin.post(`/v1/org-finance/builds/${world.projectA.buildId}/release`)
    const early = await release()
    expect(early.status).toBe(400)
    expect(early.body.error.message).toMatch(/Close the build/)

    await prisma.build.update({
      where: { id: world.projectA.buildId },
      data: { status: BuildStatus.CLOSED },
    })
    const first = await release()
    expect(first.status).toBe(201)
    expect(first.body.data).toMatchObject({ walletMove: WalletMove.RELEASE, amountMinor: '20000' })
    const again = await release()
    expect(again.status).toBe(200)
    expect(again.body.data.id).toBe(first.body.data.id)
    expect(await wallet()).toMatchObject({ balanceMinor: '90000', lockedMinor: '0' })
  })

  it('after release, the build takes no more locks or earnings', async () => {
    expect((await lock(1_000)).status).toBe(400)
    expect((await earn(1_000)).status).toBe(400)
    expect(await wallet()).toMatchObject({ balanceMinor: '90000', lockedMinor: '0' })
  })

  it('the history has one row per move, and the figures add up from it', async () => {
    const w = await wallet()
    expect(w.history.map((h) => h.walletMove).sort()).toEqual(
      [WalletMove.DRAW, WalletMove.LOCK, WalletMove.RELEASE, WalletMove.TOP_UP].sort(),
    )
    const total = (move: string) =>
      w.history.filter((h) => h.walletMove === move).reduce((s, h) => s + BigInt(h.amountMinor), 0n)
    expect(BigInt(w.balanceMinor) + BigInt(w.lockedMinor)).toBe(
      total(WalletMove.TOP_UP) - total(WalletMove.DRAW),
    )
  })

  it('a customer sees their history without any tester email', async () => {
    const res = await customerA.get(`/v1/org-finance/organisations/${world.orgA.id}`)
    const draw = (res.body.data as Wallet).history.find((h) => h.walletMove === WalletMove.DRAW)
    expect(draw?.counterparty).toBeTruthy()
    expect(draw?.counterparty).not.toHaveProperty('email')
  })
})

describe('concurrency', () => {
  it('concurrent locks never take the balance below zero', async () => {
    // org B, build B: a fresh wallet of 50 000, eight concurrent locks of 10 000.
    expect((await topUp(50_000, newKey(), world.orgB.id)).status).toBe(201)
    const results = await Promise.all(
      Array.from({ length: 8 }, () => lock(10_000, newKey(), world.projectB.buildId)),
    )
    const statuses = results.map((r) => r.status).sort()
    expect(statuses.filter((s) => s === 201)).toHaveLength(5)
    expect(statuses.filter((s) => s === 400)).toHaveLength(3)
    expect(await wallet(world.orgB.id)).toMatchObject({ balanceMinor: '0', lockedMinor: '50000' })
  })

  it('the same lock sent concurrently is recorded once', async () => {
    expect((await topUp(10_000, newKey(), world.orgB.id)).status).toBe(201)
    const key = newKey()
    const results = await Promise.all(
      Array.from({ length: 5 }, () => lock(10_000, key, world.projectB.buildId)),
    )
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(true)
    expect(await prisma.transaction.count({ where: { walletKey: `lock:${key}` } })).toBe(1)
    expect(await wallet(world.orgB.id)).toMatchObject({ balanceMinor: '0', lockedMinor: '60000' })
  })

  it('concurrent earnings never draw more than is locked', async () => {
    // Build B now holds 60 000 (minus the earlier unlocked earning, which did not draw).
    const results = await Promise.all(
      Array.from({ length: 8 }, () => earn(10_000, world.projectB.buildId)),
    )
    expect(results.filter((r) => r.status === 201)).toHaveLength(6)
    expect(await wallet(world.orgB.id)).toMatchObject({ balanceMinor: '0', lockedMinor: '0' })
  })
})

describe('tester reward and plans', () => {
  it('an admin sets the per-bug reward and the tester sees it on the build', async () => {
    const set = await admin.put(`/v1/org-finance/builds/${world.projectA.buildId}/reward`, {
      testerRewardMinor: 75_000,
      rewardsCurrency: 'INR',
    })
    expect(set.status).toBe(200)
    const build = await tester.get(
      `/v1/projects/${world.projectA.id}/builds/${world.projectA.buildId}`,
    )
    expect(build.status).toBe(200)
    expect(build.body.data).toMatchObject({ testerRewardMinor: '75000', rewardsCurrency: 'INR' })

    const cleared = await admin.put(`/v1/org-finance/builds/${world.projectA.buildId}/reward`, {
      testerRewardMinor: null,
    })
    expect(cleared.body.data).toMatchObject({ testerRewardMinor: null, rewardsCurrency: null })
  })

  it('an admin defines plans and gives one to an organisation for a period', async () => {
    const created = await admin.post('/v1/org-finance/plans', {
      name: 'Managed',
      priceMinor: 5_000_000,
      projectsIncluded: 3,
    })
    expect(created.status).toBe(201)
    expect((await admin.post('/v1/org-finance/plans', { name: 'Managed' })).status).toBe(409)
    const planId = created.body.data.id as string

    const path = `/v1/org-finance/organisations/${world.orgA.id}/plans`
    expect(
      (await admin.post(path, { planId, startDate: '2026-05-01', endDate: '2026-04-01' })).status,
    ).toBe(400)
    const start = new Date(Date.now() - 86_400_000).toISOString()
    const end = new Date(Date.now() + 30 * 86_400_000).toISOString()
    expect((await admin.post(path, { planId, startDate: start, endDate: end })).status).toBe(201)

    const seen = await customerA.get(`/v1/org-finance/organisations/${world.orgA.id}`)
    expect(seen.body.data.currentPlan.plan.name).toBe('Managed')
    expect((await customerA.post(path, { planId, startDate: start })).status).toBe(403)

    const archived = await admin.patch(`/v1/org-finance/plans/${planId}`, { archived: true })
    expect(archived.status).toBe(200)
    expect((await admin.post(path, { planId, startDate: start })).status).toBe(400)
    const plans = await subLimited.get('/v1/org-finance/plans')
    expect(plans.status).toBe(200)
    expect(plans.body.data[0].archivedAt).not.toBeNull()
  })
})
