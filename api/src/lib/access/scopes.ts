import { AssignmentStatus, type Prisma, Role } from '@prisma/client'
import { PERMISSIONS } from '../../config/permissions.js'

/**
 * List scoping — the same relationships as `relations.ts`, expressed as Prisma
 * filters.
 *
 * Every list endpoint MUST apply one of these to its `where`, under `AND`
 * wherever a query filter could set the same key. The rule is that "can I read this one?" (policy.ts) and "which ones can I read?" (here)
 * must agree; if they drift, a user either sees a row they cannot open, or a
 * list that hides something they are entitled to.
 *
 * The invariant is tested directly — see tests/access/consistency.test.ts.
 */

/** Matches nothing. Used where a role has no access at all. */
const DENY_ALL = { id: '__no_access__' }

const ACTIVE_TESTER: AssignmentStatus[] = [
  AssignmentStatus.INVITED,
  AssignmentStatus.ACCEPTED,
  AssignmentStatus.ACTIVE,
  AssignmentStatus.COMPLETED,
]

function isPlatform(user: Express.AuthenticatedUser): boolean {
  return user.role === Role.ADMIN || user.role === Role.SUB_ADMIN
}

/**
 * A Sub-Admin holding `project.scope_to_assigned` — see the matching check in
 * `policy.ts`, kept as a separate one-line copy rather than a shared import so
 * the two modules stay independent, per their own header comments.
 */
function isScopedSubAdmin(user: Express.AuthenticatedUser): boolean {
  return (
    user.role === Role.SUB_ADMIN && user.permissions.includes(PERMISSIONS.PROJECT_SCOPE_TO_ASSIGNED)
  )
}

/**
 * A Sub-Admin who does not hold `code`. `policy.ts` gives a Sub-Admin the
 * platform-wide pass for an action only with that action's permission; without
 * it they fall back to whatever real relation they have, like anyone else. The
 * lists must do the same, or a Sub-Admin refused one row could list them all.
 */
function lacksPermission(user: Express.AuthenticatedUser, code: string): boolean {
  return user.role === Role.SUB_ADMIN && !user.permissions.includes(code)
}

/** A project this manager is assigned to, via `ManagerAssignment`. */
function assignedProjectsRelation(user: Express.AuthenticatedUser) {
  return { managers: { some: { managerId: user.id } } }
}

// ─── Projects ────────────────────────────────────────────────────────────────

/**
 *   ADMIN / SUB_ADMIN — everything (a Sub-Admin needs `project.read`, else only
 *                       the projects they manage)
 *   CUSTOMER          — projects belonging to an organisation they are in
 *   TESTER            — projects they hold a live assignment on, plus any they
 *                       manage (a manager can be any admin-side user)
 *   USER              — nothing
 */
export function projectScope(user: Express.AuthenticatedUser): Prisma.ProjectWhereInput {
  if (isScopedSubAdmin(user) || lacksPermission(user, PERMISSIONS.PROJECT_READ)) {
    return assignedProjectsRelation(user)
  }
  if (isPlatform(user)) return {}

  if (user.role === Role.CUSTOMER) {
    return { organisation: { members: { some: { userId: user.id } } } }
  }

  if (user.role === Role.TESTER) {
    return {
      assignments: { some: { testerId: user.id, status: { in: ACTIVE_TESTER } } },
    }
  }

  return DENY_ALL
}

// ─── Bugs ────────────────────────────────────────────────────────────────────

/**
 *   ADMIN / SUB_ADMIN — everything (a Sub-Admin needs `bug.read`, else only bugs
 *                       on the projects they manage)
 *   CUSTOMER          — every bug on their organisations' projects
 *   TESTER            — only bugs they reported
 *
 * Testers deliberately cannot browse one another's reports: it keeps unreleased
 * defect detail need-to-know and stops one tester copying another's findings.
 * If a shared known-issues list is wanted later, add it as a separate,
 * title-and-status-only endpoint rather than widening this.
 */
