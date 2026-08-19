import { Router } from 'express'
import { z } from 'zod'
import { DeviceType, OsKind, type Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { param } from '../../lib/http.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requireRole } from '../../middleware/authorize.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { NotFoundError, ConflictError } from '../../lib/errors.js'
import { recordAudit } from '../../lib/audit.js'
import { Role } from '@prisma/client'

/**
 * §18 Global Assets — the device / browser reference catalog.
 *
 * Recovers ten legacy tables (`mobile_brands`, `mobile_os_type`, `os`,
 * `mobile_os_version`, `os_versions`, `browsers`, `browser_versions`,
 * `network_providers`, the catalog half of `devices`, and `user_browsers`).
 *
 * ── Why reads are open to any authenticated user
 *
 * This is GLOBAL reference data, not tenant data: brand names and browser
 * versions are public facts. Every tester needs to read it to describe their
 * own kit, so gating reads behind an admin permission would make the tester
 * device form unusable. There is deliberately no `organisationId` on any
 * catalog row — see the schema comment for why per-tenant copies would defeat
 * the point. Writes are admin-side only.
 *
 * ── Why `isActive` rather than deletion
 *
 * Tester records point at catalog rows. Deleting a retired browser version
 * would either orphan or cascade those. Retiring sets `isActive = false`:
 * it disappears from pickers, existing references keep resolving. `?all=true`
 * lets the admin UI show retired rows so they can be brought back.
 */
export const catalogRouter = Router()

catalogRouter.use(authenticate)

const adminOnly = requireRole(Role.ADMIN, Role.SUB_ADMIN)
const listQuery = z.object({
  all: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  search: z.string().trim().max(120).optional(),
})
type ListQuery = z.infer<typeof listQuery>

/** Active-only unless `?all=true`. */
function activeFilter(q: ListQuery): { isActive?: boolean } {
  return q.all ? {} : { isActive: true }
}

// ─── Aggregate read ──────────────────────────────────────────────────────────

/**
 * The whole catalog in one call.
 *
 * The tester device form needs brands, models, OSes, versions, browsers and
 * carriers simultaneously to drive its dependent selects. Six round trips to
 * render one form is worse than one payload of a few hundred rows, and the
 * data is small and highly cacheable.
 */
catalogRouter.get('/', validate({ query: listQuery }), async (_req, res) => {
  const q = validatedQuery<ListQuery>(res)
  const where = activeFilter(q)

  const [brands, deviceModels, operatingSystems, browsers, networks, skillCategories] =
    await Promise.all([
      prisma.deviceBrand.findMany({ where, orderBy: { name: 'asc' } }),
      prisma.deviceModel.findMany({
        where,
        select: {
          id: true,
          name: true,
          type: true,
          ramGb: true,
          screenSize: true,
          isActive: true,
          brand: { select: { id: true, name: true } },
          defaultOs: { select: { id: true, name: true, kind: true } },
        },
        orderBy: [{ brand: { name: 'asc' } }, { name: 'asc' }],
      }),
      prisma.operatingSystem.findMany({
        where,
        select: {
          id: true,
          name: true,
          kind: true,
          isActive: true,
          versions: {
            where: activeFilter(q),
            select: { id: true, version: true, isActive: true },
            orderBy: { version: 'asc' },
          },
        },
        orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      }),
      prisma.browser.findMany({
        where,
        select: {
          id: true,
          name: true,
          isActive: true,
          versions: {
            where: activeFilter(q),
            select: { id: true, version: true, isActive: true },
            orderBy: { version: 'asc' },
          },
        },
        orderBy: { name: 'asc' },
      }),
      prisma.networkProvider.findMany({
        where,
        orderBy: [{ countryCode: 'asc' }, { name: 'asc' }],
      }),
      prisma.skillCategory.findMany({
        where,
        select: {
          id: true,
          name: true,
          slug: true,
          isActive: true,
          skills: {
            where: activeFilter(q),
            select: {
              id: true,
              name: true,
              slug: true,
              isActive: true,
              _count: { select: { testers: true } },
            },
            orderBy: { name: 'asc' },
          },
        },
        orderBy: { name: 'asc' },
      }),
    ])

  res.json({
    data: { brands, deviceModels, operatingSystems, browsers, networks, skillCategories },
  })
})

// ─── Device brands ───────────────────────────────────────────────────────────

const brandBody = z.object({
  name: z.string().trim().min(1).max(120),
  isActive: z.boolean().optional(),
})

catalogRouter.post('/brands', adminOnly, validate({ body: brandBody }), async (req, res) => {
  const input = req.body as z.infer<typeof brandBody>
  const existing = await prisma.deviceBrand.findUnique({
    where: { name: input.name },
    select: { id: true },
  })
  if (existing) throw new ConflictError('A brand with this name already exists')

  const brand = await prisma.deviceBrand.create({ data: { name: input.name } })
  await recordAudit({
    req,
    action: 'catalog.brand_created',
    entityType: 'DeviceBrand',
    entityId: brand.id,
    after: { name: brand.name },
  })
  res.status(201).json({ data: brand })
})

const idParam = z.object({ id: z.string().cuid() })
const toggleBody = z.object({ isActive: z.boolean() })

catalogRouter.patch(
  '/brands/:id',
  adminOnly,
  validate({ params: idParam, body: toggleBody }),
  async (req, res) => {
    const brand = await prisma.deviceBrand
      .update({
        where: { id: param(req, 'id') },
        data: { isActive: (req.body as z.infer<typeof toggleBody>).isActive },
      })
      .catch(() => null)
    if (!brand) throw new NotFoundError('Brand')
    await recordAudit({
      req,
      action: 'catalog.brand_updated',
      entityType: 'DeviceBrand',
      entityId: brand.id,
      after: { isActive: brand.isActive },
    })
    res.json({ data: brand })
  },
)

// ─── Device models ───────────────────────────────────────────────────────────

const modelBody = z.object({
  brandId: z.string().cuid(),
  name: z.string().trim().min(1).max(160),
  type: z.nativeEnum(DeviceType),
  defaultOsId: z.string().cuid().nullable().optional(),
  ramGb: z.string().trim().max(20).optional(),
  screenSize: z.string().trim().max(40).optional(),
})

catalogRouter.post('/models', adminOnly, validate({ body: modelBody }), async (req, res) => {
  const input = req.body as z.infer<typeof modelBody>

  const brand = await prisma.deviceBrand.findUnique({
    where: { id: input.brandId },
    select: { id: true },
  })
  if (!brand) throw new NotFoundError('Brand')

  const clash = await prisma.deviceModel.findUnique({
    where: { brandId_name: { brandId: input.brandId, name: input.name } },
    select: { id: true },
  })
  if (clash) throw new ConflictError('That brand already has a model with this name')

  const model = await prisma.deviceModel.create({
    data: {
      brandId: input.brandId,
      name: input.name,
      type: input.type,
      defaultOsId: input.defaultOsId ?? null,
      ramGb: input.ramGb ?? null,
      screenSize: input.screenSize ?? null,
    },
    select: {
      id: true,
      name: true,
      type: true,
      ramGb: true,
      screenSize: true,
      isActive: true,
      brand: { select: { id: true, name: true } },
      defaultOs: { select: { id: true, name: true, kind: true } },
    },
  })
  await recordAudit({
    req,
    action: 'catalog.model_created',
    entityType: 'DeviceModel',
    entityId: model.id,
    after: { name: model.name, brand: model.brand.name },
  })
  res.status(201).json({ data: model })
})

catalogRouter.patch(
  '/models/:id',
  adminOnly,
  validate({ params: idParam, body: toggleBody }),
  async (req, res) => {
    const model = await prisma.deviceModel
      .update({
        where: { id: param(req, 'id') },
        data: { isActive: (req.body as z.infer<typeof toggleBody>).isActive },
      })
      .catch(() => null)
    if (!model) throw new NotFoundError('Device model')
    await recordAudit({
      req,
      action: 'catalog.model_updated',
      entityType: 'DeviceModel',
      entityId: model.id,
      after: { isActive: model.isActive },
    })
    res.json({ data: model })
  },
)

// ─── Operating systems + versions ────────────────────────────────────────────

const osBody = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.nativeEnum(OsKind),
})

