import { beforeAll, describe, expect, it, vi } from 'vitest'

const sent = vi.hoisted(() => [] as { to: string; subject: string }[])
vi.mock('../../src/lib/mailer.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendMail: vi.fn((message: { to: string; subject: string }) => {
    sent.push({ to: message.to, subject: message.subject })
    return Promise.resolve()
  }),
}))

import { prisma } from '../../src/lib/prisma.js'
import {
  createNotification,
  createNotifications,
} from '../../src/modules/notifications/notifications.service.js'
import { resetDatabase, seedWorld, type World } from '../helpers/fixtures.js'
import { Client } from '../helpers/client.js'

/**
 * Automation modules and reports per build, and per-type notification
 * preferences. Every endpoint is also tried from the other side of the wall.
 */

let w: World
let admin: Client
let custA: Client
let custB: Client
let tActive: Client
let tInvited: Client
let tNone: Client

beforeAll(async () => {
  await resetDatabase()
  w = await seedWorld()
  const sign = (u: { email: string }) => Client.signIn(u.email)
  ;[admin, custA, custB, tActive, tInvited, tNone] = await Promise.all([
    sign(w.admin),
    sign(w.customerA),
    sign(w.customerB),
    sign(w.testerActive),
    sign(w.testerInvited),
    sign(w.testerUnassigned),
  ])
})

describe('automation modules and reports', () => {
  const base = () => `/v1/automation/projects/${w.projectA.id}`
  let moduleId: string
  let reportId: string
  let fileId: string

  it('the owning customer adds a module; nobody else outside the project side can', async () => {
    const body = { name: 'Checkout suite', framework: 'Playwright', owner: 'QA team' }
    expect((await custB.post(`${base()}/modules`, body)).status).toBe(404)
    expect((await tNone.post(`${base()}/modules`, body)).status).toBe(404)
    expect((await tInvited.post(`${base()}/modules`, body)).status).toBe(404)
    expect((await tActive.post(`${base()}/modules`, body)).status).toBe(403)
    expect(
      (await custA.post(`${base()}/modules`, { ...body, repositoryUrl: 'http://insecure.example' }))
        .status,
    ).toBe(422)

    const res = await custA.post(`${base()}/modules`, {
      ...body,
      repositoryUrl: 'https://git.example.com/checkout',
    })
    expect(res.status).toBe(201)
    expect(res.body.data.buildId).toBe(w.projectA.buildId)
    moduleId = res.body.data.id

    const byAdmin = await admin.post(`${base()}/modules`, {
      name: 'Login suite',
      buildId: w.projectA.buildId,
    })
    expect(byAdmin.status).toBe(201)
    // A build of another project is refused.
    expect(
      (await admin.post(`${base()}/modules`, { name: 'X', buildId: w.projectB.buildId })).status,
    ).toBe(400)
  })

  it('a report is recorded with its own upload only, against a module on the build', async () => {
    const own = await prisma.fileObject.create({
      data: {
        scope: 'PROJECT_MATERIAL',
        storageKey: `project_material/r52g-${Date.now()}.pdf`,
        driver: 'local',
        originalName: 'run.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        uploadedById: w.customerA.id,
        isComplete: true,
      },
    })
    fileId = own.id
    const foreign = await prisma.fileObject.create({
      data: {
        scope: 'TESTER_DOCUMENT',
        storageKey: `tester_document/r52g-${Date.now()}.pdf`,
        driver: 'local',
        originalName: 'private.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        uploadedById: w.testerOther.id,
        isComplete: true,
      },
    })

    const report = {
      moduleId,
      runAt: '2026-11-01T10:00:00.000Z',
      passed: 40,
      failed: 2,
      skipped: 1,
      durationSeconds: 300,
      notes: 'Two flaky checkout steps',
    }
    expect((await custB.post(`${base()}/reports`, report)).status).toBe(404)
    expect((await tActive.post(`${base()}/reports`, report)).status).toBe(403)
    expect((await custA.post(`${base()}/reports`, { ...report, fileId: foreign.id })).status).toBe(
      400,
    )
    expect((await custA.post(`${base()}/reports`, { ...report, passed: -1 })).status).toBe(422)

    const res = await custA.post(`${base()}/reports`, { ...report, fileId })
    expect(res.status).toBe(201)
    reportId = res.body.data.id
  })

  it('the project side and accepted testers read it; others get 404', async () => {
    for (const reader of [admin, custA, tActive]) {
      const res = await reader.get(base())
      expect(res.status).toBe(200)
      expect(res.body.data.modules).toHaveLength(2)
      expect(res.body.data.reports).toHaveLength(1)
      expect(res.body.data.reports[0]).toMatchObject({
        passed: 40,
        failed: 2,
        skipped: 1,
        module: { id: moduleId, name: 'Checkout suite' },
        file: { id: fileId, originalName: 'run.pdf' },
      })
    }
    expect((await admin.get(base())).body.data.canManage).toBe(true)
    expect((await custA.get(base())).body.data.canManage).toBe(true)
    expect((await tActive.get(base())).body.data.canManage).toBe(false)
    for (const outsider of [custB, tNone, tInvited]) {
      expect((await outsider.get(base())).status).toBe(404)
    }
  })

  it('the report file downloads for project readers only', async () => {
    const path = `/v1/uploads/${fileId}/download-url`
    expect((await tActive.get(path)).status).toBe(200)
    expect((await custA.get(path)).status).toBe(200)
    expect([403, 404]).toContain((await custB.get(path)).status)
    expect([403, 404]).toContain((await tNone.get(path)).status)
  })

  it('edits and deletes follow the same wall', async () => {
    const path = `/v1/automation/modules/${moduleId}`
    expect((await custB.patch(path, { owner: 'X' })).status).toBe(404)
    expect((await tActive.patch(path, { owner: 'X' })).status).toBe(403)
    const res = await custA.patch(path, { owner: 'Platform team', framework: null })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ owner: 'Platform team', framework: null })

    expect((await tActive.delete(`/v1/automation/reports/${reportId}`)).status).toBe(403)
    expect((await custB.delete(`/v1/automation/reports/${reportId}`)).status).toBe(404)
    expect((await custA.delete(`/v1/automation/reports/${reportId}`)).status).toBe(204)
    expect((await custB.delete(path)).status).toBe(404)
    expect((await admin.delete(path)).status).toBe(204)
    expect((await custA.get(base())).body.data).toMatchObject({ reports: [] })
  })
})

