import {
  PrismaClient,
  Role,
  UserStatus,
  TesterStatus,
  OrganisationStatus,
  OrgMemberRole,
  DeviceType,
  BugSeverity,
  BugStatus,
  TransactionType,
  TransactionStatus,
  AnnouncementAudience,
  RatingSubjectType,
  ProjectPriority,
  ProjectStatus,
} from '@prisma/client'
import argon2 from 'argon2'
import { PERMISSION_CATALOGUE, DEFAULT_SUBADMIN_PERMISSIONS } from '../src/config/permissions.js'

const prisma = new PrismaClient()

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@crowd4test.com'
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!2026'
const SEED_DEMO = process.env.NODE_ENV !== 'production'

function hash(plain: string) {
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  })
}

/**
 * Idempotent seed. Safe to re-run.
 *
 *   Always:      the permission catalogue and one bootstrap ADMIN.
 *   Non-prod:    a small demo dataset so the Admin panel has something to show.
 */
async function main() {
  console.log('Seeding permission catalogue…')
  for (const permission of PERMISSION_CATALOGUE) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      create: permission,
      update: {
        group: permission.group,
        label: permission.label,
        description: permission.description,
      },
    })
  }
  console.log(`  ${PERMISSION_CATALOGUE.length} permissions ready`)

  console.log('Seeding bootstrap administrator…')
  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    create: {
      email: ADMIN_EMAIL,
      passwordHash: await hash(ADMIN_PASSWORD),
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
      firstName: 'Platform',
      lastName: 'Administrator',
      countryCode: 'IN',
    },
    update: {},
    select: { id: true, email: true },
  })
  console.log(`  admin: ${admin.email}`)

  if (!SEED_DEMO) {
    console.log('NODE_ENV=production — skipping demo data.')
    return
  }

  console.log('Seeding demo data…')

  // ─── Sub-Admin with a restricted grant set ─────────────────────────────────
  const subAdmin = await prisma.user.upsert({
    where: { email: 'manager@crowd4test.com' },
    create: {
      email: 'manager@crowd4test.com',
      passwordHash: await hash('ChangeMe!2026'),
      role: Role.SUB_ADMIN,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
      firstName: 'Priya',
      lastName: 'Menon',
      countryCode: 'IN',
    },
    update: {},
    select: { id: true },
  })

  const grantable = await prisma.permission.findMany({
    where: { code: { in: DEFAULT_SUBADMIN_PERMISSIONS } },
    select: { id: true },
  })
  for (const permission of grantable) {
    await prisma.userPermission.upsert({
      where: { userId_permissionId: { userId: subAdmin.id, permissionId: permission.id } },
      create: { userId: subAdmin.id, permissionId: permission.id, grantedById: admin.id },
      update: {},
    })
  }

  // ─── Customer organisation and owner ───────────────────────────────────────
  const customer = await prisma.user.upsert({
    where: { email: 'customer@example.com' },
    create: {
      email: 'customer@example.com',
      passwordHash: await hash('ChangeMe!2026'),
      role: Role.CUSTOMER,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
      firstName: 'Arjun',
      lastName: 'Rao',
      countryCode: 'IN',
    },
    update: {},
    select: { id: true },
  })

  const org = await prisma.organisation.upsert({
    where: { slug: 'northwind-fintech' },
    create: {
      name: 'Northwind Fintech',
      slug: 'northwind-fintech',
      status: OrganisationStatus.ACTIVE,
      industry: 'Banking & Finance',
      contactEmail: 'customer@example.com',
      countryCode: 'IN',
      city: 'Bengaluru',
      onboardedAt: new Date(),
    },
    update: {},
    select: { id: true },
  })

  await prisma.organisationMember.upsert({
    where: { organisationId_userId: { organisationId: org.id, userId: customer.id } },
    create: {
      organisationId: org.id,
      userId: customer.id,
      orgRole: OrgMemberRole.OWNER,
      joinedAt: new Date(),
    },
    update: {},
  })

  // ─── Device / browser catalog (§18 Global Assets) ──────────────────────────
  // Recovers the legacy `mobile_brands` / `os` / `browsers` / `network_providers`
  // reference tables. Global, not tenant-scoped — a Galaxy S24 is the same
  // device for every customer. Everything is upserted on a natural key, so
  // re-seeding never duplicates and never clobbers admin edits to `isActive`.
  console.log('Seeding device/browser catalog…')

  const osSeeds: { name: string; kind: 'MOBILE' | 'DESKTOP'; versions: string[] }[] = [
    { name: 'Android', kind: 'MOBILE', versions: ['12', '13', '14', '15'] },
    { name: 'iOS', kind: 'MOBILE', versions: ['16', '17', '18'] },
    { name: 'iPadOS', kind: 'MOBILE', versions: ['17', '18'] },
    { name: 'Windows', kind: 'DESKTOP', versions: ['10', '11'] },
    { name: 'macOS', kind: 'DESKTOP', versions: ['13 Ventura', '14 Sonoma', '15 Sequoia'] },
    { name: 'Linux', kind: 'DESKTOP', versions: ['Ubuntu 22.04', 'Ubuntu 24.04', 'Fedora 40'] },
  ]
  const osByName = new Map<string, string>()
  for (const o of osSeeds) {
    const row = await prisma.operatingSystem.upsert({
      where: { name_kind: { name: o.name, kind: o.kind } },
      create: { name: o.name, kind: o.kind },
      update: {},
      select: { id: true },
    })
    osByName.set(o.name, row.id)
    for (const v of o.versions) {
      await prisma.osVersion.upsert({
        where: { operatingSystemId_version: { operatingSystemId: row.id, version: v } },
        create: { operatingSystemId: row.id, version: v },
        update: {},
      })
    }
  }

  const browserSeeds: { name: string; versions: string[] }[] = [
    { name: 'Chrome', versions: ['126', '127', '128'] },
    { name: 'Safari', versions: ['17', '18'] },
    { name: 'Firefox', versions: ['128', '129'] },
    { name: 'Edge', versions: ['127', '128'] },
    { name: 'Samsung Internet', versions: ['25', '26'] },
  ]
  for (const b of browserSeeds) {
    const row = await prisma.browser.upsert({
      where: { name: b.name },
      create: { name: b.name },
      update: {},
      select: { id: true },
    })
    for (const v of b.versions) {
      await prisma.browserVersion.upsert({
        where: { browserId_version: { browserId: row.id, version: v } },
        create: { browserId: row.id, version: v },
        update: {},
      })
    }
  }

  for (const n of [
    { name: 'Airtel', countryCode: 'IN' },
    { name: 'Jio', countryCode: 'IN' },
    { name: 'Vodafone Idea', countryCode: 'IN' },
    { name: 'Verizon', countryCode: 'US' },
    { name: 'AT&T', countryCode: 'US' },
    { name: 'T-Mobile', countryCode: 'US' },
    { name: 'Vodafone', countryCode: 'GB' },
    { name: 'EE', countryCode: 'GB' },
  ]) {
    await prisma.networkProvider.upsert({
      where: { name_countryCode: { name: n.name, countryCode: n.countryCode } },
      create: n,
      update: {},
    })
  }

  const deviceSeeds: {
    brand: string
    models: { name: string; type: DeviceType; os: string; ramGb?: string; screenSize?: string }[]
  }[] = [
    {
      brand: 'Google',
      models: [
        { name: 'Pixel 7a', type: DeviceType.MOBILE, os: 'Android', ramGb: '8', screenSize: '6.1' },
        { name: 'Pixel 8 Pro', type: DeviceType.MOBILE, os: 'Android', ramGb: '12', screenSize: '6.7' },
      ],
    },
    {
      brand: 'Apple',
      models: [
        { name: 'iPhone 13', type: DeviceType.MOBILE, os: 'iOS', ramGb: '4', screenSize: '6.1' },
        { name: 'iPhone 15 Pro', type: DeviceType.MOBILE, os: 'iOS', ramGb: '8', screenSize: '6.1' },
        { name: 'iPad Air (M2)', type: DeviceType.TABLET, os: 'iPadOS', ramGb: '8', screenSize: '11' },
        { name: 'MacBook Pro 14"', type: DeviceType.DESKTOP, os: 'macOS', ramGb: '18', screenSize: '14.2' },
      ],
    },
    {
      brand: 'Samsung',
      models: [
        { name: 'Galaxy S24', type: DeviceType.MOBILE, os: 'Android', ramGb: '8', screenSize: '6.2' },
        { name: 'Galaxy Tab S9', type: DeviceType.TABLET, os: 'Android', ramGb: '8', screenSize: '11' },
      ],
    },
    {
      brand: 'Xiaomi',
      models: [
        { name: 'Redmi Note 12', type: DeviceType.MOBILE, os: 'Android', ramGb: '6', screenSize: '6.67' },
      ],
    },
    {
      brand: 'Dell',
      models: [
        { name: 'XPS 15', type: DeviceType.DESKTOP, os: 'Windows', ramGb: '16', screenSize: '15.6' },
      ],
    },
  ]
  for (const b of deviceSeeds) {
    const brand = await prisma.deviceBrand.upsert({
      where: { name: b.brand },
      create: { name: b.brand },
      update: {},
      select: { id: true },
    })
    for (const m of b.models) {
      await prisma.deviceModel.upsert({
        where: { brandId_name: { brandId: brand.id, name: m.name } },
        create: {
          brandId: brand.id,
          name: m.name,
          type: m.type,
          defaultOsId: osByName.get(m.os) ?? null,
          ramGb: m.ramGb ?? null,
          screenSize: m.screenSize ?? null,
        },
        update: {},
      })
    }
  }
  console.log('  catalog ready')

  // ─── Skills catalogue ──────────────────────────────────────────────────────
  const skillNames = [
    'Manual Testing',
    'Automation Testing',
    'Security Testing',
    'Localization Testing',
    'Payment Testing',
    'API Testing',
    'Accessibility Testing',
    'Performance Testing',
  ]
  const skills = await Promise.all(
    skillNames.map((name) => {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      return prisma.skill.upsert({
        where: { slug },
        create: { name, slug },
        update: {},
        select: { id: true, slug: true },
      })
    }),
  )

  // ─── Verified testers ──────────────────────────────────────────────────────
  const testerSeeds = [
    {
      email: 'tester1@example.com',
      firstName: 'Hrvoje',
      lastName: 'Nikolic',
      country: 'HR',
      device: 'Pixel 7a',
    },
    {
      email: 'tester2@example.com',
      firstName: 'Minerva',
      lastName: 'Cisneros',
      country: 'MX',
      device: 'iPhone 13',
    },
    {
      email: 'tester3@example.com',
      firstName: 'Shubham',
      lastName: 'Kumar',
      country: 'IN',
      device: 'Redmi Note 12',
    },
  ]

  for (const [index, seed] of testerSeeds.entries()) {
    const user = await prisma.user.upsert({
      where: { email: seed.email },
      create: {
        email: seed.email,
        passwordHash: await hash('ChangeMe!2026'),
        role: Role.TESTER,
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
        firstName: seed.firstName,
        lastName: seed.lastName,
        countryCode: seed.country,
      },
      update: {},
      select: { id: true },
    })

    const profile = await prisma.testerProfile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        status: TesterStatus.VERIFIED,
        headline: index === 0 ? 'Localization Tester' : 'QA Engineer',
        experienceYears: 3 + index,
        countryCode: seed.country,
        verifiedAt: new Date(),
        verifiedById: admin.id,
        ndaAcceptedAt: new Date(),
      },
      update: {},
      select: { id: true },
    })

    const existingDevice = await prisma.testerDevice.findFirst({
      where: { testerProfileId: profile.id, model: seed.device },
      select: { id: true },
    })
    if (!existingDevice) {
      await prisma.testerDevice.create({
        data: {
          testerProfileId: profile.id,
          type: DeviceType.MOBILE,
          model: seed.device,
          osName: seed.device.startsWith('iPhone') ? 'iOS' : 'Android',
          isPrimary: true,
        },
      })
    }

    for (const skill of skills.slice(0, 3)) {
      await prisma.testerSkill.upsert({
        where: { testerProfileId_skillId: { testerProfileId: profile.id, skillId: skill.id } },
        create: { testerProfileId: profile.id, skillId: skill.id },
        update: {},
      })
    }

    await prisma.testerLanguage.upsert({
      where: { testerProfileId_code: { testerProfileId: profile.id, code: 'en' } },
      create: { testerProfileId: profile.id, code: 'en', proficiency: 'FLUENT' },
      update: {},
    })
  }

  // ─── A demo project ────────────────────────────────────────────────────────
  const existingProject = await prisma.project.findFirst({
    where: { organisationId: org.id },
    select: { id: true },
  })

  if (!existingProject) {
    await prisma.$executeRawUnsafe(
      `CREATE SEQUENCE IF NOT EXISTS "ref_project_${new Date().getUTCFullYear()}" START 1`,
    )
    await prisma.project.create({
      data: {
        reference: `C4T-${new Date().getUTCFullYear()}-0001`,
        organisationId: org.id,
        createdById: customer.id,
        title: 'Mobile wallet — UPI checkout regression',
        summary: 'Full regression across UPI, card and net-banking checkout on Android and iOS.',
        instructions:
          'Focus on the UPI collect flow and the 3DS step-up. Report anything that blocks a payment from completing, and always attach a screen recording.',
        status: ProjectStatus.IN_PROGRESS,
        priority: ProjectPriority.HIGH,
        platformTargets: ['android', 'ios'],
        targetCountries: ['IN', 'AE'],
        targetLanguages: ['en', 'hi'],
        startDate: new Date(),
        progressPercent: 35,
      },
    })
    // Advance the sequence past the seed's hardcoded reference so the next
    // API-created project (which calls nextval()) does not collide on the
    // unique reference index. Without this, the seed would leave the sequence
    // counter at 1 and the first project created by the API would write
    // C4T-2026-0001 — colliding with the seeded row.
    await prisma.$executeRawUnsafe(
      `SELECT setval('"ref_project_${new Date().getUTCFullYear()}"', 2, true)`,
    )
    console.log('  demo project created')
  }

  console.log('\nDemo accounts (password for all: ChangeMe!2026)')
  console.table([
    { role: 'ADMIN', email: ADMIN_EMAIL },
    { role: 'SUB_ADMIN', email: 'manager@crowd4test.com' },
    { role: 'CUSTOMER', email: 'customer@example.com' },
    { role: 'TESTER', email: 'tester1@example.com' },
  ])
  console.warn('\nChange these credentials before any deployment.')

  // ─── More organisations (so the admin list isn't a one-row stub) ─────────
  // Each org gets a member pulled from the same customer we already created, so
  // the row count is the same for "viewed as admin" and "viewed as customer"
  // where it overlaps, and admin sees more.
  const orgSeeds = [
    { slug: 'northwind-fintech', name: 'Northwind Fintech', industry: 'Banking & Finance', country: 'IN', city: 'Bengaluru' },
    { slug: 'kairos-health',      name: 'Kairos Health',      industry: 'Healthcare',        country: 'US', city: 'Boston'   },
    { slug: 'lumen-retail',      name: 'Lumen Retail',       industry: 'Retail',            country: 'GB', city: 'London'   },
    { slug: 'orbit-games',       name: 'Orbit Games',        industry: 'Gaming',            country: 'KR', city: 'Seoul'    },
    { slug: 'sprout-edu',        name: 'Sprout Education',   industry: 'Education',         country: 'IN', city: 'Mumbai'   },
    { slug: 'vela-travel',       name: 'Vela Travel',        industry: 'Travel & Hosp.',    country: 'PT', city: 'Lisbon'   },
  ]
  for (const [i, s] of orgSeeds.entries()) {
    const exists = await prisma.organisation.findUnique({ where: { slug: s.slug }, select: { id: true } })
    if (exists) continue
    await prisma.organisation.create({
      data: {
        name: s.name,
        slug: s.slug,
        status: OrganisationStatus.ACTIVE,
        industry: s.industry,
        contactEmail: i === 0 ? 'ops@northwind.example' : 'admin@' + s.slug + '.example',
        countryCode: s.country,
        city: s.city,
        onboardedAt: new Date(Date.now() - (i + 1) * 86_400_000),
      },
    })
  }

  // ─── Extra customers, so /v1/users has more than the bootstrap four ─────
  // They are real AdminListView rows, not roles for the placeholder pages.
  const extraUsers = [
    { email: 'rohan.patel@example.com', first: 'Rohan',  last: 'Patel',  country: 'IN', role: Role.CUSTOMER, orgSlug: 'northwind-fintech' },
    { email: 'li.zhang@example.com',     first: 'Li',     last: 'Zhang',  country: 'CN', role: Role.CUSTOMER, orgSlug: 'lumen-retail'     },
    { email: 'tariq.haddad@example.com', first: 'Tariq',  last: 'Haddad', country: 'EG', role: Role.CUSTOMER, orgSlug: 'orbit-games'      },
    { email: 'sara.meneses@example.com', first: 'Sara',   last: 'Meneses',country: 'BR', role: Role.CUSTOMER, orgSlug: 'sprout-edu'       },
  ]
  const allOrgs = await prisma.organisation.findMany({ select: { id: true, slug: true } })
  const orgBySlug = new Map(allOrgs.map((o) => [o.slug, o.id] as const))
  for (const u of extraUsers) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      create: {
        email: u.email,
        passwordHash: await hash('ChangeMe!2026'),
        role: u.role,
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
        firstName: u.first,
        lastName: u.last,
        countryCode: u.country,
      },
      update: {},
      select: { id: true },
    })
    const orgId = orgBySlug.get(u.orgSlug)
    if (orgId) {
      await prisma.organisationMember.upsert({
        where: { organisationId_userId: { organisationId: orgId, userId: user.id } },
        create: {
          organisationId: orgId,
          userId: user.id,
          orgRole: OrgMemberRole.OWNER,
          joinedAt: new Date(),
        },
        update: {},
      })
    }
  }

  // ─── A second project so the admin list has more than one row ────────────
  const secondProject = await prisma.project.findFirst({
    where: { organisationId: { not: org.id } },
    select: { id: true },
  })
  if (!secondProject) {
    const kairos = orgBySlug.get('kairos-health')
    if (kairos) {
      // The sequence was already created (and advanced past 1) by the first
      // project block above. No need to recreate it.
      await prisma.project.create({
        data: {
          reference: `C4T-${new Date().getUTCFullYear()}-0002`,
          organisationId: kairos,
          createdById: customer.id,
          title: 'Patient portal — appointment booking',
          summary: 'End-to-end testing of the appointment booking flow including insurance capture and SMS reminders.',
          instructions: 'Cover both insured and self-pay paths. Test across desktop and mobile, with at least one session per US timezone.',
          status: ProjectStatus.IN_PROGRESS,
          priority: ProjectPriority.HIGH,
          platformTargets: ['web', 'android', 'ios'],
          targetCountries: ['US', 'CA'],
          targetLanguages: ['en', 'es'],
          startDate: new Date(),
          progressPercent: 12,
        },
      })
      // Advance the sequence past the second seed row so the next
      // API-created project reads `nextval() = 3`.
      await prisma.$executeRawUnsafe(
        `CREATE SEQUENCE IF NOT EXISTS "ref_project_${new Date().getUTCFullYear()}" START 1`,
      )
      await prisma.$executeRawUnsafe(
        `SELECT setval('"ref_project_${new Date().getUTCFullYear()}"', 3, true)`,
      )
    }
  }

  // ─── Bugs against the existing projects so the bug list is not empty ─────
  // The bug model needs projectId and a reportedById; we use the admin as the
  // reporter and link to whichever project the seed happened to create first.
  const allProjects = await prisma.project.findMany({
    select: { id: true, reference: true, organisationId: true },
    orderBy: { createdAt: 'asc' },
  })
  if (allProjects.length > 0) {
    const bugSeeds = [
      {
        ref: `BUG-${new Date().getUTCFullYear()}-00001`,
        title: 'UPI collect screen hangs after PIN entry',
        projectIdx: 0,
        severity: BugSeverity.CRITICAL,
        status: BugStatus.TRIAGED,
        stepsToReproduce: 'On Android 13 with Pixel 7a, enter UPI PIN, then tap Submit. The screen freezes with the spinner showing for 30s+ before timing out.',
        env: 'Android 13, Pixel 7a, app v4.3.1',
      },
      {
        ref: `BUG-${new Date().getUTCFullYear()}-00002`,
        title: 'Checkout shows netbanking redirect in plain text on a hidden iframe',
        projectIdx: 0,
        severity: BugSeverity.MEDIUM,
        status: BugStatus.NEW,
        stepsToReproduce: 'Add a net-banking payment, click Continue. The redirect iframe has white text on a white background.',
        env: 'Chrome 119, desktop',
      },
      {
        ref: `BUG-${new Date().getUTCFullYear()}-00003`,
        title: 'Patient dashboard times out at 30s in EU regions',
        projectIdx: 1,
        severity: BugSeverity.HIGH,
        status: BugStatus.CONFIRMED,
        stepsToReproduce: 'Log in as a patient in the Lisbon test account, navigate to the appointments list. Request times out after 30s.',
        env: 'iOS 17, iPhone 13, EU',
      },
      {
        ref: `BUG-${new Date().getUTCFullYear()}-00004`,
        title: 'Insurance capture form does not validate phone format',
        projectIdx: 1,
        severity: BugSeverity.LOW,
        status: BugStatus.IN_PROGRESS,
        stepsToReproduce: 'Enter a 10-digit phone without country prefix — form submits. Expected: validation error.',
        env: 'Web, Chrome',
      },
    ]
    for (const b of bugSeeds) {
      const project = allProjects[Math.min(b.projectIdx, allProjects.length - 1)]
      if (!project) continue
      await prisma.bug.upsert({
        where: { reference: b.ref },
        create: {
          reference: b.ref,
          projectId: project.id,
          reportedById: admin.id,
          title: b.title,
          description: b.stepsToReproduce,
          stepsToReproduce: b.stepsToReproduce,
          deviceModel: b.env.includes('Pixel') ? 'Pixel 7a'
            : b.env.includes('iPhone') ? 'iPhone 13'
            : null,
          osName: b.env.includes('Android') ? 'Android'
            : b.env.includes('iOS') ? 'iOS'
            : b.env.includes('Chrome') ? 'Chrome OS'
            : null,
          appVersion: b.env.includes('app v') ? 'v4.3.1' : null,
          severity: b.severity,
          status: b.status,
        },
        update: {},
      })
    }
    // Advance the bug sequence past the seeded references, for the same
    // reason the project sequence is advanced above: `nextReference('bug')`
    // starts at nextval = 1, so without this the first API-reported bug
    // would be numbered 1 again. It did not previously collide on the unique
    // index only because the seed's padding (4 digits) differed from
    // `nextReference`'s (5) — now that both are 5, the setval is what
    // actually prevents the collision.
    await prisma.$executeRawUnsafe(
      `CREATE SEQUENCE IF NOT EXISTS "ref_bug_${new Date().getUTCFullYear()}" START 1`,
    )
    await prisma.$executeRawUnsafe(
      `SELECT setval('"ref_bug_${new Date().getUTCFullYear()}"', ${bugSeeds.length}, true)`,
    )
  }

  // ─── Ratings given by the customer to a couple of testers ───────────────
  // Schema enforces @@unique([authorId, subjectType, subjectUserId, projectId]).
  const tester1 = await prisma.user.findUnique({ where: { email: 'tester1@example.com' }, select: { id: true } })
  if (tester1 && allProjects[0]) {
    await prisma.rating.upsert({
      where: {
        authorId_subjectType_subjectUserId_projectId: {
          authorId: customer.id,
          subjectType: RatingSubjectType.TESTER,
          subjectUserId: tester1.id,
          projectId: allProjects[0].id,
        },
      },
      create: {
        authorId: customer.id,
        subjectType: RatingSubjectType.TESTER,
        subjectUserId: tester1.id,
        projectId: allProjects[0].id,
        score: 5,
        comment: 'Caught two regressions the team had missed. Detailed write-up.',
      },
      update: {},
    })
  }
  const tester2 = await prisma.user.findUnique({ where: { email: 'tester2@example.com' }, select: { id: true } })
  if (tester2 && allProjects[0]) {
    await prisma.rating.upsert({
      where: {
        authorId_subjectType_subjectUserId_projectId: {
          authorId: customer.id,
          subjectType: RatingSubjectType.TESTER,
          subjectUserId: tester2.id,
          projectId: allProjects[0].id,
        },
      },
      create: {
        authorId: customer.id,
        subjectType: RatingSubjectType.TESTER,
        subjectUserId: tester2.id,
        projectId: allProjects[0].id,
        score: 4,
        comment: 'Good coverage, but a few steps were skipped on the second device.',
      },
      update: {},
    })
  }

  // ─── Transactions against the existing customer / projects ───────────────
  // Bookkeeping only: §5 excludes gateways. Recorded by the admin.
  if (allProjects[0]) {
    const txnSeeds = [
      {
        reference: `TXN-${new Date().getUTCFullYear()}-00001`,
        type: TransactionType.CUSTOMER_INVOICE,
        status: TransactionStatus.PAID,
        amountMinor: BigInt(250000), // ₹2,500.00
        description: 'UPI regression — milestone 1',
      },
      {
        reference: `TXN-${new Date().getUTCFullYear()}-00002`,
        type: TransactionType.TESTER_PAYOUT,
        status: TransactionStatus.APPROVED,
        amountMinor: BigInt(75000), // ₹750.00
        description: 'Tester payout — Hrvoje Nikolic',
      },
      {
        reference: `TXN-${new Date().getUTCFullYear()}-00003`,
        type: TransactionType.ADJUSTMENT,
        status: TransactionStatus.PAID,
        amountMinor: BigInt(-15000),
        description: 'Refund — duplicate charge',
      },
    ]
    for (const t of txnSeeds) {
      const counterparty = t.type === TransactionType.TESTER_PAYOUT ? tester1?.id : customer.id
      await prisma.transaction.upsert({
        where: { reference: t.reference },
        create: {
          reference: t.reference,
          type: t.type,
          status: t.status,
          amountMinor: t.amountMinor,
          currency: 'INR',
          organisationId: org.id,
          projectId: allProjects[0].id,
          counterpartyId: counterparty ?? null,
          recordedById: admin.id,
          description: t.description,
          occurredAt: new Date(),
          settledAt: t.status === TransactionStatus.PAID ? new Date() : null,
        },
        update: {},
      })
    }
    // Same reasoning as the project and bug sequences above.
    await prisma.$executeRawUnsafe(
      `CREATE SEQUENCE IF NOT EXISTS "ref_transaction_${new Date().getUTCFullYear()}" START 1`,
    )
    await prisma.$executeRawUnsafe(
      `SELECT setval('"ref_transaction_${new Date().getUTCFullYear()}"', ${txnSeeds.length}, true)`,
    )
  }

  // ─── A few platform announcements so the comms section isn't empty ─────
  const annSeeds = [
    {
      title: 'New: AI-driven test case generation is in private beta',
      body: 'Tester Cloud can now generate candidate test cases from a written product spec. Sign-ups are open to current ADMINs; the wider rollout follows the beta.',
      audience: AnnouncementAudience.ADMINS,
    },
    {
      title: 'Scheduled maintenance window — Sunday 02:00 to 04:00 UTC',
      body: 'During this window the API will be briefly unavailable. Reports and live sessions will queue and resume automatically.',
      audience: AnnouncementAudience.ALL,
    },
    {
      title: 'Tester payouts now process twice a week',
      body: 'Approved payouts will move on Tuesdays and Fridays instead of monthly. No action required on your side.',
      audience: AnnouncementAudience.TESTERS,
    },
  ]
  for (const a of annSeeds) {
    await prisma.announcement.upsert({
      where: { id: `seed-ann-${a.title.slice(0, 20).replace(/\W+/g, '-')}` },
      create: {
        id: `seed-ann-${a.title.slice(0, 20).replace(/\W+/g, '-')}`,
        authorId: admin.id,
        title: a.title,
        body: a.body,
        audience: a.audience,
        publishedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      },
      update: {},
    })
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error('Seed failed:', error)
    await prisma.$disconnect()
    process.exit(1)
  })