catalogRouter.post('/operating-systems', adminOnly, validate({ body: osBody }), async (req, res) => {
  const input = req.body as z.infer<typeof osBody>
  const clash = await prisma.operatingSystem.findUnique({
    where: { name_kind: { name: input.name, kind: input.kind } },
    select: { id: true },
  })
  if (clash) throw new ConflictError('That operating system already exists for this kind')

  const os = await prisma.operatingSystem.create({ data: input })
  await recordAudit({
    req,
    action: 'catalog.os_created',
    entityType: 'OperatingSystem',
    entityId: os.id,
    after: { name: os.name, kind: os.kind },
  })
  res.status(201).json({ data: os })
})

const versionBody = z.object({ version: z.string().trim().min(1).max(60) })

catalogRouter.post(
  '/operating-systems/:id/versions',
  adminOnly,
  validate({ params: idParam, body: versionBody }),
  async (req, res) => {
    const osId = param(req, 'id')
    const os = await prisma.operatingSystem.findUnique({ where: { id: osId }, select: { id: true } })
    if (!os) throw new NotFoundError('Operating system')

    const { version } = req.body as z.infer<typeof versionBody>
    const clash = await prisma.osVersion.findUnique({
      where: { operatingSystemId_version: { operatingSystemId: osId, version } },
      select: { id: true },
    })
    if (clash) throw new ConflictError('That version already exists for this operating system')

    const row = await prisma.osVersion.create({ data: { operatingSystemId: osId, version } })
    await recordAudit({
      req,
      action: 'catalog.os_version_created',
      entityType: 'OsVersion',
      entityId: row.id,
      after: { version },
    })
    res.status(201).json({ data: row })
  },
)

