import { beforeAll, describe, expect, it } from 'vitest'
import { PaymentAccountCountry, PaymentMethod, TransactionType } from '@prisma/client'
import { prisma } from '../../src/lib/prisma.js'
import { resetDatabase, seedWorld, type World } from '../helpers/fixtures.js'
import { Client } from '../helpers/client.js'

/**
 * A tester's money through its three places: a credit lands in "Available to
 * withdraw", a request moves it to "Already requested", and the admin's
 * transfer moves it to "Paid out". A transfer is only ever recorded against
 * the tester's request, from whichever admin page it is recorded.
 */

let world: World
let admin: Client
let tester: Client
let testerId: string

interface Wallet {
  availableMinor: string
  creditedMinor: string
  paidOutMinor: string
  requestedMinor: string
  openRequest: { id: string; amountMinor: string } | null
}

async function wallet(): Promise<Wallet> {
  const res = await admin.get(`/v1/transactions/payouts/${testerId}`)
  expect(res.status).toBe(200)
  return res.body.data as Wallet
}

function credit(amountMinor: number) {
  return admin.post('/v1/transactions', {
    type: TransactionType.TESTER_EARNING,
    amountMinor,
    counterpartyId: testerId,
  })
}

/** A transfer as the tester's page records it: no request named. */
function transfer(amountMinor: number, extra: Record<string, unknown> = {}) {
  return admin.post('/v1/transactions', {
    type: TransactionType.TESTER_PAYOUT,
    amountMinor,
    counterpartyId: testerId,
    ...extra,
  })
}

beforeAll(async () => {
  await resetDatabase()
  world = await seedWorld()
  testerId = world.testerUnassigned.id
  ;[admin, tester] = await Promise.all([
    Client.signIn(world.admin.email),
    Client.signIn(world.testerUnassigned.email),
  ])
  await prisma.paymentAccount.create({
    data: {
      userId: testerId,
      country: PaymentAccountCountry.INDIAN,
      paymentType: PaymentMethod.IND_BANK_ACCOUNT,
      secureDetails: Buffer.from('opaque'),
    },
  })
})

describe('credit, request, transfer', () => {
  it('a credit lands in Available to withdraw and Credited total', async () => {
    expect((await credit(100_000)).status).toBe(201)
    expect(await wallet()).toMatchObject({
      availableMinor: '100000',
      creditedMinor: '100000',
      requestedMinor: '0',
      paidOutMinor: '0',
      openRequest: null,
    })
  })

  it('a transfer nobody asked for is refused', async () => {
    const res = await transfer(100_000)
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/has not requested a payout/)
    expect((await wallet()).paidOutMinor).toBe('0')
  })

  it('a request moves the amount from Available to Already requested', async () => {
    expect((await tester.post('/v1/transactions/payouts/request', {})).status).toBe(201)
    expect(await wallet()).toMatchObject({
      availableMinor: '0',
      requestedMinor: '100000',
      paidOutMinor: '0',
    })
  })

  it('a transfer for more than was asked is refused', async () => {
    expect((await transfer(100_001)).status).toBe(400)
  })

  it('a transfer from the tester page settles the request: Already requested moves to Paid out', async () => {
    const res = await transfer(100_000)
    expect(res.status).toBe(201)
    const w = await wallet()
    expect(w).toMatchObject({
      availableMinor: '0',
      creditedMinor: '100000',
      requestedMinor: '0',
      paidOutMinor: '100000',
      openRequest: null,
    })
    const request = await prisma.payoutRequest.findFirstOrThrow({ where: { testerId } })
    expect(request.fulfilledByTransactionId).toBe(res.body.data.id)
  })

  it('the same transfer cannot be recorded twice', async () => {
    expect((await transfer(100_000)).status).toBe(400)
    expect((await wallet()).paidOutMinor).toBe('100000')
  })

  it('a transfer for less than was asked closes the request and the rest is available again', async () => {
    await credit(80_000)
    expect((await tester.post('/v1/transactions/payouts/request', {})).status).toBe(201)
    expect((await wallet()).requestedMinor).toBe('80000')
    expect((await transfer(60_000)).status).toBe(201)
    expect(await wallet()).toMatchObject({
      availableMinor: '20000',
      requestedMinor: '0',
      paidOutMinor: '160000',
    })
  })
})

describe('removing a payout recorded in error', () => {
  it('removes a duplicate that settled no request, and the wallet is right again', async () => {
    // A second copy of a transfer, as the old tester-page button recorded it.
    const duplicate = await prisma.transaction.create({
      data: {
        reference: 'TXN-DUP-0001',
        type: TransactionType.TESTER_PAYOUT,
        amountMinor: 100_000n,
        counterpartyId: testerId,
        recordedById: world.admin.id,
        occurredAt: new Date(),
      },
    })
    expect((await wallet()).paidOutMinor).toBe('260000')

    const res = await admin
      .delete(`/v1/transactions/${duplicate.id}`)
      .send({ reason: 'Recorded twice for one bank transfer' })
    expect(res.status).toBe(204)
    expect(await wallet()).toMatchObject({ availableMinor: '20000', paidOutMinor: '160000' })

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'transaction.payout_removed', entityId: duplicate.id },
    })
    expect(JSON.stringify(audit)).toContain('TXN-DUP-0001')
    expect(JSON.stringify(audit)).toContain('Recorded twice for one bank transfer')
  })

  it('keeps a payout that settled a request', async () => {
    const settled = await prisma.payoutRequest.findFirstOrThrow({
      where: { testerId, fulfilledByTransactionId: { not: null } },
    })
    const res = await admin
      .delete(`/v1/transactions/${settled.fulfilledByTransactionId}`)
      .send({ reason: 'Trying to remove the real one' })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/settled the tester/)
  })

  it('removes only payouts, and only with a reason', async () => {
    const earning = await prisma.transaction.findFirstOrThrow({
      where: { counterpartyId: testerId, type: TransactionType.TESTER_EARNING },
    })
    expect(
      (await admin.delete(`/v1/transactions/${earning.id}`).send({ reason: 'Not a payout' }))
        .status,
    ).toBe(400)

    const stray = await prisma.transaction.create({
      data: {
        reference: 'TXN-DUP-0002',
        type: TransactionType.TESTER_PAYOUT,
        amountMinor: 1_000n,
        counterpartyId: testerId,
        recordedById: world.admin.id,
        occurredAt: new Date(),
      },
    })
    const noReason = await admin.delete(`/v1/transactions/${stray.id}`).send({})
    expect(noReason.status).toBeGreaterThanOrEqual(400)
    expect(noReason.status).toBeLessThan(500)
    expect(await prisma.transaction.count({ where: { id: stray.id } })).toBe(1)
  })

  it('is closed to a tester and to an admin without transaction.write', async () => {
    const stray = await prisma.transaction.findFirstOrThrow({
      where: { reference: 'TXN-DUP-0002' },
    })
    const limited = await Client.signIn(world.subAdminLimited.email)
    for (const who of [tester, limited]) {
      const res = await who
        .delete(`/v1/transactions/${stray.id}`)
        .send({ reason: 'Not mine to remove' })
      expect(res.status).toBe(403)
    }
    expect(await prisma.transaction.count({ where: { id: stray.id } })).toBe(1)
  })
})
