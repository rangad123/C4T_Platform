import {
  AssignmentStatus,
  BugSeverity,
  BugStatus,
  OrganisationStatus,
  OrgMemberRole,
  ProjectStatus,
  Role,
  TesterStatus,
  UserStatus,
} from '@prisma/client'
import { prisma } from '../../src/lib/prisma.js'
import { hashPassword } from '../../src/lib/password.js'
import { PERMISSION_CATALOGUE } from '../../src/config/permissions.js'

export const PASSWORD = 'TestPassword!2026'

/**
 * Wipes every table. Order does not matter because this uses a single
 * TRUNCATE … CASCADE rather than per-table deletes.
 */
export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
  `
  if (tables.length === 0) return

  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ')
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
}

async function makeUser(input: {
  email: string
  role: Role
  firstName: string
  passwordHash: string
}) {
  return prisma.user.create({
    data: {
      email: input.email,
      passwordHash: input.passwordHash,
      role: input.role,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
      firstName: input.firstName,
      lastName: 'Test',
      countryCode: 'IN',
    },
    select: { id: true, email: true, role: true },
  })
}

export interface World {
  admin: { id: string; email: string }
  subAdminLimited: { id: string; email: string }
  subAdminFull: { id: string; email: string }
  /** Owner of org A. */
  customerA: { id: string; email: string }
  /** Ordinary member of org A — not an owner. */
  customerAMember: { id: string; email: string }
  /** Owner of org B, a completely separate customer. */
  customerB: { id: string; email: string }
  /** Accepted and active on project A. */
  testerActive: { id: string; email: string }
  /** Invited to project A but has not responded. */
  testerInvited: { id: string; email: string }
  /** Active on project B only. */
  testerOther: { id: string; email: string }
  /** A verified tester with no assignments at all. */
  testerUnassigned: { id: string; email: string }
  orgA: { id: string }
  orgB: { id: string }
  projectA: { id: string; reference: string; buildId: string }
  projectB: { id: string; buildId: string }
  /** Reported by testerActive on projectA, status NEW. */
  bugA: { id: string; reference: string }
}

/**
 * Builds the standard cast used by every access test.
 *
 * Two organisations, two projects, and testers in each of the four
 * relationship states, so a test can assert both what a role CAN do and — more
 * importantly — that the same role on the other side of the wall cannot.
 */
export async function seedWorld(): Promise<World> {
  const passwordHash = await hashPassword(PASSWORD)

  for (const permission of PERMISSION_CATALOGUE) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      create: permission,
      update: {},
    })
  }

  const [
    admin,
    subAdminLimited,
    subAdminFull,
    customerA,
    customerAMember,
    customerB,
    testerActive,
    testerInvited,
    testerOther,
    testerUnassigned,
  ] = await Promise.all([
    makeUser({ email: 'admin@test.local', role: Role.ADMIN, firstName: 'Admin', passwordHash }),
    makeUser({
      email: 'sub-limited@test.local',
      role: Role.SUB_ADMIN,
      firstName: 'SubLimited',
      passwordHash,
    }),
    makeUser({
      email: 'sub-full@test.local',
      role: Role.SUB_ADMIN,
      firstName: 'SubFull',
      passwordHash,
    }),
    makeUser({
      email: 'customer-a@test.local',
      role: Role.CUSTOMER,
      firstName: 'CustA',
      passwordHash,
    }),
    makeUser({
      email: 'customer-a2@test.local',
      role: Role.CUSTOMER,
      firstName: 'CustAMember',
      passwordHash,
    }),
    makeUser({
      email: 'customer-b@test.local',
      role: Role.CUSTOMER,
      firstName: 'CustB',
      passwordHash,
    }),
    makeUser({
      email: 'tester-active@test.local',
      role: Role.TESTER,
      firstName: 'TActive',
      passwordHash,
    }),
    makeUser({
      email: 'tester-invited@test.local',
      role: Role.TESTER,
      firstName: 'TInvited',
      passwordHash,
    }),
    makeUser({
      email: 'tester-other@test.local',
      role: Role.TESTER,
      firstName: 'TOther',
      passwordHash,
    }),
    makeUser({
      email: 'tester-none@test.local',
      role: Role.TESTER,
      firstName: 'TNone',
      passwordHash,
    }),
  ])

  // subAdminFull gets every permission; subAdminLimited gets read-only ones.
  const allPermissions = await prisma.permission.findMany({ select: { id: true, code: true } })
  await prisma.userPermission.createMany({
    data: allPermissions.map((p) => ({ userId: subAdminFull.id, permissionId: p.id })),
  })
  await prisma.userPermission.createMany({
    data: allPermissions
      .filter((p) => p.code.endsWith('.read'))
      .map((p) => ({ userId: subAdminLimited.id, permissionId: p.id })),
  })

  // Every tester needs a VERIFIED profile with an accepted NDA to be assignable.
  for (const tester of [testerActive, testerInvited, testerOther, testerUnassigned]) {
    await prisma.testerProfile.create({
      data: {
        userId: tester.id,
        status: TesterStatus.VERIFIED,
        verifiedAt: new Date(),
        ndaAcceptedAt: new Date(),
        countryCode: 'IN',
      },
    })
  }

  const orgA = await prisma.organisation.create({
    data: {
      name: 'Org A',
      slug: 'org-a',
      status: OrganisationStatus.ACTIVE,
      notes: 'INTERNAL ADMIN NOTE A',
      members: {
        create: [
          { userId: customerA.id, orgRole: OrgMemberRole.OWNER, joinedAt: new Date() },
          { userId: customerAMember.id, orgRole: OrgMemberRole.MEMBER, joinedAt: new Date() },
        ],
      },
    },
    select: { id: true },
  })

  const orgB = await prisma.organisation.create({
    data: {
      name: 'Org B',
      slug: 'org-b',
      status: OrganisationStatus.ACTIVE,
      notes: 'INTERNAL ADMIN NOTE B',
      members: {
        create: [{ userId: customerB.id, orgRole: OrgMemberRole.OWNER, joinedAt: new Date() }],
      },
    },
    select: { id: true },
  })

  const projectA = await prisma.project.create({
    data: {
      reference: 'C4T-TEST-0001',
      organisationId: orgA.id,
      createdById: customerA.id,
      title: 'Project A',
      instructions: 'CONFIDENTIAL BRIEF A',
      status: ProjectStatus.IN_PROGRESS,
      // Every project gets one build; the nested assignments/materials/bugs
      // below need that build's id, so it is created here and re-fetched
      // rather than nested three levels deep in one `create`.
      builds: { create: { name: 'Original build', isDefault: true } },
    },
    select: { id: true, reference: true, builds: { select: { id: true } } },
  })
  const buildA = projectA.builds[0]!.id

  await prisma.projectAssignment.createMany({
    data: [
      {
        projectId: projectA.id,
        buildId: buildA,
        testerId: testerActive.id,
        status: AssignmentStatus.ACTIVE,
        respondedAt: new Date(),
      },
      {
        projectId: projectA.id,
        buildId: buildA,
        testerId: testerInvited.id,
        status: AssignmentStatus.INVITED,
      },
    ],
  })
  await prisma.projectMaterial.create({
    data: { projectId: projectA.id, buildId: buildA, title: 'Build link', url: 'https://example.com/build' },
  })

  const projectB = await prisma.project.create({
    data: {
      reference: 'C4T-TEST-0002',
      organisationId: orgB.id,
      createdById: customerB.id,
      title: 'Project B',
      instructions: 'CONFIDENTIAL BRIEF B',
      status: ProjectStatus.IN_PROGRESS,
      builds: { create: { name: 'Original build', isDefault: true } },
    },
    select: { id: true, builds: { select: { id: true } } },
  })
  const buildB = projectB.builds[0]!.id

  await prisma.projectAssignment.create({
    data: {
      projectId: projectB.id,
      buildId: buildB,
      testerId: testerOther.id,
      status: AssignmentStatus.ACTIVE,
      respondedAt: new Date(),
    },
  })

  const bugA = await prisma.bug.create({
    data: {
      reference: 'BUG-TEST-0001',
      projectId: projectA.id,
      buildId: buildA,
      reportedById: testerActive.id,
      title: 'Checkout fails on UPI',
      description: 'Payment never completes',
      stepsToReproduce: '1. Add to cart 2. Pay with UPI',
      severity: BugSeverity.HIGH,
      status: BugStatus.NEW,
      statusHistory: {
        create: { changedById: testerActive.id, toStatus: BugStatus.NEW, note: 'Reported' },
      },
    },
    select: { id: true, reference: true },
  })

  return {
    admin,
    subAdminLimited,
    subAdminFull,
    customerA,
    customerAMember,
    customerB,
    testerActive,
    testerInvited,
    testerOther,
    testerUnassigned,
    orgA,
    orgB,
    projectA: { id: projectA.id, reference: projectA.reference, buildId: buildA },
    projectB: { id: projectB.id, buildId: buildB },
    bugA,
  }
}