// ─── Browsers + versions ─────────────────────────────────────────────────────

const browserBody = z.object({ name: z.string().trim().min(1).max(120) })

catalogRouter.post('/browsers', adminOnly, validate({ body: browserBody }), async (req, res) => {
  const { name } = req.body as z.infer<typeof browserBody>
  const clash = await prisma.browser.findUnique({ where: { name }, select: { id: true } })
  if (clash) throw new ConflictError('A browser with this name already exists')

  const browser = await prisma.browser.create({ data: { name } })
  await recordAudit({
    req,
    action: 'catalog.browser_created',
    entityType: 'Browser',
    entityId: browser.id,
    after: { name },
  })
  res.status(201).json({ data: browser })
})

catalogRouter.post(
  '/browsers/:id/versions',
  adminOnly,
  validate({ params: idParam, body: versionBody }),
  async (req, res) => {
    const browserId = param(req, 'id')
    const browser = await prisma.browser.findUnique({
      where: { id: browserId },
      select: { id: true },
    })
    if (!browser) throw new NotFoundError('Browser')

    const { version } = req.body as z.infer<typeof versionBody>
    const clash = await prisma.browserVersion.findUnique({
      where: { browserId_version: { browserId, version } },
      select: { id: true },
    })
    if (clash) throw new ConflictError('That version already exists for this browser')

    const row = await prisma.browserVersion.create({ data: { browserId, version } })
    await recordAudit({
      req,
      action: 'catalog.browser_version_created',
      entityType: 'BrowserVersion',
      entityId: row.id,
      after: { version },
    })
    res.status(201).json({ data: row })
  },
)

// ─── Network providers ───────────────────────────────────────────────────────

const networkBody = z.object({
  name: z.string().trim().min(1).max(120),
  countryCode: z.string().trim().length(2).toUpperCase().optional(),
})

catalogRouter.post('/networks', adminOnly, validate({ body: networkBody }), async (req, res) => {
  const input = req.body as z.infer<typeof networkBody>
  const row = await prisma.networkProvider.create({
    data: { name: input.name, countryCode: input.countryCode ?? null },
  })
  await recordAudit({
    req,
    action: 'catalog.network_created',
    entityType: 'NetworkProvider',
    entityId: row.id,
    after: { name: row.name, countryCode: row.countryCode },
  })
  res.status(201).json({ data: row })
})

// ─── Skill categories + skills (legacy `skill_categories` / `skills`) ────────
//
// Skill *creation* lives here, admin-only, same as every other catalog entity
// — a tester picks from this list (`testers.service.ts` `setSkills`) but can
// no longer type a new skill into existence, which is what let the legacy
// free-text field accumulate near-duplicates in the first place.

const skillCategoryBody = z.object({ name: z.string().trim().min(1).max(120) })

catalogRouter.post(
  '/skill-categories',
  adminOnly,
  validate({ body: skillCategoryBody }),
  async (req, res) => {
    const { name } = req.body as z.infer<typeof skillCategoryBody>
    const slug = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    const clash = await prisma.skillCategory.findUnique({ where: { slug }, select: { id: true } })
    if (clash) throw new ConflictError('A skill category with this name already exists')

    const row = await prisma.skillCategory.create({ data: { name, slug } })
    await recordAudit({
      req,
      action: 'catalog.skill_category_created',
      entityType: 'SkillCategory',
      entityId: row.id,
      after: { name: row.name },
    })
    res.status(201).json({ data: row })
  },
)

catalogRouter.patch(
  '/skill-categories/:id',
  adminOnly,
  validate({ params: idParam, body: toggleBody }),
  async (req, res) => {
    const row = await prisma.skillCategory
      .update({
        where: { id: param(req, 'id') },
        data: { isActive: (req.body as z.infer<typeof toggleBody>).isActive },
      })
      .catch(() => null)
    if (!row) throw new NotFoundError('Skill category')
    await recordAudit({
      req,
      action: 'catalog.skill_category_updated',
      entityType: 'SkillCategory',
      entityId: row.id,
      after: { isActive: row.isActive },
    })
    res.json({ data: row })
  },
)

const skillBody = z.object({
  name: z.string().trim().min(1).max(120),
  categoryId: z.string().cuid(),
})

