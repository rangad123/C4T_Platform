import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/lib/prisma.js'
import { resetDatabase, seedWorld, type World } from '../helpers/fixtures.js'
import { Client } from '../helpers/client.js'

/**
 * The structured testing workflow end to end: a tester applies to a build and
 * is accepted onto it, runs a test case, has the execution reviewed before it
 * counts, files a failure as a linked bug, and logs time that an admin
 * approves. Every endpoint is also tried from the other side of the wall:
 * another organisation, another tester, a tester not on the project.
 */

let w: World
let admin: Client
let subLimited: Client
let custA: Client
let custB: Client
let tActive: Client
let tInvited: Client
let tOther: Client
let tNone: Client

beforeAll(async () => {
  await resetDatabase()
  w = await seedWorld()
  const sign = (u: { email: string }) => Client.signIn(u.email)
  ;[admin, subLimited, custA, custB, tActive, tInvited, tOther, tNone] = await Promise.all([
    sign(w.admin),
    sign(w.subAdminLimited),
    sign(w.customerA),
    sign(w.customerB),
    sign(w.testerActive),
    sign(w.testerInvited),
    sign(w.testerOther),
    sign(w.testerUnassigned),
  ])
})

describe('applications', () => {
  let applicationId: string

  it('only a project-side staffer can open a build to applications', async () => {
    const path = `/v1/builds/${w.projectA.buildId}/applications-open`
    expect((await custA.put(path, { open: true })).status).toBe(403)
    expect((await custB.put(path, { open: true })).status).toBe(404)
    expect((await tActive.put(path, { open: true })).status).toBe(403)
    expect((await tNone.put(path, { open: true })).status).toBe(404)
    expect((await tNone.get('/v1/open-builds')).body.data).toEqual([])

    const res = await admin.put(path, { open: true })
    expect(res.status).toBe(200)
    expect(res.body.data.acceptsApplications).toBe(true)
  })

  it('a tester sees open builds without the brief, and only open ones', async () => {
    const res = await tNone.get('/v1/open-builds')
    expect(res.status).toBe(200)
    expect(res.body.data.map((b: { id: string }) => b.id)).toEqual([w.projectA.buildId])
    expect(JSON.stringify(res.body)).not.toContain('CONFIDENTIAL')
    expect(JSON.stringify(res.body)).not.toContain('Org A')
    expect((await custA.get('/v1/open-builds')).status).toBe(403)
  })

  it('a tester applies once; closed builds and existing roster members are refused', async () => {
    expect((await tNone.post('/v1/applications', { buildId: w.projectB.buildId })).status).toBe(404)
    expect((await tActive.post('/v1/applications', { buildId: w.projectA.buildId })).status).toBe(
      409,
    )
    expect((await custA.post('/v1/applications', { buildId: w.projectA.buildId })).status).toBe(403)

    const res = await tNone.post('/v1/applications', {
      buildId: w.projectA.buildId,
      message: 'I test on Android daily',
    })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('PENDING')
    applicationId = res.body.data.id

    expect((await tNone.post('/v1/applications', { buildId: w.projectA.buildId })).status).toBe(409)
  })

  it('applications are listed only to the applicant and to staffers', async () => {
    expect((await tNone.get('/v1/applications')).body.data).toHaveLength(1)
    expect((await tOther.get('/v1/applications')).body.data).toHaveLength(0)
    expect((await custA.get('/v1/applications')).status).toBe(403)
    expect((await custA.get(`/v1/applications?projectId=${w.projectA.id}`)).status).toBe(404)
    expect((await custB.get(`/v1/applications?projectId=${w.projectA.id}`)).status).toBe(404)
    // A read-only sub-admin manages nothing, so their queue is empty.
    const limited = await subLimited.get('/v1/applications')
    expect(limited.status).toBe(200)
    expect(limited.body.data).toHaveLength(0)

    const all = await admin.get(`/v1/applications?projectId=${w.projectA.id}&status=PENDING`)
    expect(all.status).toBe(200)
    expect(all.body.data).toHaveLength(1)
    expect(all.body.data[0].tester.id).toBe(w.testerUnassigned.id)
  })

  it('accepting puts the tester on the build, already accepted; it is decided once', async () => {
    const path = `/v1/applications/${applicationId}/decision`
    expect((await custA.post(path, { decision: 'ACCEPTED' })).status).toBe(403)
    expect((await custB.post(path, { decision: 'ACCEPTED' })).status).toBe(404)
    expect((await tOther.post(path, { decision: 'ACCEPTED' })).status).toBe(404)

    const res = await admin.post(path, { decision: 'ACCEPTED', note: 'Welcome' })
    expect(res.status).toBe(200)
    const row = await prisma.projectAssignment.findFirst({
      where: { buildId: w.projectA.buildId, testerId: w.testerUnassigned.id },
    })
    expect(row?.status).toBe('ACCEPTED')
    expect((await admin.post(path, { decision: 'DECLINED' })).status).toBe(409)
  })

  it('a declined tester can apply again, and withdraw their own application only', async () => {
    const first = await tOther.post('/v1/applications', { buildId: w.projectA.buildId })
    expect(first.status).toBe(201)
    const decline = await admin.post(`/v1/applications/${first.body.data.id}/decision`, {
      decision: 'DECLINED',
    })
    expect(decline.status).toBe(200)

    const again = await tOther.post('/v1/applications', { buildId: w.projectA.buildId })
    expect(again.status).toBe(201)
    expect(again.body.data.id).toBe(first.body.data.id)

    expect((await tNone.post(`/v1/applications/${again.body.data.id}/withdraw`)).status).toBe(404)
    expect((await tOther.post(`/v1/applications/${again.body.data.id}/withdraw`)).status).toBe(204)
  })
})

