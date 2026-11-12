import http from 'node:http'
import os from 'node:os'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BugSeverity, BugStatus } from '@prisma/client'
import { prisma } from '../../src/lib/prisma.js'
import { decryptSecret } from '../../src/lib/payment-encryption.js'
import {
  assertPublicHost,
  isPrivateAddress,
  setOutboundCheckForTests,
} from '../../src/lib/outbound.js'
import { resetDatabase, seedWorld, type World } from '../helpers/fixtures.js'
import { anon, Client } from '../helpers/client.js'

/**
 * Bug tracker export (Jira Cloud), against a local fake Jira. Nothing here
 * talks to a real Jira.
 *
 * Proves: who may manage a connection, the token is write-only and encrypted
 * at rest, "Test connection", exporting creates one issue with the bug's
 * substance, a second export is refused with the link, testers and other
 * organisations cannot export, Jira's raw answer and the token never reach
 * an error message, and private or non-https addresses are refused — at save
 * and again on every request.
 */

const TOKEN = 'atl-test-token-SECRET-9f3c'
const EMAIL = 'jira-bot@example.com'

interface Seen {
  method: string
  url: string
  auth: string | undefined
  body: { fields?: Record<string, unknown> } | null
}

const seen: Seen[] = []
let issueCounter = 0
/** What the fake answers to a create, when set. */
let createOverride: { status: number; body: unknown } | null = null
/** Answer 400 on `priority` the first time, as a project without that field does. */
let rejectPriority = false

const fake = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw ? (JSON.parse(raw) as Seen['body']) : null
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body })
    const expected = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(json))
    }
    if (req.headers.authorization !== expected) {
      return send(401, { errorMessages: [`raw jira body echoing ${req.headers.authorization}`] })
    }
    if (req.method === 'GET' && req.url === '/rest/api/2/project/QA')
      return send(200, { key: 'QA' })
    if (req.method === 'GET' && req.url?.startsWith('/rest/api/2/project/')) {
      return send(404, { errorMessages: ['No project could be found with key'] })
    }
    if (req.method === 'POST' && req.url === '/rest/api/2/issue') {
      if (createOverride) return send(createOverride.status, createOverride.body)
      if (rejectPriority && body?.fields?.priority) {
        return send(400, { errors: { priority: 'Field cannot be set' } })
      }
      issueCounter += 1
      return send(201, { id: String(10_000 + issueCounter), key: `QA-${issueCounter}` })
    }
    send(404, {})
  })
})

let world: World
let admin: Client
let subLimited: Client
let owner: Client
let member: Client
let otherOrg: Client
let tester: Client
let site: string

