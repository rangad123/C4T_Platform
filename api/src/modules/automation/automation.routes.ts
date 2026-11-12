import { Router, type Request } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { param } from '../../lib/http.js'
import { recordAudit } from '../../lib/audit.js'
import { BadRequestError, NotFoundError } from '../../lib/errors.js'
import { projectRelations } from '../../lib/access/relations.js'
import { authorize, can } from '../../lib/access/policy.js'
import { authenticate } from '../../middleware/authenticate.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { resolveBuildId } from '../projects/projects.service.js'

/**
 * Automation modules and reports, per build (legacy `automation_modules` /
 * `automation_reports`). Recording only: nothing here runs a suite.
 *
 * Access is the project's, through the existing policy, no new rule:
 *   read   — `project.read_brief`: the admin side, the owning customer, the
 *            project's managers, and testers accepted onto it (now or before)
 *   manage — `project.manage_materials`: the admin side, managers and the
 *            owning customer
 * Someone who cannot read the project gets a 404, never a 403, so a project
 * id cannot be probed.
 */
export const automationRouter = Router()

automationRouter.use(authenticate)

const id = z.string().cuid()
const text = (max: number) => z.string().trim().min(1).max(max)

const moduleBody = z
  .object({
    name: text(200),
    framework: text(100).nullable().optional(),
    repositoryUrl: z.string().trim().url().max(2000).startsWith('https://').nullable().optional(),
    owner: text(200).nullable().optional(),
  })
  .strict()

const reportBody = z
  .object({
    buildId: id.optional(),
    moduleId: id.nullable().optional(),
    runAt: z.coerce.date(),
    passed: z.number().int().min(0).max(1_000_000),
    failed: z.number().int().min(0).max(1_000_000),
    skipped: z.number().int().min(0).max(1_000_000),
    durationSeconds: z.number().int().min(0).max(31_536_000).nullable().optional(),
    fileId: id.nullable().optional(),
    notes: text(5000).nullable().optional(),
  })
  .strict()

async function access(user: Express.AuthenticatedUser, projectId: string) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read_brief', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  return resolved.relations
}

async function requireManage(user: Express.AuthenticatedUser, projectId: string) {
  authorize(user, 'project.manage_materials', await access(user, projectId))
}

/** Same rule as project materials: only a file the caller uploaded themselves. */
async function assertOwnUpload(user: Express.AuthenticatedUser, fileId: string | null | undefined) {
  if (!fileId) return
  const file = await prisma.fileObject.findFirst({
    where: { id: fileId, uploadedById: user.id, isComplete: true },
    select: { id: true },
  })
  if (!file) throw new BadRequestError('That upload could not be found. Upload the file again.')
}

async function assertModuleOnBuild(moduleId: string | null | undefined, buildId: string) {
  if (!moduleId) return
  const found = await prisma.automationModule.findFirst({
    where: { id: moduleId, buildId },
    select: { id: true },
  })
  if (!found) throw new BadRequestError('That module is not on this build')
}

function audit(req: Request, action: string, entityType: string, entityId: string, after?: object) {
  return recordAudit({ req, action, entityType, entityId, ...(after ? { after } : {}) })
}

// ─── Read ────────────────────────────────────────────────────────────────────

automationRouter.get(
  '/projects/:projectId',
  validate({ params: z.object({ projectId: id }), query: z.object({ buildId: id.optional() }) }),
  async (req, res) => {
    const projectId = param(req, 'projectId')
    const relations = await access(req.user!, projectId)
    const { buildId: requested } = validatedQuery<{ buildId?: string }>(res)
    const buildId = await resolveBuildId(projectId, requested)

    const [modules, reports] = await Promise.all([
      prisma.automationModule.findMany({
        where: { buildId },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          framework: true,
          repositoryUrl: true,
          owner: true,
          createdAt: true,
        },
      }),
      prisma.automationReport.findMany({
        where: { buildId },
        orderBy: { runAt: 'desc' },
        take: 200,
        select: {
          id: true,
          runAt: true,
          passed: true,
          failed: true,
          skipped: true,
          durationSeconds: true,
          notes: true,
          module: { select: { id: true, name: true } },
          file: { select: { id: true, originalName: true, isComplete: true } },
        },
      }),
    ])

    res.json({
      data: {
        buildId,
        canManage: can(req.user!, 'project.manage_materials', relations),
        modules,
        reports,
      },
    })
  },
)

