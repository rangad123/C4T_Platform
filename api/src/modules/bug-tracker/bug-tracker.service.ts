import { randomUUID } from 'node:crypto'
import { type BugSeverity, BugTrackerProvider, ExternalIssueStatus, Prisma } from '@prisma/client'
import { env } from '../../config/env.js'
import { prisma } from '../../lib/prisma.js'
import { authorize, can } from '../../lib/access/policy.js'
import { bugRelations, organisationRelations } from '../../lib/access/relations.js'
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js'
import { decryptSecret, encryptSecret } from '../../lib/payment-encryption.js'
import { createDownloadUrl } from '../../lib/storage.js'
import {
  OutboundError,
  assertPublicHost,
  assertSafeUrlShape,
  outboundJson,
} from '../../lib/outbound.js'

/**
 * Bug tracker export (legacy `bug_export_jira`).
 *
 * An organisation connects its Jira Cloud site; its people and the platform
 * side export bugs into it. A bug exports once: the issue key and link are
 * kept on a `BugExternalIssue` row and shown instead of a second export.
 *
 * Secrets: the API token is encrypted at rest and never returned; only its
 * last four characters are. Error text shown to people is ours, built from
 * Jira's status code and field names, never Jira's raw body and never the
 * token.
 */

export interface ConnectionInput {
  siteUrl: string
  accountEmail: string
  projectKey: string
  issueType: string
  /** Required when creating; omit to keep the stored token. */
  apiToken?: string
}

const aad = (id: string, organisationId: string) => `${id}:${organisationId}`

const publicSelect = {
  id: true,
  organisationId: true,
  provider: true,
  siteUrl: true,
  accountEmail: true,
  projectKey: true,
  issueType: true,
  tokenLast4: true,
  lastTestedAt: true,
  lastTestOk: true,
  lastTestError: true,
  updatedAt: true,
} satisfies Prisma.BugTrackerConnectionSelect

/** 404 for anyone outside the organisation, 403 for a member who is not an owner. */
async function authorizeOrg(user: Express.AuthenticatedUser, organisationId: string) {
  const org = await prisma.organisation.findFirst({
    where: { id: organisationId, deletedAt: null },
    select: { id: true },
  })
  if (!org) throw new NotFoundError('Organisation')
  const relations = await organisationRelations(user, organisationId)
  if (!can(user, 'organisation.read', relations)) throw new NotFoundError('Organisation')
  authorize(user, 'organisation.manage_integrations', relations)
}

function masked<T extends { tokenLast4: string }>(row: T) {
  const { tokenLast4, ...rest } = row
  return { ...rest, tokenMasked: `••••${tokenLast4}` }
}

export async function getConnection(user: Express.AuthenticatedUser, organisationId: string) {
  await authorizeOrg(user, organisationId)
  const row = await prisma.bugTrackerConnection.findUnique({
    where: { organisationId },
    select: publicSelect,
  })
  return row ? masked(row) : null
}

function normaliseSite(raw: string): string {
  try {
    return assertSafeUrlShape(raw.trim()).origin
  } catch (e) {
    throw new BadRequestError(e instanceof Error ? e.message : 'Enter a full https:// address')
  }
}