async function makeBug(title: string): Promise<string> {
  const bug = await prisma.bug.create({
    data: {
      reference: `BUG-TEST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      projectId: world.projectA.id,
      buildId: world.projectA.buildId,
      reportedById: world.testerActive.id,
      title,
      description: 'Something broke',
      stepsToReproduce: '1. Open the app',
      severity: BugSeverity.LOW,
      status: BugStatus.NEW,
    },
    select: { id: true },
  })
  return bug.id
}

function connect(client: Client, body: Record<string, unknown> = {}, orgId = world.orgA.id) {
  return client.put(`/v1/bug-tracker/organisations/${orgId}`, {
    siteUrl: site,
    accountEmail: EMAIL,
    projectKey: 'qa',
    issueType: 'Bug',
    apiToken: TOKEN,
    ...body,
  })
}

beforeAll(async () => {
  await new Promise<void>((resolve) => fake.listen(9152, '127.0.0.1', resolve))
  site = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
  await resetDatabase()
  world = await seedWorld()
  ;[admin, subLimited, owner, member, otherOrg, tester] = await Promise.all([
    Client.signIn(world.admin.email),
    Client.signIn(world.subAdminLimited.email),
    Client.signIn(world.customerA.email),
    Client.signIn(world.customerAMember.email),
    Client.signIn(world.customerB.email),
    Client.signIn(world.testerActive.email),
  ])
})

beforeEach(() => {
  setOutboundCheckForTests(true)
  createOverride = null
  rejectPriority = false
})

afterAll(async () => {
  setOutboundCheckForTests(false)
  await new Promise<void>((resolve) => fake.close(() => resolve()))
})

describe('the connection', () => {
  it('only the organisation’s owners and platform admins manage it', async () => {
    expect((await connect(member)).status).toBe(403)
    expect((await connect(subLimited)).status).toBe(403)
    expect((await connect(tester)).status).toBe(404)
    expect((await connect(otherOrg)).status).toBe(404)
    expect((await anon().get(`/v1/bug-tracker/organisations/${world.orgA.id}`)).status).toBe(401)
    expect((await owner.get(`/v1/bug-tracker/organisations/${world.orgA.id}`)).body.data).toBeNull()
  })

  it('saves, and hands back only the masked ending of the token', async () => {
    const res = await connect(owner)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      siteUrl: site,
      accountEmail: EMAIL,
      projectKey: 'QA',
      tokenMasked: '••••9f3c',
    })
    for (const r of [res, await admin.get(`/v1/bug-tracker/organisations/${world.orgA.id}`)]) {
      const text = JSON.stringify(r.body)
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain('tokenEncrypted')
    }
    expect((await member.get(`/v1/bug-tracker/organisations/${world.orgA.id}`)).status).toBe(403)
  })

  it('stores the token encrypted, bound to its row', async () => {
    const row = await prisma.bugTrackerConnection.findUniqueOrThrow({
      where: { organisationId: world.orgA.id },
    })
    const bytes = Buffer.from(row.tokenEncrypted)
    expect(bytes.includes(Buffer.from(TOKEN))).toBe(false)
    expect(bytes.includes(Buffer.from('SECRET'))).toBe(false)
    expect(decryptSecret(bytes, `${row.id}:${row.organisationId}`)).toBe(TOKEN)
    expect(() => decryptSecret(bytes, `${row.id}:${world.orgB.id}`)).toThrow()
  })

  it('an edit without a token keeps the stored one; a new connection needs one', async () => {
    const res = await connect(admin, { apiToken: undefined, issueType: 'Task' })
    expect(res.status).toBe(200)
    expect(res.body.data.issueType).toBe('Task')
    expect(res.body.data.tokenMasked).toBe('••••9f3c')
    expect((await connect(admin, { issueType: 'Bug' })).status).toBe(200)
    // The stored token never follows a changed site or account.
    expect(
      (await connect(owner, { apiToken: undefined, siteUrl: 'http://127.0.0.2:9152' })).status,
    ).toBe(400)
    expect(
      (await connect(owner, { apiToken: undefined, accountEmail: 'other@example.com' })).status,
    ).toBe(400)
    expect((await connect(otherOrg, { apiToken: undefined }, world.orgB.id)).status).toBe(400)
  })

  it('Test connection reports success, and a refusal without the token or Jira’s words', async () => {
    const ok = await owner.post(`/v1/bug-tracker/organisations/${world.orgA.id}/test`)
    expect(ok.status).toBe(200)
    expect(ok.body.data).toMatchObject({ lastTestOk: true, lastTestError: null })

    await connect(otherOrg, { apiToken: 'wrong-token-1234' }, world.orgB.id)
    const bad = await otherOrg.post(`/v1/bug-tracker/organisations/${world.orgB.id}/test`)
    expect(bad.status).toBe(200)
    expect(bad.body.data.lastTestOk).toBe(false)
    expect(bad.body.data.lastTestError).toBe('Jira refused the account email or API token')
    const text = JSON.stringify(bad.body)
    expect(text).not.toContain('wrong-token')
    expect(text).not.toContain('raw jira body')
    expect(text).not.toContain('Basic ')
  })
})

describe('exporting a bug', () => {
  it('a tester sees no export, and cannot export even their own report', async () => {
    const view = await tester.get(`/v1/bug-tracker/bugs/${world.bugA.id}`)
    expect(view.status).toBe(200)
    expect(view.body.data).toMatchObject({ canExport: false, issue: null })
    expect((await tester.post(`/v1/bug-tracker/bugs/${world.bugA.id}/export`)).status).toBe(403)
  })

  it('another organisation cannot see or export the bug', async () => {
    expect((await otherOrg.get(`/v1/bug-tracker/bugs/${world.bugA.id}`)).status).toBe(404)
    expect((await otherOrg.post(`/v1/bug-tracker/bugs/${world.bugA.id}/export`)).status).toBe(404)
    const bulk = await otherOrg.post('/v1/bug-tracker/bugs/bulk-export', { ids: [world.bugA.id] })
    expect(bulk.status).toBe(200)
    expect(bulk.body.data.exported).toEqual([])
    expect(bulk.body.data.skipped).toHaveLength(1)
  })

  it('the customer exports it: one issue with the bug’s substance, linked on the bug', async () => {
    seen.length = 0
    const res = await member.post(`/v1/bug-tracker/bugs/${world.bugA.id}/export`)
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      status: 'EXPORTED',
      key: 'QA-1',
      url: `${site}/browse/QA-1`,
    })

    const create = seen.filter((s) => s.method === 'POST')
    expect(create).toHaveLength(1)
    const fields = create[0]!.body!.fields!
    expect(fields.summary).toBe(`[${world.bugA.reference}] Checkout fails on UPI`)
    expect(fields.project).toEqual({ key: 'QA' })
    expect(fields.issuetype).toEqual({ name: 'Bug' })
    expect(fields.priority).toEqual({ name: 'High' })
    expect(fields.description).toContain('Payment never completes')
    expect(fields.description).toContain('*Steps to reproduce*\n1. Add to cart 2. Pay with UPI')
    expect(fields.description).toContain('*Severity*\nHIGH')
    expect(fields.description).toContain(`/app/bugs/${world.bugA.id}`)

    const view = await owner.get(`/v1/bug-tracker/bugs/${world.bugA.id}`)
    expect(view.body.data).toMatchObject({
      connected: true,
      canExport: true,
      issue: { key: 'QA-1', url: `${site}/browse/QA-1` },
    })
  })

  it('a second export is refused and points at the existing issue', async () => {
    seen.length = 0
    const again = await admin.post(`/v1/bug-tracker/bugs/${world.bugA.id}/export`)
    expect(again.status).toBe(409)
    expect(again.body.error.message).toContain('QA-1')
    expect(seen).toHaveLength(0)
  })

  it('a failed export keeps our message, never Jira’s body or the token, and can be retried', async () => {
    const bugId = await makeBug('Retry me')
    createOverride = {
      status: 400,
      body: { errors: { customfield_10010: 'required' }, errorMessages: [`echo ${TOKEN}`] },
    }
    const failed = await owner.post(`/v1/bug-tracker/bugs/${bugId}/export`)
    expect(failed.status).toBe(400)
    expect(failed.body.error.message).toBe(
      'Jira did not accept the issue. Check these fields in the project: customfield_10010',
    )
    expect(JSON.stringify(failed.body)).not.toContain(TOKEN)
    const row = await prisma.bugExternalIssue.findFirstOrThrow({ where: { bugId } })
    expect(row.status).toBe('FAILED')
    expect(row.lastError).not.toContain(TOKEN)

    createOverride = null
    const retried = await owner.post(`/v1/bug-tracker/bugs/${bugId}/export`)
    expect(retried.status).toBe(201)
    expect(retried.body.data.key).toMatch(/^QA-\d+$/)
  })

  it('drops priority when the Jira project does not take it', async () => {
    const bugId = await makeBug('No priority here')
    rejectPriority = true
    const res = await owner.post(`/v1/bug-tracker/bugs/${bugId}/export`)
    expect(res.status).toBe(201)
  })

  it('bulk export exports the new ones and skips what is already in Jira', async () => {
    const a = await makeBug('Bulk one')
    const b = await makeBug('Bulk two')
    const res = await admin.post('/v1/bug-tracker/bugs/bulk-export', { ids: [a, b, world.bugA.id] })
    expect(res.status).toBe(200)
    expect(res.body.data.exported.map((e: { id: string }) => e.id).sort()).toEqual([a, b].sort())
    expect(res.body.data.skipped).toEqual([
      { id: world.bugA.id, reason: 'This bug is already in Jira as QA-1' },
    ])
    expect(
      (await tester.post('/v1/bug-tracker/bugs/bulk-export', { ids: [a] })).body.data.exported,
    ).toEqual([])
  })
})

describe('outbound safety (the real check, override off)', () => {
  beforeEach(() => setOutboundCheckForTests(false))

  it('refuses non-https and private, loopback and link-local addresses at save', async () => {
    for (const siteUrl of [
      'http://jira.example.com',
      'https://127.0.0.1',
      'https://localhost',
      'https://10.1.2.3',
      'https://169.254.169.254',
      'https://192.168.1.10',
      'https://[::1]',
      'https://[fd00::1]',
      'https://[::ffff:127.0.0.1]',
      'https://user:pass@jira.example.com',
      'not a url',
    ]) {
      const res = await connect(owner, { siteUrl })
      expect(res.status, siteUrl).toBe(400)
    }
  })

  it('checks the resolved address too, not just the name', async () => {
    await expect(assertPublicHost('localhost')).rejects.toThrow(/private or local/)
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('2606:4700::1111')).toBe(false)
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.5.5',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })

  it('re-checks on every request: a stored address that is now private is refused', async () => {
    // An https name that passes the save-time shape check but now resolves
    // to a local address, as a rebinding host would. This machine's own name
    // resolves locally (loopback or a private interface).
    await prisma.bugTrackerConnection.update({
      where: { organisationId: world.orgA.id },
      data: { siteUrl: `https://${os.hostname()}:9152` },
    })
    const bugId = await makeBug('Rebound')
    seen.length = 0
    const test = await owner.post(`/v1/bug-tracker/organisations/${world.orgA.id}/test`)
    expect(test.body.data.lastTestOk).toBe(false)
    expect(test.body.data.lastTestError).toMatch(/private or local/)
    const exp = await owner.post(`/v1/bug-tracker/bugs/${bugId}/export`)
    expect(exp.status).toBe(400)
    expect(exp.body.error.message).toMatch(/private or local/)
    expect(seen).toHaveLength(0)
  })
})
