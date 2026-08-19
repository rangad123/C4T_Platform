import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { BugStatus } from '@prisma/client'
import { prisma } from '../../src/lib/prisma.js'
import { resetDatabase, seedWorld, type World } from '../helpers/fixtures.js'
import { Client } from '../helpers/client.js'

/**
 * The defect lifecycle, exercised over HTTP by the people who actually perform
 * each step:
 *
 *   tester reports → admin confirms → customer fixes → tester verifies
 *
 * The load-bearing assertion is that a customer CANNOT verify their own fix.
 * If they could, a customer could close every ticket without the tester ever
 * re-testing, and the engagement would be worthless.
 */

let world: World
let admin: Client
let customerA: Client
let customerB: Client
let testerActive: Client

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

/** Puts the shared bug back to NEW so each test starts from a known state. */
beforeEach(async () => {
  await prisma.bug.update({
    where: { id: world.bugA.id },
    data: { status: BugStatus.NEW, resolvedAt: null, triagedAt: null, duplicateOfId: null },
  })
})

async function statusOf(bugId: string): Promise<BugStatus> {
  const bug = await prisma.bug.findUniqueOrThrow({
    where: { id: bugId },
    select: { status: true },
  })
  return bug.status
}

describe('reporting', () => {
  it('an active tester can log a bug against their project', async () => {
    const response = await testerActive
      .post('/v1/bugs', {
        projectId: world.projectA.id,
        title: 'Search returns no results',
        description: 'Searching for a known product returns an empty list',
        stepsToReproduce: '1. Open search 2. Type "shoes" 3. Submit',
        severity: 'MEDIUM',
      })
      .expect(201)

    expect(response.body.data.status).toBe('NEW')
    expect(response.body.data.reference).toMatch(/^BUG-/)
  })

  it('a tester cannot log a bug against a project they are not on', async () => {
    await testerActive
      .post('/v1/bugs', {
        projectId: world.projectB.id,
        title: 'Should not be allowed',
        description: 'This tester has no assignment here',
        stepsToReproduce: '1. Try 2. Fail',
        severity: 'LOW',
      })
      .expect(403)
  })

  it('a customer cannot log a bug — they are not doing the testing', async () => {
    await customerA
      .post('/v1/bugs', {
        projectId: world.projectA.id,
        title: 'Customer-reported',
        description: 'Customers raise these through their account manager',
        stepsToReproduce: '1. n/a 2. n/a',
        severity: 'LOW',
      })
      .expect(403)
  })
})

describe('the happy path', () => {
  it('runs report → confirm → in progress → fixed → verified', async () => {
    // Admin triages.
    await admin
      .post(`/v1/bugs/${world.bugA.id}/status`, { status: 'CONFIRMED', note: 'Reproduced' })
      .expect(200)
    expect(await statusOf(world.bugA.id)).toBe(BugStatus.CONFIRMED)

    // Customer picks it up and ships a fix.
    await customerA.post(`/v1/bugs/${world.bugA.id}/status`, { status: 'IN_PROGRESS' }).expect(200)
    await customerA
      .post(`/v1/bugs/${world.bugA.id}/status`, { status: 'FIXED', note: 'Released in 2.4.1' })
      .expect(200)
    expect(await statusOf(world.bugA.id)).toBe(BugStatus.FIXED)

    // The tester who found it re-tests and closes it.
    await testerActive
      .post(`/v1/bugs/${world.bugA.id}/status`, { status: 'VERIFIED', note: 'Confirmed fixed' })
      .expect(200)
    expect(await statusOf(world.bugA.id)).toBe(BugStatus.VERIFIED)

    // The whole path is on the record.
    const detail = await admin.get(`/v1/bugs/${world.bugA.id}`).expect(200)
    const transitions = detail.body.data.statusHistory.map((h: { toStatus: string }) => h.toStatus)
    expect(transitions).toEqual(['NEW', 'CONFIRMED', 'IN_PROGRESS', 'FIXED', 'VERIFIED'])
  })
})