export async function saveConnection(
  user: Express.AuthenticatedUser,
  organisationId: string,
  input: ConnectionInput,
) {
  await authorizeOrg(user, organisationId)
  const siteUrl = normaliseSite(input.siteUrl)
  try {
    await assertPublicHost(new URL(siteUrl).hostname)
  } catch (e) {
    throw new BadRequestError(
      e instanceof OutboundError ? e.message : 'That address could not be checked',
    )
  }

  const fields = {
    siteUrl,
    accountEmail: input.accountEmail,
    projectKey: input.projectKey,
    issueType: input.issueType,
    // A changed site or account invalidates the last test.
    lastTestedAt: null,
    lastTestOk: null,
    lastTestError: null,
  }
  const existing = await prisma.bugTrackerConnection.findUnique({
    where: { organisationId },
    select: { id: true, siteUrl: true, accountEmail: true },
  })

  // The stored token must never be sent to a different site or account than
  // the one it was entered for.
  if (
    existing &&
    !input.apiToken &&
    (existing.siteUrl !== siteUrl || existing.accountEmail !== input.accountEmail)
  ) {
    throw new BadRequestError('Enter the API token again when the site or account changes')
  }

  if (existing) {
    const row = await prisma.bugTrackerConnection.update({
      where: { id: existing.id },
      data: {
        ...fields,
        ...(input.apiToken
          ? {
              tokenEncrypted: new Uint8Array(
                encryptSecret(input.apiToken, aad(existing.id, organisationId)),
              ),
              tokenLast4: input.apiToken.slice(-4),
            }
          : {}),
      },
      select: publicSelect,
    })
    return masked(row)
  }

  if (!input.apiToken) throw new BadRequestError('Enter the API token')
  // The id is part of the AAD, so it is chosen before the row is written.
  const id = randomUUID()
  const row = await prisma.bugTrackerConnection.create({
    data: {
      id,
      organisationId,
      provider: BugTrackerProvider.JIRA_CLOUD,
      ...fields,
      tokenEncrypted: new Uint8Array(encryptSecret(input.apiToken, aad(id, organisationId))),
      tokenLast4: input.apiToken.slice(-4),
    },
    select: publicSelect,
  })
  return masked(row)
}

export async function deleteConnection(user: Express.AuthenticatedUser, organisationId: string) {
  await authorizeOrg(user, organisationId)
  await prisma.bugTrackerConnection.deleteMany({ where: { organisationId } })
}

// ─── Jira ────────────────────────────────────────────────────────────────────

interface JiraConnection {
  id: string
  organisationId: string
  siteUrl: string
  accountEmail: string
  projectKey: string
  issueType: string
  tokenEncrypted: Uint8Array
}

function jiraHeaders(c: JiraConnection): Record<string, string> {
  const token = decryptSecret(Buffer.from(c.tokenEncrypted), aad(c.id, c.organisationId))
  return { authorization: `Basic ${Buffer.from(`${c.accountEmail}:${token}`).toString('base64')}` }
}

/** Field names Jira complained about, filtered to plain identifiers. */
function jiraFieldNames(json: unknown): string[] {
  const errors = (json as { errors?: Record<string, unknown> } | null)?.errors
  if (!errors || typeof errors !== 'object') return []
  return Object.keys(errors)
    .filter((k) => /^[A-Za-z0-9_.-]{1,40}$/.test(k))
    .slice(0, 5)
}

function jiraMessage(status: number, json: unknown, projectKey: string): string {
  if (status === 401 || status === 403) return 'Jira refused the account email or API token'
  if (status === 404) return `Jira could not find project ${projectKey} on that site`
  if (status === 400) {
    const fields = jiraFieldNames(json)
    return fields.length > 0
      ? `Jira did not accept the issue. Check these fields in the project: ${fields.join(', ')}`
      : 'Jira did not accept the issue. Check the issue type and the project’s required fields'
  }
  if (status === 429) return 'Jira is limiting requests. Try again in a minute'
  return `Jira answered with an error (status ${status})`
}