catalogRouter.post('/skills', adminOnly, validate({ body: skillBody }), async (req, res) => {
  const input = req.body as z.infer<typeof skillBody>
  const category = await prisma.skillCategory.findUnique({
    where: { id: input.categoryId },
    select: { id: true },
  })
  if (!category) throw new NotFoundError('Skill category')

  const slug = input.name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const clash = await prisma.skill.findUnique({ where: { slug }, select: { id: true } })
  if (clash) throw new ConflictError('A skill with this name already exists')

  const row = await prisma.skill.create({
    data: { name: input.name, slug, categoryId: input.categoryId },
  })
  await recordAudit({
    req,
    action: 'catalog.skill_created',
    entityType: 'Skill',
    entityId: row.id,
    after: { name: row.name, category: category.id },
  })
  res.status(201).json({ data: row })
})

const skillUpdateBody = z.object({
  categoryId: z.string().cuid().optional(),
  isActive: z.boolean().optional(),
})

catalogRouter.patch('/skills/:id', adminOnly, validate({ params: idParam, body: skillUpdateBody }), async (req, res) => {
  const input = req.body as z.infer<typeof skillUpdateBody>
  if (input.categoryId) {
    const category = await prisma.skillCategory.findUnique({
      where: { id: input.categoryId },
      select: { id: true },
    })
    if (!category) throw new NotFoundError('Skill category')
  }

  const row = await prisma.skill
    .update({ where: { id: param(req, 'id') }, data: input })
    .catch(() => null)
  if (!row) throw new NotFoundError('Skill')
  await recordAudit({
    req,
    action: 'catalog.skill_updated',
    entityType: 'Skill',
    entityId: row.id,
    after: input,
  })
  res.json({ data: row })
})

// ─── Tester's own browsers (legacy `user_browsers`) ──────────────────────────

const testerBrowserBody = z.object({
  browserId: z.string().cuid(),
  browserVersionId: z.string().cuid().nullable().optional(),
  operatingSystemId: z.string().cuid().nullable().optional(),
})

/**
 * The caller's own browser list. Scoped to their profile — a tester can only
 * ever read or write their own rows, which is why there is no id in the path.
 */
async function ownProfileId(userId: string): Promise<string> {
  const profile = await prisma.testerProfile.findUnique({
    where: { userId },
    select: { id: true },
  })
  if (!profile) throw new NotFoundError('Tester profile')
  return profile.id
}

const testerBrowserSelect = {
  id: true,
  createdAt: true,
  browser: { select: { id: true, name: true } },
  browserVersion: { select: { id: true, version: true } },
  operatingSystem: { select: { id: true, name: true, kind: true } },
} satisfies Prisma.TesterBrowserSelect

catalogRouter.get('/me/browsers', requireRole(Role.TESTER), async (req, res) => {
  const testerProfileId = await ownProfileId(req.user!.id)
  const rows = await prisma.testerBrowser.findMany({
    where: { testerProfileId },
    select: testerBrowserSelect,
    orderBy: { createdAt: 'asc' },
  })
  res.json({ data: rows })
})

catalogRouter.post(
  '/me/browsers',
  requireRole(Role.TESTER),
  validate({ body: testerBrowserBody }),
  async (req, res) => {
    const testerProfileId = await ownProfileId(req.user!.id)
    const input = req.body as z.infer<typeof testerBrowserBody>

    const browser = await prisma.browser.findUnique({
      where: { id: input.browserId },
      select: { id: true },
    })
    if (!browser) throw new NotFoundError('Browser')

    // The unique index covers (tester, browser, version) but treats NULL
    // versions as distinct in Postgres, so an explicit pre-check is what
    // actually stops "Chrome / no version" being added twice.
    const clash = await prisma.testerBrowser.findFirst({
      where: {
        testerProfileId,
        browserId: input.browserId,
        browserVersionId: input.browserVersionId ?? null,
      },
      select: { id: true },
    })
    if (clash) throw new ConflictError('That browser and version is already on your profile')

    const row = await prisma.testerBrowser.create({
      data: {
        testerProfileId,
        browserId: input.browserId,
        browserVersionId: input.browserVersionId ?? null,
        operatingSystemId: input.operatingSystemId ?? null,
      },
      select: testerBrowserSelect,
    })
    res.status(201).json({ data: row })
  },
)

catalogRouter.delete(
  '/me/browsers/:id',
  requireRole(Role.TESTER),
  validate({ params: idParam }),
  async (req, res) => {
    const testerProfileId = await ownProfileId(req.user!.id)
    // Delete by (id AND owner) so a guessed id belonging to another tester
    // matches nothing rather than deleting their row.
    const result = await prisma.testerBrowser.deleteMany({
      where: { id: param(req, 'id'), testerProfileId },
    })
    if (result.count === 0) throw new NotFoundError('Browser')
    res.status(204).send()
  },
)