describe('scenarios, executions and their review', () => {
  let scenarioId: string
  let testCaseId: string
  let reportId: string

  it('scenarios are written by staff and read by people on the project', async () => {
    const path = `/v1/builds/${w.projectA.buildId}/test-scenarios`
    expect((await custA.post(path, { title: 'Checkout' })).status).toBe(403)
    expect((await tActive.post(path, { title: 'Checkout' })).status).toBe(403)
    const res = await admin.post(path, { title: 'Checkout' })
    expect(res.status).toBe(201)
    scenarioId = res.body.data.id

    expect((await tActive.get(path)).status).toBe(200)
    expect((await custA.get(path)).body.data).toHaveLength(1)
    expect((await tOther.get(path)).status).toBe(404)
    expect((await custB.get(path)).status).toBe(404)
    expect((await tNone.delete(`/v1/test-scenarios/${scenarioId}`)).status).toBe(403)
  })

  it('a test case joins a scenario on its own build only', async () => {
    const other = await admin.post(`/v1/builds/${w.projectB.buildId}/test-scenarios`, {
      title: 'Elsewhere',
    })
    const body = {
      buildId: w.projectA.buildId,
      title: 'Pay with UPI',
      description: 'Complete a purchase',
      steps: '1. Add to cart 2. Pay',
      expectedResult: 'Order confirmed',
    }
    expect(
      (await admin.post('/v1/test-cases', { ...body, scenarioId: other.body.data.id })).status,
    ).toBe(400)

    const res = await admin.post('/v1/test-cases', { ...body, scenarioId })
    expect(res.status).toBe(201)
    expect(res.body.data.scenario.id).toBe(scenarioId)
    testCaseId = res.body.data.id
    const assign = await admin.post(`/v1/test-cases/${testCaseId}/assignments`, {
      testerIds: [w.testerActive.id],
    })
    expect(assign.status).toBe(201)

    const filtered = await admin.get(
      `/v1/test-cases?buildId=${w.projectA.buildId}&scenarioId=${scenarioId}`,
    )
    expect(filtered.body.data).toHaveLength(1)
  })

  it('an execution is pending until reviewed, and the customer sees it only once approved', async () => {
    const run = await tActive.post(`/v1/test-cases/${testCaseId}/reports`, { result: 'PASS' })
    expect(run.status).toBe(201)
    reportId = run.body.data.id
    expect(run.body.data.reviewStatus).toBe('PENDING')

    const asCustomer = await custA.get(`/v1/test-cases?buildId=${w.projectA.buildId}`)
    expect(asCustomer.body.data[0].reports).toHaveLength(0)
    const summary = await custA.get(`/v1/builds/${w.projectA.buildId}/summary`)
    expect(summary.body.data.testReportsByResult.PASS).toBe(0)
    expect(summary.body.data.pendingReviewCount).toBe(1)
    expect(summary.body.data.testCaseCompletion).toBe(0)
  })

  it('the review queue is for staff; testers see their own executions only', async () => {
    expect((await custA.get('/v1/test-reports')).status).toBe(403)
    expect((await custA.get(`/v1/test-reports?projectId=${w.projectA.id}`)).status).toBe(404)
    expect((await custB.get(`/v1/test-reports?buildId=${w.projectA.buildId}`)).status).toBe(404)
    expect((await tOther.get('/v1/test-reports')).body.data).toHaveLength(0)
    expect((await tActive.get('/v1/test-reports')).body.data).toHaveLength(1)

    const queue = await admin.get('/v1/test-reports?reviewStatus=PENDING')
    expect(queue.status).toBe(200)
    expect(queue.body.data.map((r: { id: string }) => r.id)).toEqual([reportId])
  })

  it('a reviewer approves or rejects (with a reason) exactly once', async () => {
    const path = `/v1/test-reports/${reportId}/review`
    expect((await custA.post(path, { decision: 'APPROVED' })).status).toBe(403)
    expect((await custB.post(path, { decision: 'APPROVED' })).status).toBe(404)
    expect((await tActive.post(path, { decision: 'APPROVED' })).status).toBe(403)
    expect((await tOther.post(path, { decision: 'APPROVED' })).status).toBe(404)
    expect([400, 422]).toContain((await admin.post(path, { decision: 'REJECTED' })).status)

    expect((await admin.post(path, { decision: 'APPROVED' })).status).toBe(200)
    expect((await admin.post(path, { decision: 'REJECTED', note: 'late' })).status).toBe(409)

    const asCustomer = await custA.get(`/v1/test-cases?buildId=${w.projectA.buildId}`)
    expect(asCustomer.body.data[0].reports).toHaveLength(1)
    const summary = await custA.get(`/v1/builds/${w.projectA.buildId}/summary`)
    expect(summary.body.data.testReportsByResult.PASS).toBe(1)
    expect(summary.body.data.testCaseCompletion).toBe(100)
    expect(summary.body.data.pendingReviewCount).toBe(0)
  })

  it('a bug filed from a test case records the failed execution linked to it', async () => {
    const bug = {
      title: 'UPI payment hangs',
      description: 'The payment spinner never stops',
      stepsToReproduce: '1. Add to cart 2. Pay with UPI',
      expectedResult: 'Order confirmed',
      actualResult: 'Spinner forever',
      severity: 'HIGH',
      videoUrl: 'https://example.com/recording',
    }
    // Not assigned that case (and not on that build): refused, nothing written.
    const elsewhere = await tOther.post('/v1/bugs', {
      ...bug,
      projectId: w.projectB.id,
      testCaseId,
    })
    expect(elsewhere.status).toBe(400)

    const res = await tActive.post('/v1/bugs', { ...bug, projectId: w.projectA.id, testCaseId })
    expect(res.status).toBe(201)
    const failed = await prisma.testReport.findFirst({ where: { linkedBugId: res.body.data.id } })
    expect(failed?.result).toBe('FAIL')
    expect(failed?.testCaseId).toBe(testCaseId)
    expect(failed?.reviewStatus).toBe('PENDING')
  })
})