async function callJira(
  c: JiraConnection,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<{ status: number; json: unknown }> {
  try {
    return await outboundJson(`${c.siteUrl}${path}`, { ...init, headers: jiraHeaders(c) })
  } catch (e) {
    throw new BadRequestError(e instanceof OutboundError ? e.message : 'Jira could not be reached')
  }
}

export async function testConnection(user: Express.AuthenticatedUser, organisationId: string) {
  await authorizeOrg(user, organisationId)
  const c = await prisma.bugTrackerConnection.findUnique({ where: { organisationId } })
  if (!c) throw new NotFoundError('Bug tracker connection')

  let error: string | null = null
  try {
    const res = await callJira(c, `/rest/api/2/project/${encodeURIComponent(c.projectKey)}`, {
      method: 'GET',
    })
    if (res.status !== 200) error = jiraMessage(res.status, res.json, c.projectKey)
  } catch (e) {
    error = e instanceof Error ? e.message : 'Jira could not be reached'
  }
  const row = await prisma.bugTrackerConnection.update({
    where: { id: c.id },
    data: { lastTestedAt: new Date(), lastTestOk: error === null, lastTestError: error },
    select: publicSelect,
  })
  return masked(row)
}

// ─── Export ──────────────────────────────────────────────────────────────────

const PRIORITY: Record<BugSeverity, string> = {
  CRITICAL: 'Highest',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
}

/** A PENDING claim older than this is taken to be a crashed export. */
const STALE_PENDING_MS = 2 * 60_000

const issueSelect = {
  provider: true,
  key: true,
  url: true,
  status: true,
  lastError: true,
  updatedAt: true,
} satisfies Prisma.BugExternalIssueSelect

async function resolveBug(user: Express.AuthenticatedUser, bugId: string) {
  const resolved = await bugRelations(user, bugId)
  // 404 rather than 403 to anyone who may not read it.
  if (!resolved || !can(user, 'bug.read', resolved.relations)) throw new NotFoundError('Bug')
  return resolved
}

/** What the bug page shows: the issue if exported, and whether this caller may export. */
export async function getBugExport(user: Express.AuthenticatedUser, bugId: string) {
  const { relations, bug } = await resolveBug(user, bugId)
  const [issue, connection] = await Promise.all([
    prisma.bugExternalIssue.findUnique({
      where: { bugId_provider: { bugId, provider: BugTrackerProvider.JIRA_CLOUD } },
      select: issueSelect,
    }),
    prisma.bugTrackerConnection.findUnique({
      where: { organisationId: bug.organisationId },
      select: { projectKey: true },
    }),
  ])
  return {
    issue,
    connected: connection !== null,
    canExport: can(user, 'bug.export', relations),
  }
}

function section(title: string, body: string | null | undefined): string {
  return body?.trim() ? `*${title}*\n${body.trim()}\n` : ''
}

async function issueFields(bugId: string, c: JiraConnection) {
  const bug = await prisma.bug.findUniqueOrThrow({
    where: { id: bugId },
    select: {
      id: true,
      reference: true,
      title: true,
      description: true,
      preCondition: true,
      stepsToReproduce: true,
      expectedResult: true,
      actualResult: true,
      severity: true,
      deviceModel: true,
      osName: true,
      osVersion: true,
      browser: true,
      appVersion: true,
      networkType: true,
      build: { select: { name: true } },
      attachments: {
        select: { file: { select: { storageKey: true, originalName: true, isComplete: true } } },
      },
    },
  })

  const environment = [
    bug.deviceModel && `Device: ${bug.deviceModel}`,
    [bug.osName, bug.osVersion].some(Boolean) &&
      `OS: ${[bug.osName, bug.osVersion].filter(Boolean).join(' ')}`,
    bug.browser && `Browser: ${bug.browser}`,
    bug.appVersion && `App version: ${bug.appVersion}`,
    bug.networkType && `Network: ${bug.networkType}`,
  ]
    .filter(Boolean)
    .join('\n')

  // Signed, short-lived links; the bucket is never public. The Crowd4Test
  // link below is the lasting one.
  const files = await Promise.all(
    bug.attachments
      .filter((a) => a.file.isComplete)
      .map(async (a) => {
        const name = a.file.originalName.replace(/[|\][]/g, ' ')
        return `- [${name}|${await createDownloadUrl(a.file.storageKey, a.file.originalName)}]`
      }),
  )
  const minutes = Math.round(env.UPLOAD_URL_TTL_SECONDS / 60)

  const description = [
    bug.description.trim() + '\n',
    section('Pre-condition', bug.preCondition),
    section('Steps to reproduce', bug.stepsToReproduce),
    section('Expected result', bug.expectedResult),
    section('Actual result', bug.actualResult),
    section('Environment', environment),
    section('Build', bug.build.name),
    section('Severity', bug.severity),
    files.length > 0
      ? section(
          `Attachments (links expire after ${minutes} minutes; open the bug on Crowd4Test for lasting access)`,
          files.join('\n'),
        )
      : '',
    `Reported on Crowd4Test as ${bug.reference}: ${env.WEB_PUBLIC_URL}/app/bugs/${bug.id}`,
  ]
    .filter(Boolean)
    .join('\n')

  return {
    project: { key: c.projectKey },
    issuetype: { name: c.issueType },
    summary: `[${bug.reference}] ${bug.title}`.replace(/\s+/g, ' ').slice(0, 255),
    description: description.slice(0, 30_000),
    priority: { name: PRIORITY[bug.severity] },
  }
}

/** Claim the bug for export, or refuse because it is already exported or in flight. */
async function claim(bugId: string): Promise<void> {
  const provider = BugTrackerProvider.JIRA_CLOUD
  try {
    await prisma.bugExternalIssue.create({ data: { bugId, provider } })
    return
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e
  }
  const retried = await prisma.bugExternalIssue.updateMany({
    where: {
      bugId,
      provider,
      OR: [
        { status: ExternalIssueStatus.FAILED },
        {
          status: ExternalIssueStatus.PENDING,
          updatedAt: { lt: new Date(Date.now() - STALE_PENDING_MS) },
        },
      ],
    },
    data: { status: ExternalIssueStatus.PENDING, lastError: null },
  })
  if (retried.count === 1) return
  const existing = await prisma.bugExternalIssue.findUnique({
    where: { bugId_provider: { bugId, provider } },
    select: issueSelect,
  })
  if (existing?.status === ExternalIssueStatus.EXPORTED) {
    throw new ConflictError(`This bug is already in Jira as ${existing.key}`, {
      key: existing.key,
      url: existing.url,
    })
  }
  throw new ConflictError('This bug is being exported right now')
}

export async function exportBug(user: Express.AuthenticatedUser, bugId: string) {
  const { relations, bug } = await resolveBug(user, bugId)
  authorize(user, 'bug.export', relations)

  const c = await prisma.bugTrackerConnection.findUnique({
    where: { organisationId: bug.organisationId },
  })
  if (!c) throw new BadRequestError('This organisation has no Jira connection yet')

  await claim(bugId)
  const where = { bugId_provider: { bugId, provider: BugTrackerProvider.JIRA_CLOUD } }

  let error: string
  try {
    const fields = await issueFields(bugId, c)
    let res = await callJira(c, '/rest/api/2/issue', { method: 'POST', body: { fields } })
    // Many Jira projects do not have priority on their create screen.
    if (res.status === 400 && jiraFieldNames(res.json).includes('priority')) {
      const { priority: _priority, ...rest } = fields
      res = await callJira(c, '/rest/api/2/issue', { method: 'POST', body: { fields: rest } })
    }
    const created = res.json as { id?: unknown; key?: unknown } | null
    if (
      res.status === 201 &&
      typeof created?.key === 'string' &&
      /^[A-Z][A-Z0-9_]*-\d+$/.test(created.key)
    ) {
      return await prisma.bugExternalIssue.update({
        where,
        data: {
          status: ExternalIssueStatus.EXPORTED,
          externalId: typeof created.id === 'string' ? created.id.slice(0, 64) : null,
          key: created.key,
          url: `${c.siteUrl}/browse/${created.key}`,
          lastError: null,
        },
        select: issueSelect,
      })
    }
    error =
      res.status === 201
        ? 'Jira answered without an issue key'
        : jiraMessage(res.status, res.json, c.projectKey)
  } catch (e) {
    error = e instanceof BadRequestError ? e.message : 'The export failed'
  }
  await prisma.bugExternalIssue.update({
    where,
    data: { status: ExternalIssueStatus.FAILED, lastError: error },
  })
  throw new BadRequestError(error)
}

/** Each bug is checked and exported on its own; one failure does not stop the rest. */
export async function bulkExport(user: Express.AuthenticatedUser, ids: string[]) {
  const exported: { id: string; key: string | null; url: string | null }[] = []
  const skipped: { id: string; reason: string }[] = []
  for (const id of [...new Set(ids)]) {
    try {
      const issue = await exportBug(user, id)
      exported.push({ id, key: issue.key, url: issue.url })
    } catch (e) {
      skipped.push({ id, reason: e instanceof Error ? e.message : 'The export failed' })
    }
  }
  return { exported, skipped }
}