describe('the customer cannot mark their own work verified', () => {
  it('refuses a customer moving FIXED → VERIFIED', async () => {
    await admin.post(`/v1/bugs/${world.bugA.id}/status`, { status: 'CONFIRMED' }).expect(200)
    await customerA.post(`/v1/bugs/${world.bugA.id}/status`, { status: 'FIXED' }).expect(200)

    const response = await customerA
      .post(`/v1/bugs/${world.bugA.id}/status`, { status: 'VERIFIED' })
      .expect(409)

    expect(response.body.error.message).toContain('Cannot move this bug from FIXED to VERIFIED')
    expect(await statusOf(world.bugA.id)).toBe(BugStatus.FIXED)
  })

  it('but the customer may reopen it if the fix regresses', async () => {
    await admin.post(`/v1/bugs/${world.bugA.id}/status`, { status: 'CONFIRMED' }).expect(200)
    await customerA.post(`/v1/bugs/${world.bugA.id}/status`, { status: 'FIXED' }).expect(200)
    await customerA.post(`/v1/bugs/${world.bugA.id}/status`, { status: 'REOPENED' }).expect(200)
    expect(await statusOf(world.bugA.id)).toBe(BugStatus.REOPENED)
  })
})

describe('the customer can resolve a report without waiting for triage', () => {
  it('marks a brand-new report as a known duplicate', async () => {
    const other = await prisma.bug.create({
      data: {
        reference: 'BUG-TEST-DUP',
        projectId: world.projectA.id,
        buildId: world.projectA.buildId,
        reportedById: world.testerActive.id,
        title: 'Already known',
        description: 'x',
        stepsToReproduce: 'y',
        severity: 'LOW',
        status: BugStatus.CONFIRMED,
      },
      select: { id: true },
    })

    await customerA
      .post(`/v1/bugs/${world.bugA.id}/status`, {
        status: 'DUPLICATE',
        duplicateOfId: other.id,
        note: 'Same as BUG-TEST-DUP',
      })
      .expect(200)

    expect(await statusOf(world.bugA.id)).toBe(BugStatus.DUPLICATE)
  })

  it("marks it won't fix, with a mandatory reason", async () => {
    await customerA
      .post(`/v1/bugs/${world.bugA.id}/status`, { status: 'WONT_FIX', note: 'By design' })
      .expect(200)
    expect(await statusOf(world.bugA.id)).toBe(BugStatus.WONT_FIX)
  })

  it("rejects a won't-fix with no reason", async () => {
    await customerA.post(`/v1/bugs/${world.bugA.id}/status`, { status: 'WONT_FIX' }).expect(422)
  })
})

describe('transition guards', () => {
  it('refuses a nonsensical jump from NEW straight to VERIFIED', async () => {
    await admin.post(`/v1/bugs/${world.bugA.id}/status`, { status: 'VERIFIED' }).expect(409)
  })

  it('a customer from another organisation cannot touch the status', async () => {
    await customerB
      .post(`/v1/bugs/${world.bugA.id}/status`, { status: 'REJECTED', note: 'x' })
      .expect(404)
  })

  it('only the platform side may change severity', async () => {
    await customerA.post(`/v1/bugs/${world.bugA.id}/status`, { severity: 'LOW' }).expect(403)
    await admin.post(`/v1/bugs/${world.bugA.id}/status`, { severity: 'LOW' }).expect(200)
  })

  it('a duplicate must point at a bug on the same project', async () => {
    const foreign = await prisma.bug.create({
      data: {
        reference: 'BUG-TEST-FOREIGN',
        projectId: world.projectB.id,
        buildId: world.projectB.buildId,
        reportedById: world.testerOther.id,
        title: 'Other project',
        description: 'x',
        stepsToReproduce: 'y',
        severity: 'LOW',
        status: BugStatus.NEW,
      },
      select: { id: true },
    })

    await admin
      .post(`/v1/bugs/${world.bugA.id}/status`, {
        status: 'DUPLICATE',
        duplicateOfId: foreign.id,
      })
      .expect(400)
  })
})