// ─── Modules ─────────────────────────────────────────────────────────────────

automationRouter.post(
  '/projects/:projectId/modules',
  validate({
    params: z.object({ projectId: id }),
    body: moduleBody.extend({ buildId: id.optional() }),
  }),
  async (req, res) => {
    const projectId = param(req, 'projectId')
    await requireManage(req.user!, projectId)
    const { buildId: requested, ...input } = req.body as z.infer<typeof moduleBody> & {
      buildId?: string
    }
    const buildId = await resolveBuildId(projectId, requested)
    const created = await prisma.automationModule.create({
      data: { ...input, projectId, buildId },
    })
    await audit(req, 'automation.module.created', 'AutomationModule', created.id, {
      name: created.name,
    })
    res.status(201).json({ data: created })
  },
)

async function findModule(user: Express.AuthenticatedUser, moduleId: string) {
  const found = await prisma.automationModule.findUnique({
    where: { id: moduleId },
    select: { id: true, projectId: true },
  })
  if (!found) throw new NotFoundError('Module')
  await requireManage(user, found.projectId)
  return found
}

automationRouter.patch(
  '/modules/:id',
  validate({ params: z.object({ id }), body: moduleBody.partial() }),
  async (req, res) => {
    const found = await findModule(req.user!, param(req, 'id'))
    const updated = await prisma.automationModule.update({
      where: { id: found.id },
      data: req.body as Partial<z.infer<typeof moduleBody>>,
    })
    await audit(req, 'automation.module.updated', 'AutomationModule', found.id, req.body as object)
    res.json({ data: updated })
  },
)

automationRouter.delete(
  '/modules/:id',
  validate({ params: z.object({ id }) }),
  async (req, res) => {
    const found = await findModule(req.user!, param(req, 'id'))
    await prisma.automationModule.delete({ where: { id: found.id } })
    await audit(req, 'automation.module.deleted', 'AutomationModule', found.id)
    res.status(204).end()
  },
)

// ─── Reports ─────────────────────────────────────────────────────────────────

automationRouter.post(
  '/projects/:projectId/reports',
  validate({ params: z.object({ projectId: id }), body: reportBody }),
  async (req, res) => {
    const projectId = param(req, 'projectId')
    await requireManage(req.user!, projectId)
    const { buildId: requested, ...input } = req.body as z.infer<typeof reportBody>
    const buildId = await resolveBuildId(projectId, requested)
    await assertModuleOnBuild(input.moduleId, buildId)
    await assertOwnUpload(req.user!, input.fileId)
    const created = await prisma.automationReport.create({
      data: { ...input, projectId, buildId },
    })
    await audit(req, 'automation.report.created', 'AutomationReport', created.id, {
      buildId,
      passed: created.passed,
      failed: created.failed,
      skipped: created.skipped,
    })
    res.status(201).json({ data: created })
  },
)

automationRouter.delete(
  '/reports/:id',
  validate({ params: z.object({ id }) }),
  async (req, res) => {
    const found = await prisma.automationReport.findUnique({
      where: { id: param(req, 'id') },
      select: { id: true, projectId: true },
    })
    if (!found) throw new NotFoundError('Report')
    await requireManage(req.user!, found.projectId)
    await prisma.automationReport.delete({ where: { id: found.id } })
    await audit(req, 'automation.report.deleted', 'AutomationReport', found.id)
    res.status(204).end()
  },
)
