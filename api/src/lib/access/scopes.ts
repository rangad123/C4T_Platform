import { AssignmentStatus, type Prisma, Role } from '@prisma/client'

/**
 * List scoping — the same relationships as `relations.ts`, expressed as Prisma
 * filters.
 *
 * Every list endpoint MUST spread one of these into its `where`. The rule is
 * that "can I read this one?" (policy.ts) and "which ones can I read?" (here)
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

// ─── Projects ────────────────────────────────────────────────────────────────

/**
 *   ADMIN / SUB_ADMIN — everything
 *   CUSTOMER          — projects belonging to an organisation they are in
 *   TESTER            — projects they hold a live assignment on, plus any they
 *                       manage (a manager can be any admin-side user)
 *   USER              — nothing
 */
export function projectScope(user: Express.AuthenticatedUser): Prisma.ProjectWhereInput {
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
 *   ADMIN / SUB_ADMIN — everything
 *   CUSTOMER          — every bug on their organisations' projects
 *   TESTER            — only bugs they reported
 *
 * Testers deliberately cannot browse one another's reports: it keeps unreleased
 * defect detail need-to-know and stops one tester copying another's findings.
 * If a shared known-issues list is wanted later, add it as a separate,
 * title-and-status-only endpoint rather than widening this.
 */
export function bugScope(user: Express.AuthenticatedUser): Prisma.BugWhereInput {
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
              some: { testerId: user.id, status: { in: [AssignmentStatus.ACCEPTED, AssignmentStatus.ACTIVE] } },
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
  if (isPlatform(user)) return {}
  if (user.role === Role.CUSTOMER) return { members: { some: { userId: user.id } } }
  return DENY_ALL
}

// ─── Threads ─────────────────────────────────────────────────────────────────

export function threadScope(user: Express.AuthenticatedUser): Prisma.ThreadWhereInput {
  if (isPlatform(user)) return {}
  return { participants: { some: { userId: user.id } } }
}

// ─── Transactions ────────────────────────────────────────────────────────────

/**
 *   CUSTOMER — rows against an organisation they belong to
 *   TESTER   — rows where they are the counterparty (their earnings/payouts)
 */
export function transactionScope(user: Express.AuthenticatedUser): Prisma.TransactionWhereInput {
  if (isPlatform(user)) return {}
  if (user.role === Role.CUSTOMER) {
    return { organisation: { members: { some: { userId: user.id } } } }
  }
  if (user.role === Role.TESTER) return { counterpartyId: user.id }
  return DENY_ALL
}

// ─── Ratings ─────────────────────────────────────────────────────────────────

/** Hidden ratings are visible to the admin side only. */
export function ratingScope(user: Express.AuthenticatedUser): Prisma.RatingWhereInput {
  if (isPlatform(user)) return {}
  return { isVisible: true }
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
