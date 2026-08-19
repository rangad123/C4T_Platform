import { BugStatus } from '@prisma/client'
import { PERMISSIONS, type PermissionCode } from '../../config/permissions.js'
import { ForbiddenError } from '../errors.js'
import type { Relation, RelationSet } from './relations.js'

/**
 * The policy table — the normative half of access control.
 *
 * `relations.ts` establishes what a user IS to a resource. This decides what
 * that entitles them to do. One table, so a rule can be read and argued about
 * rather than reconstructed from six services.
 *
 * Reading a rule: the action is granted if the user holds ANY of the listed
 * relations. `platform:subadmin` additionally requires the named permission —
 * `platform:admin` never does, because an Admin implicitly holds everything.
 */

export type Action =
  // Project
  | 'project.read'
  | 'project.read_brief'
  | 'project.read_team'
  | 'project.read_contacts'
  | 'project.create'
  | 'project.update'
  | 'project.change_status'
  | 'project.delete'
  | 'project.assign_testers'
  | 'project.manage_materials'
  // Bug
  | 'bug.read'
  | 'bug.create'
  | 'bug.update'
  | 'bug.delete'
  | 'bug.comment'
  | 'bug.comment_internal'
  | 'bug.attach'
  | 'bug.change_status'
  // Organisation
  | 'organisation.read'
  | 'organisation.read_internal'
  | 'organisation.update'
  | 'organisation.manage_members'
  | 'organisation.delete'
  // Communication
  | 'thread.read'
  | 'thread.post'
  | 'thread.close'
  // Money & feedback
  | 'transaction.read'
  | 'transaction.write'
  | 'rating.create'
  | 'rating.moderate'
  // Reports
  | 'report.generate'
  // Structured testing workflow — test cases, execution reports, reviews
  | 'testcase.read'
  | 'testcase.manage'
  | 'testreport.create'
  | 'testreview.create'

interface Rule {
  /** Holding any one of these grants the action. */
  relations: Relation[]
  /** Additionally required when the grant came via `platform:subadmin`. */
  permission?: PermissionCode
}