describe('timesheets', () => {
  let entryId: string
  const day = '2026-11-10'

  it('a tester logs time only on a build they work; a day is corrected, not duplicated', async () => {
    const body = { buildId: w.projectA.buildId, workDate: day, minutes: 90 }
    expect((await tOther.post('/v1/timesheets', body)).status).toBe(404)
    expect((await tInvited.post('/v1/timesheets', body)).status).toBe(404)
    expect((await custA.post('/v1/timesheets', body)).status).toBe(403)
    expect((await tActive.post('/v1/timesheets', { ...body, workDate: '2999-01-01' })).status).toBe(
      400,
    )
    expect((await tActive.post('/v1/timesheets', { ...body, workDate: '2026-02-30' })).status).toBe(
      400,
    )

    const first = await tActive.post('/v1/timesheets', body)
    expect(first.status).toBe(201)
    const second = await tActive.post('/v1/timesheets', { ...body, minutes: 120 })
    expect(second.body.data.id).toBe(first.body.data.id)
    expect(second.body.data.minutes).toBe(120)
    entryId = first.body.data.id
  })

  it('timesheets are listed to the tester and to staff only', async () => {
    expect((await tActive.get('/v1/timesheets')).body.data).toHaveLength(1)
    expect((await tOther.get('/v1/timesheets')).body.data).toHaveLength(0)
    expect((await custA.get('/v1/timesheets')).status).toBe(403)
    expect((await custA.get(`/v1/timesheets?projectId=${w.projectA.id}`)).status).toBe(404)
    expect((await custB.get(`/v1/timesheets?projectId=${w.projectA.id}`)).status).toBe(404)
    const queue = await admin.get(`/v1/timesheets?status=PENDING&projectId=${w.projectA.id}`)
    expect(queue.body.data.map((e: { id: string }) => e.id)).toEqual([entryId])
  })

  it('a reviewer approves at most the time logged; an approved day is final', async () => {
    const path = `/v1/timesheets/${entryId}/review`
    expect((await custA.post(path, { decision: 'APPROVED' })).status).toBe(403)
    expect((await custB.post(path, { decision: 'APPROVED' })).status).toBe(404)
    expect((await tActive.post(path, { decision: 'APPROVED' })).status).toBe(403)
    expect((await admin.post(path, { decision: 'APPROVED', approvedMinutes: 200 })).status).toBe(
      400,
    )

    const ok = await admin.post(path, { decision: 'APPROVED', approvedMinutes: 100 })
    expect(ok.status).toBe(200)
    expect(ok.body.data.approvedMinutes).toBe(100)
    expect((await admin.post(path, { decision: 'REJECTED', note: 'x' })).status).toBe(409)

    const relog = await tActive.post('/v1/timesheets', {
      buildId: w.projectA.buildId,
      workDate: day,
      minutes: 30,
    })
    expect(relog.status).toBe(409)

    const summary = await custA.get(`/v1/builds/${w.projectA.buildId}/summary`)
    expect(summary.body.data.approvedMinutes).toBe(100)
    // Recording time moves no money.
    expect(await prisma.transaction.count()).toBe(0)
  })
})