describe('notification preferences', () => {
  it('every role reads its own choices, all on by default, essential types locked', async () => {
    for (const client of [admin, custA, tActive]) {
      const res = await client.get('/v1/notifications/preferences')
      expect(res.status).toBe(200)
      expect(res.body.data.emailNotifications).toBe(true)
      const bug = res.body.data.types.find((t: { type: string }) => t.type === 'BUG_REPORTED')
      expect(bug).toEqual({ type: 'BUG_REPORTED', essential: false, inApp: true, email: true })
      const money = res.body.data.types.find(
        (t: { type: string }) => t.type === 'TRANSACTION_UPDATED',
      )
      expect(money.essential).toBe(true)
    }
  })

  it('a muted type is saved; an essential one cannot be turned off', async () => {
    const res = await custA.patch('/v1/notifications/preferences', {
      types: [
        { type: 'BUG_REPORTED', inApp: false, email: false },
        { type: 'MESSAGE_RECEIVED', inApp: true, email: false },
        { type: 'TRANSACTION_UPDATED', inApp: false, email: false },
      ],
    })
    expect(res.status).toBe(200)
    const byType = Object.fromEntries(res.body.data.types.map((t: { type: string }) => [t.type, t]))
    expect(byType.BUG_REPORTED).toMatchObject({ inApp: false, email: false })
    expect(byType.MESSAGE_RECEIVED).toMatchObject({ inApp: true, email: false })
    expect(byType.TRANSACTION_UPDATED).toMatchObject({ inApp: true, email: true })
    expect(
      await prisma.notificationPreference.count({
        where: { userId: w.customerA.id, type: 'TRANSACTION_UPDATED' },
      }),
    ).toBe(0)
    // Someone else's choices are untouched.
    const other = await custB.get('/v1/notifications/preferences')
    expect(
      other.body.data.types.find((t: { type: string }) => t.type === 'BUG_REPORTED').inApp,
    ).toBe(true)
    expect((await custA.patch('/v1/notifications/preferences', {})).status).toBe(422)
    expect(
      (
        await custA.patch('/v1/notifications/preferences', {
          types: [{ type: 'NOPE', inApp: true, email: true }],
        })
      ).status,
    ).toBe(422)
  })

  it('a muted type is neither created nor emailed; others still are', async () => {
    sent.length = 0
    const link = `/app/customer/projects/${w.projectA.id}`
    await createNotification({
      userId: w.customerA.id,
      type: 'BUG_REPORTED',
      title: 'r52g muted bug',
      link,
    })
    await createNotifications([w.customerA.id, w.customerB.id], {
      type: 'BUG_REPORTED',
      title: 'r52g bulk bug',
      link,
    })
    // In-app on, email off: the row exists, no email.
    await createNotification({
      userId: w.customerA.id,
      type: 'MESSAGE_RECEIVED',
      title: 'r52g message',
      link: '/app/customer/messages/x',
    })
    // Essential: delivered both ways whatever was asked.
    await createNotification({
      userId: w.customerA.id,
      type: 'TRANSACTION_UPDATED',
      title: 'r52g payment',
    })

    const rows = await prisma.notification.findMany({
      where: { title: { startsWith: 'r52g' } },
      select: { userId: true, title: true },
    })
    const mine = rows.filter((r) => r.userId === w.customerA.id).map((r) => r.title)
    expect(mine.sort()).toEqual(['r52g message', 'r52g payment'])
    expect(rows.filter((r) => r.userId === w.customerB.id).map((r) => r.title)).toEqual([
      'r52g bulk bug',
    ])

    await vi.waitFor(() => {
      expect(sent.map((m) => `${m.to}|${m.subject}`).sort()).toEqual(
        [`${w.customerA.email}|r52g payment`, `${w.customerB.email}|r52g bulk bug`].sort(),
      )
    })
    // Give any stray detached send a moment to show up, then check nothing else went.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(sent).toHaveLength(2)
  })

  it('the old one-flag form of the request still works', async () => {
    const res = await tActive.patch('/v1/notifications/preferences', { emailNotifications: false })
    expect(res.status).toBe(200)
    expect(res.body.data.emailNotifications).toBe(false)
  })
})