const POLICY: Record<Action, Rule> = {
  // ─── Project ───────────────────────────────────────────────────────────────
  'project.read': {
    relations: [
      'platform:admin',
      'platform:subadmin',
      'project:customer',
      'project:manager',
      'project:tester_invited',
      'project:tester_active',
      'project:tester_past',
    ],
    permission: PERMISSIONS.PROJECT_READ,
  },
  /**
   * The brief, instructions and materials. An INVITED tester is deliberately
   * excluded — they can see enough to decide, not the confidential scope.
   */
  'project.read_brief': {
    relations: [
      'platform:admin',
      'platform:subadmin',
      'project:customer',
      'project:manager',
      'project:tester_active',
      'project:tester_past',
    ],
    permission: PERMISSIONS.PROJECT_READ,
  },
  /** Who else is on the project. Testers never see each other. */
  'project.read_team': {
    relations: ['platform:admin', 'platform:subadmin', 'project:customer', 'project:manager'],
    permission: PERMISSIONS.PROJECT_READ,
  },
  /**
   * Named contacts for the project. An active tester needs these to raise a
   * question — they get names and roles, never billing or account detail.
   */
  'project.read_contacts': {
    relations: [
      'platform:admin',
      'platform:subadmin',
      'project:customer',
      'project:manager',
      'project:tester_active',
    ],
    permission: PERMISSIONS.PROJECT_READ,
  },
  'project.create': {
    relations: ['platform:admin', 'platform:subadmin', 'org:member'],
    permission: PERMISSIONS.PROJECT_WRITE,
  },
  'project.update': {
    relations: ['platform:admin', 'platform:subadmin', 'project:manager', 'project:customer'],
    permission: PERMISSIONS.PROJECT_WRITE,
  },
  'project.change_status': {
    relations: ['platform:admin', 'platform:subadmin', 'project:manager', 'project:customer'],
    permission: PERMISSIONS.PROJECT_WRITE,
  },
  'project.delete': {
    relations: ['platform:admin', 'platform:subadmin'],
    permission: PERMISSIONS.PROJECT_DELETE,
  },
  'project.assign_testers': {
    relations: ['platform:admin', 'platform:subadmin', 'project:manager'],
    permission: PERMISSIONS.PROJECT_ASSIGN,
  },
  'project.manage_materials': {
    relations: ['platform:admin', 'platform:subadmin', 'project:manager', 'project:customer'],
    permission: PERMISSIONS.PROJECT_WRITE,
  },

  // ─── Bug ───────────────────────────────────────────────────────────────────
  'bug.read': {
    relations: [
      'platform:admin',
      'platform:subadmin',
      'project:manager',
      'bug:customer',
      'bug:reporter',
      'bug:project_tester',
    ],
    permission: PERMISSIONS.BUG_READ,
  },
  /** Only a tester actively assigned to the project may log a defect. */
  'bug.create': { relations: ['project:tester_active'] },
  'bug.update': {
    relations: ['platform:admin', 'platform:subadmin', 'project:manager', 'bug:reporter'],
    permission: PERMISSIONS.BUG_TRIAGE,
  },
  'bug.delete': {
    relations: ['platform:admin', 'platform:subadmin', 'bug:reporter'],
    permission: PERMISSIONS.BUG_DELETE,
  },
  'bug.comment': {
    relations: [
      'platform:admin',
      'platform:subadmin',
      'project:manager',
      'bug:customer',
      'bug:reporter',
    ],
    permission: PERMISSIONS.BUG_READ,
  },
  'bug.comment_internal': {
    relations: ['platform:admin', 'platform:subadmin', 'project:manager'],
    permission: PERMISSIONS.BUG_TRIAGE,
  },
  'bug.attach': {
    relations: ['platform:admin', 'platform:subadmin', 'project:manager', 'bug:reporter'],
    permission: PERMISSIONS.BUG_TRIAGE,
  },
  /**
   * Gate only. WHICH transition is allowed depends on the current status and
   * the actor — see `allowedTransitions` below.
   */
  'bug.change_status': {
    relations: [
      'platform:admin',
      'platform:subadmin',
      'project:manager',
      'bug:customer',
      'bug:reporter',
    ],
    permission: PERMISSIONS.BUG_TRIAGE,
  },

  // ─── Organisation ──────────────────────────────────────────────────────────
  'organisation.read': {
    relations: ['platform:admin', 'platform:subadmin', 'org:member'],
    permission: PERMISSIONS.ORGANISATION_READ,
  },
  /** Internal admin notes are never visible to the customer themselves. */
  'organisation.read_internal': {
    relations: ['platform:admin', 'platform:subadmin'],
    permission: PERMISSIONS.ORGANISATION_READ,
  },
  'organisation.update': {
    relations: ['platform:admin', 'platform:subadmin', 'org:owner'],
    permission: PERMISSIONS.ORGANISATION_WRITE,
  },
  'organisation.manage_members': {
    relations: ['platform:admin', 'platform:subadmin', 'org:owner'],
    permission: PERMISSIONS.ORGANISATION_WRITE,
  },
  'organisation.delete': {
    relations: ['platform:admin', 'platform:subadmin'],
    permission: PERMISSIONS.ORGANISATION_DELETE,
  },

  // ─── Communication ─────────────────────────────────────────────────────────
  'thread.read': {
    relations: ['platform:admin', 'platform:subadmin', 'thread:participant'],
    permission: PERMISSIONS.COMMUNICATION_READ,
  },
  'thread.post': {
    relations: ['platform:admin', 'platform:subadmin', 'thread:participant'],
    permission: PERMISSIONS.COMMUNICATION_WRITE,
  },
  'thread.close': {
    relations: ['platform:admin', 'platform:subadmin'],
    permission: PERMISSIONS.COMMUNICATION_WRITE,
  },

  // ─── Money & feedback ──────────────────────────────────────────────────────
  'transaction.read': {
    relations: ['platform:admin', 'platform:subadmin', 'org:member', 'self'],
    permission: PERMISSIONS.TRANSACTION_READ,
  },
  'transaction.write': {
    relations: ['platform:admin', 'platform:subadmin'],
    permission: PERMISSIONS.TRANSACTION_WRITE,
  },
  'rating.create': {
    relations: ['project:customer', 'project:tester_past', 'project:tester_active'],
  },
  'rating.moderate': {
    relations: ['platform:admin', 'platform:subadmin'],
    permission: PERMISSIONS.RATING_MODERATE,
  },

  // ─── Reports ───────────────────────────────────────────────────────────────
  'report.generate': {
    relations: ['platform:admin', 'platform:subadmin', 'project:customer', 'project:manager'],
    permission: PERMISSIONS.PROJECT_READ,
  },

  // ─── Structured testing workflow ─────────────────────────────────────────
  // Same shape as bugs: everyone with a stake in the project can READ test
  // cases and their reports, but only the platform side and the project's
  // own manager write them. Submitting a report is `bug.create`'s mirror —
  // only a tester actively assigned to the project may file one, and only
  // for a case assigned to them (checked in the service, not here).
  'testcase.read': {
    relations: [
      'platform:admin',
      'platform:subadmin',
      'project:customer',
      'project:manager',
      'project:tester_active',
      'project:tester_past',
    ],
    permission: PERMISSIONS.PROJECT_READ,
  },
  'testcase.manage': {
    relations: ['platform:admin', 'platform:subadmin', 'project:manager'],
    permission: PERMISSIONS.PROJECT_WRITE,
  },
  'testreport.create': { relations: ['project:tester_active'] },
  'testreview.create': {
    relations: ['platform:admin', 'platform:subadmin', 'project:manager'],
    permission: PERMISSIONS.PROJECT_WRITE,
  },
}