export function bugScope(user: Express.AuthenticatedUser): Prisma.BugWhereInput {
  if (isScopedSubAdmin(user) || lacksPermission(user, PERMISSIONS.BUG_READ)) {
    return { project: assignedProjectsRelation(user) }
  }
  if (isPlatform(user)) return {}

  if (user.role === Role.CUSTOMER) {
    return { project: { organisation: { members: { some: { userId: user.id } } } } }
  }

  if (user.role === Role.TESTER) {
    return {
      OR: [
        { reportedById: user.id },
        // §2.2 Build Settings "Testers can see bugs raised by others?" — must
        // agree with the ACCEPTED/ACTIVE-only relation computed in
        // bugRelations() (relations.ts), or a tester would see a row here
        // they get a 404 opening, or vice versa.
        {
          project: {
            testersCanSeeOtherBugs: true,
            assignments: {
              some: {
                testerId: user.id,
                status: { in: [AssignmentStatus.ACCEPTED, AssignmentStatus.ACTIVE] },
              },
            },
          },
        },
      ],
    }
  }

  return DENY_ALL
}

// ─── Organisations ───────────────────────────────────────────────────────────

export function organisationScope(user: Express.AuthenticatedUser): Prisma.OrganisationWhereInput {
  if (lacksPermission(user, PERMISSIONS.ORGANISATION_READ)) {
    return { members: { some: { userId: user.id } } }
  }
  if (isPlatform(user)) return {}
  if (user.role === Role.CUSTOMER) return { members: { some: { userId: user.id } } }
  return DENY_ALL
}

// ─── Threads ─────────────────────────────────────────────────────────────────

export function threadScope(user: Express.AuthenticatedUser): Prisma.ThreadWhereInput {
  if (lacksPermission(user, PERMISSIONS.COMMUNICATION_READ)) {
    return { participants: { some: { userId: user.id } } }
  }
  if (isScopedSubAdmin(user)) return { project: assignedProjectsRelation(user) }
  if (isPlatform(user)) return {}
  return { participants: { some: { userId: user.id } } }
}

// ─── Transactions ────────────────────────────────────────────────────────────

/**
 *   CUSTOMER — rows against an organisation they belong to
 *   TESTER   — rows where they are the counterparty (their earnings/payouts)
 */
export function transactionScope(user: Express.AuthenticatedUser): Prisma.TransactionWhereInput {
  if (lacksPermission(user, PERMISSIONS.TRANSACTION_READ)) return DENY_ALL
  if (isPlatform(user)) return {}
  if (user.role === Role.CUSTOMER) {
    return { organisation: { members: { some: { userId: user.id } } } }
  }
  if (user.role === Role.TESTER) return { counterpartyId: user.id }
  return DENY_ALL
}

// ─── Ratings ─────────────────────────────────────────────────────────────────

/**
 * Hidden ratings are visible to the admin side only. Everyone else sees the
 * ratings they gave or received, and a customer also those on their projects.
 * Testers never see each other's ratings, even on a shared project. There is
 * no public directory of who was rated what.
 */
export function ratingScope(user: Express.AuthenticatedUser): Prisma.RatingWhereInput {
  if (isScopedSubAdmin(user)) return { project: assignedProjectsRelation(user) }
  if (isPlatform(user)) return {}
  const own: Prisma.RatingWhereInput[] = [{ subjectUserId: user.id }, { authorId: user.id }]
  if (user.role === Role.CUSTOMER) own.push({ project: projectScope(user) })
  return { isVisible: true, OR: own }
}

// ─── Testers ─────────────────────────────────────────────────────────────────

/**
 * The crowd pool is admin-only. A customer sees testers exclusively through the
 * assignments on their own projects, never as a browsable directory.
 */
export function testerScope(user: Express.AuthenticatedUser): Prisma.TesterProfileWhereInput {
  if (isPlatform(user)) return {}
  return { id: '__no_access__' }
}