describe('editing and withdrawing', () => {
  it('the reporter can edit their own untriaged report', async () => {
    const response = await testerActive
      .patch(`/v1/bugs/${world.bugA.id}`, { title: 'Checkout fails on UPI (updated)' })
      .expect(200)
    expect(response.body.data.title).toBe('Checkout fails on UPI (updated)')
  })

  it('but not once it has been triaged', async () => {
    await admin.post(`/v1/bugs/${world.bugA.id}/status`, { status: 'CONFIRMED' }).expect(200)
    await testerActive.patch(`/v1/bugs/${world.bugA.id}`, { title: 'Too late' }).expect(403)
  })

  it('the reporter can withdraw their own untriaged report', async () => {
    const created = await testerActive
      .post('/v1/bugs', {
        projectId: world.projectA.id,
        title: 'Filed by mistake',
        description: 'Withdrawing this one',
        stepsToReproduce: '1. oops 2. oops',
        severity: 'LOW',
      })
      .expect(201)

    await testerActive.delete(`/v1/bugs/${created.body.data.id}`).expect(200)
    await testerActive.get(`/v1/bugs/${created.body.data.id}`).expect(404)
  })

  it('but not once it has been triaged', async () => {
    await admin.post(`/v1/bugs/${world.bugA.id}/status`, { status: 'CONFIRMED' }).expect(200)
    await testerActive.delete(`/v1/bugs/${world.bugA.id}`).expect(403)
  })

  it('a customer cannot delete a bug at all', async () => {
    await customerA.delete(`/v1/bugs/${world.bugA.id}`).expect(403)
  })
})

describe('advertised capabilities match what the API will accept', () => {
  it('offers the tester exactly the transitions it will honour', async () => {
    await admin.post(`/v1/bugs/${world.bugA.id}/status`, { status: 'CONFIRMED' }).expect(200)
    await customerA.post(`/v1/bugs/${world.bugA.id}/status`, { status: 'FIXED' }).expect(200)

    const detail = await testerActive.get(`/v1/bugs/${world.bugA.id}`).expect(200)
    const offered: string[] = detail.body.data.capabilities.availableTransitions
    expect(offered.sort()).toEqual(['REOPENED', 'VERIFIED'])

    // Every advertised transition must actually be accepted.
    await testerActive.post(`/v1/bugs/${world.bugA.id}/status`, { status: 'VERIFIED' }).expect(200)
  })

  it('does not offer the customer a transition it would refuse', async () => {
    await admin.post(`/v1/bugs/${world.bugA.id}/status`, { status: 'CONFIRMED' }).expect(200)
    await customerA.post(`/v1/bugs/${world.bugA.id}/status`, { status: 'FIXED' }).expect(200)

    const detail = await customerA.get(`/v1/bugs/${world.bugA.id}`).expect(200)
    const offered: string[] = detail.body.data.capabilities.availableTransitions
    expect(offered).not.toContain('VERIFIED')
    expect(offered).toContain('REOPENED')
  })

  it('tells the reporter when editing is no longer possible', async () => {
    const before = await testerActive.get(`/v1/bugs/${world.bugA.id}`).expect(200)
    expect(before.body.data.capabilities.canEdit).toBe(true)
    expect(before.body.data.capabilities.canDelete).toBe(true)

    await admin.post(`/v1/bugs/${world.bugA.id}/status`, { status: 'CONFIRMED' }).expect(200)

    const after = await testerActive.get(`/v1/bugs/${world.bugA.id}`).expect(200)
    expect(after.body.data.capabilities.canEdit).toBe(false)
    expect(after.body.data.capabilities.canDelete).toBe(false)
  })
})