/** Non-throwing check. */
export function can(
  user: Express.AuthenticatedUser,
  action: Action,
  relations: RelationSet,
): boolean {
  const rule = POLICY[action]

  // Admin bypasses the permission table entirely.
  if (relations.has('platform:admin') && rule.relations.includes('platform:admin')) {
    return true
  }

  if (relations.has('platform:subadmin') && rule.relations.includes('platform:subadmin')) {
    if (!rule.permission) return true
    if (user.permissions.includes(rule.permission)) return true
    // Fall through: a sub-admin might still qualify through a non-platform
    // relation, e.g. they are personally a manager on this project.
  }

  return rule.relations.some(
    (relation) =>
      relation !== 'platform:admin' && relation !== 'platform:subadmin' && relations.has(relation),
  )
}

/** Throwing variant for use at the top of a service method. */
export function authorize(
  user: Express.AuthenticatedUser,
  action: Action,
  relations: RelationSet,
): void {
  if (!can(user, action, relations)) {
    throw new ForbiddenError(`You do not have permission to ${describe(action)}`)
  }
}

function describe(action: Action): string {
  return action.replace('.', ' ').replace(/_/g, ' ')
}

// ─── Bug status workflow ─────────────────────────────────────────────────────

/**
 * Who is making the change, derived from their relations. A user can hold more
 * than one — a customer who is also the project manager gets the union.
 */
export type BugActor = 'platform' | 'customer' | 'reporter'

export function bugActors(relations: RelationSet): BugActor[] {
  const actors: BugActor[] = []
  if (
    relations.has('platform:admin') ||
    relations.has('platform:subadmin') ||
    relations.has('project:manager')
  ) {
    actors.push('platform')
  }
  if (relations.has('bug:customer')) actors.push('customer')
  if (relations.has('bug:reporter')) actors.push('reporter')
  return actors
}

/**
 * The defect lifecycle, as it actually runs in a crowd-testing engagement:
 *
 *   tester reports          → NEW
 *   admin/manager triages   → CONFIRMED | REJECTED | DUPLICATE
 *   customer works it       → IN_PROGRESS → FIXED | WONT_FIX
 *   tester re-tests the fix → VERIFIED | REOPENED
 *
 * Note the deliberate asymmetry: a customer may mark their own fix FIXED, but
 * NOT VERIFIED. Verification belongs to the tester who found the defect (or an
 * admin) — letting the customer close their own loop would defeat the point of
 * paying for independent testing.
 */
const TRANSITIONS: Record<BugStatus, Partial<Record<BugActor, BugStatus[]>>> = {
  [BugStatus.NEW]: {
    platform: [
      BugStatus.TRIAGED,
      BugStatus.CONFIRMED,
      BugStatus.REJECTED,
      BugStatus.DUPLICATE,
      BugStatus.WONT_FIX,
      BugStatus.FEATURE_REQUEST,
    ],
    // The customer can act on a report before triage — "already known",
    // "already fixed", "not a bug".
    customer: [
      BugStatus.CONFIRMED,
      BugStatus.IN_PROGRESS,
      BugStatus.REJECTED,
      BugStatus.DUPLICATE,
      BugStatus.WONT_FIX,
      BugStatus.FEATURE_REQUEST,
    ],
  },
  [BugStatus.TRIAGED]: {
    platform: [
      BugStatus.CONFIRMED,
      BugStatus.REJECTED,
      BugStatus.DUPLICATE,
      BugStatus.WONT_FIX,
      BugStatus.IN_PROGRESS,
      BugStatus.FEATURE_REQUEST,
    ],
    customer: [
      BugStatus.CONFIRMED,
      BugStatus.IN_PROGRESS,
      BugStatus.REJECTED,
      BugStatus.DUPLICATE,
      BugStatus.WONT_FIX,
      BugStatus.FEATURE_REQUEST,
    ],
  },
  [BugStatus.CONFIRMED]: {
    platform: [BugStatus.IN_PROGRESS, BugStatus.FIXED, BugStatus.WONT_FIX, BugStatus.DUPLICATE],
    customer: [BugStatus.IN_PROGRESS, BugStatus.FIXED, BugStatus.WONT_FIX, BugStatus.DUPLICATE],
  },
  [BugStatus.IN_PROGRESS]: {
    platform: [BugStatus.FIXED, BugStatus.WONT_FIX, BugStatus.CONFIRMED],
    customer: [BugStatus.FIXED, BugStatus.WONT_FIX, BugStatus.CONFIRMED],
  },
  [BugStatus.FIXED]: {
    platform: [BugStatus.VERIFIED, BugStatus.REOPENED],
    // The reporter re-tests and has the final word.
    reporter: [BugStatus.VERIFIED, BugStatus.REOPENED],
    // The customer may reopen their own fix, but cannot verify it.
    customer: [BugStatus.REOPENED],
  },
  [BugStatus.VERIFIED]: {
    platform: [BugStatus.REOPENED],
    customer: [BugStatus.REOPENED],
    reporter: [BugStatus.REOPENED],
  },
  [BugStatus.REOPENED]: {
    platform: [BugStatus.CONFIRMED, BugStatus.IN_PROGRESS, BugStatus.FIXED, BugStatus.WONT_FIX],
    customer: [BugStatus.IN_PROGRESS, BugStatus.FIXED, BugStatus.WONT_FIX],
  },
  [BugStatus.REJECTED]: {
    // Reversible on appeal — the reporter argues it in a comment, an admin acts.
    platform: [BugStatus.NEW, BugStatus.CONFIRMED],
    customer: [BugStatus.CONFIRMED],
  },
  [BugStatus.DUPLICATE]: {
    platform: [BugStatus.NEW, BugStatus.CONFIRMED],
    customer: [BugStatus.CONFIRMED],
  },
  [BugStatus.WONT_FIX]: {
    platform: [BugStatus.CONFIRMED, BugStatus.IN_PROGRESS],
    customer: [BugStatus.CONFIRMED, BugStatus.IN_PROGRESS],
  },
  [BugStatus.FEATURE_REQUEST]: {
    // Reversible on appeal, same as REJECTED/DUPLICATE — a reporter can argue
    // in a comment that it really is a defect.
    platform: [BugStatus.NEW, BugStatus.CONFIRMED],
    customer: [BugStatus.CONFIRMED],
  },
}

/** Union of everything the given actors may move this bug to. */
export function allowedTransitions(from: BugStatus, actors: BugActor[]): BugStatus[] {
  const allowed = new Set<BugStatus>()
  for (const actor of actors) {
    for (const status of TRANSITIONS[from][actor] ?? []) allowed.add(status)
  }
  return [...allowed]
}

export function canTransition(from: BugStatus, to: BugStatus, actors: BugActor[]): boolean {
  return allowedTransitions(from, actors).includes(to)
}

/**
 * A reporter may withdraw their own report only before anyone has acted on it.
 * Once triaged it is part of the engagement record.
 */
export function canReporterDelete(status: BugStatus): boolean {
  return status === BugStatus.NEW
}

/** Same rule for editing the substance of a report. */
export function canReporterEdit(status: BugStatus): boolean {
  return status === BugStatus.NEW
}
