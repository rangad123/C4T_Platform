import { AssignmentStatus, OrgMemberRole, Role } from '@prisma/client'
import { prisma } from '../prisma.js'

/**
 * Relationship resolution — the factual half of access control.
 *
 * Role alone cannot answer "may this tester read this bug?". The answer depends
 * on whether they reported it, whether they are still assigned to its project,
 * and whether that assignment was accepted. Those are RELATIONSHIPS, and this
 * module is the only place that computes them.
 *
 * `policy.ts` turns a relation set into a yes/no. `scopes.ts` turns the same
 * relationships into Prisma filters for list endpoints. Keeping the three
 * separate stops the "can I see one" and "which can I see" answers drifting
 * apart, which is the classic way authorisation bugs get shipped.
 */

export type Relation =
  // Platform-level
  | 'platform:admin'
  | 'platform:subadmin'
  // Organisation
  | 'org:owner'
  | 'org:member'
  // Project
  | 'project:manager'
  | 'project:customer'
  | 'project:tester_invited'
  | 'project:tester_active'
  | 'project:tester_past'
  // Bug
  | 'bug:reporter'
  | 'bug:customer'
  /// Active tester on the bug's project, and that project has opted in to
  /// letting its testers see each other's reports (§2.2 Build Settings).
  | 'bug:project_tester'
  // Thread
  | 'thread:participant'
  // Self
  | 'self'

export type RelationSet = ReadonlySet<Relation>

const NONE: RelationSet = new Set()

function baseRelations(user: Express.AuthenticatedUser): Relation[] {
  if (user.role === Role.ADMIN) return ['platform:admin']
  if (user.role === Role.SUB_ADMIN) return ['platform:subadmin']
  return []
}

/** Assignment statuses that count as "currently working on it". */
const ACTIVE_ASSIGNMENT: AssignmentStatus[] = [AssignmentStatus.ACCEPTED, AssignmentStatus.ACTIVE]

// ─── Organisation ────────────────────────────────────────────────────────────

export async function organisationRelations(
  user: Express.AuthenticatedUser,
  organisationId: string,
): Promise<RelationSet> {
  const relations = baseRelations(user)

  const membership = await prisma.organisationMember.findUnique({
    where: { organisationId_userId: { organisationId, userId: user.id } },
    select: { orgRole: true },
  })

  if (membership) {
    relations.push('org:member')
    if (membership.orgRole === OrgMemberRole.OWNER) relations.push('org:owner')
  }

  return new Set(relations)
}

// ─── Project ─────────────────────────────────────────────────────────────────

export interface ProjectContext {
  id: string
  organisationId: string
  status: string
}

/**
 * Resolves every relationship the user has to a project in ONE round trip.
 * Returns null when the project does not exist or is soft-deleted, so callers
 * can 404 without a second query.
 */
export async function projectRelations(
  user: Express.AuthenticatedUser,
  projectId: string,
): Promise<{ relations: RelationSet; project: ProjectContext } | null> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: {
      id: true,
      organisationId: true,
      status: true,
      assignments: {
        where: { testerId: user.id },
        select: { status: true },
        take: 1,
      },
      managers: {
        where: { managerId: user.id },
        select: { id: true },
        take: 1,
      },
      organisation: {
        select: {
          members: { where: { userId: user.id }, select: { orgRole: true }, take: 1 },
        },
      },
    },
  })

  if (!project) return null

  const relations = baseRelations(user)

  const membership = project.organisation.members[0]
  if (membership) {
    relations.push('org:member', 'project:customer')
    if (membership.orgRole === OrgMemberRole.OWNER) relations.push('org:owner')
  }

  if (project.managers.length > 0) relations.push('project:manager')

  const assignment = project.assignments[0]
  if (assignment) {
    if (assignment.status === AssignmentStatus.INVITED) {
      relations.push('project:tester_invited')
    } else if (ACTIVE_ASSIGNMENT.includes(assignment.status)) {
      relations.push('project:tester_active')
    } else if (assignment.status === AssignmentStatus.COMPLETED) {
      relations.push('project:tester_past')
    }
    // DECLINED and REMOVED deliberately grant nothing.
  }

  return {
    relations: new Set(relations),
    project: { id: project.id, organisationId: project.organisationId, status: project.status },
  }
}

// ─── Bug ─────────────────────────────────────────────────────────────────────

export interface BugContext {
  id: string
  projectId: string
  organisationId: string
  reportedById: string
  status: string
}

export async function bugRelations(
  user: Express.AuthenticatedUser,
  bugId: string,
): Promise<{ relations: RelationSet; bug: BugContext } | null> {
  const bug = await prisma.bug.findFirst({
    where: { id: bugId, deletedAt: null },
    select: {
      id: true,
      projectId: true,
      reportedById: true,
      status: true,
      project: {
        select: {
          organisationId: true,
          testersCanSeeOtherBugs: true,
          assignments: { where: { testerId: user.id }, select: { status: true }, take: 1 },
          managers: { where: { managerId: user.id }, select: { id: true }, take: 1 },
          organisation: {
            select: {
              members: { where: { userId: user.id }, select: { orgRole: true }, take: 1 },
            },
          },
        },
      },
    },
  })

  if (!bug) return null

  const relations = baseRelations(user)

  if (bug.reportedById === user.id) relations.push('bug:reporter')

  const membership = bug.project.organisation.members[0]
  if (membership) {
    relations.push('org:member', 'project:customer', 'bug:customer')
    if (membership.orgRole === OrgMemberRole.OWNER) relations.push('org:owner')
  }

  if (bug.project.managers.length > 0) relations.push('project:manager')

  const assignment = bug.project.assignments[0]
  if (assignment) {
    if (assignment.status === AssignmentStatus.INVITED) {
      relations.push('project:tester_invited')
    } else if (ACTIVE_ASSIGNMENT.includes(assignment.status)) {
      relations.push('project:tester_active')
      if (bug.project.testersCanSeeOtherBugs) relations.push('bug:project_tester')
    } else if (assignment.status === AssignmentStatus.COMPLETED) {
      relations.push('project:tester_past')
    }
  }

  return {
    relations: new Set(relations),
    bug: {
      id: bug.id,
      projectId: bug.projectId,
      organisationId: bug.project.organisationId,
      reportedById: bug.reportedById,
      status: bug.status,
    },
  }
}

// ─── Thread ──────────────────────────────────────────────────────────────────

export async function threadRelations(
  user: Express.AuthenticatedUser,
  threadId: string,
): Promise<{ relations: RelationSet; isClosed: boolean } | null> {
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    select: {
      isClosed: true,
      participants: { where: { userId: user.id }, select: { id: true }, take: 1 },
    },
  })

  if (!thread) return null

  const relations = baseRelations(user)
  if (thread.participants.length > 0) relations.push('thread:participant')

  return { relations: new Set(relations), isClosed: thread.isClosed }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function hasAny(relations: RelationSet, ...candidates: Relation[]): boolean {
  return candidates.some((relation) => relations.has(relation))
}

/** Any tester relationship that grants at least read access to the project. */
export const TESTER_RELATIONS: Relation[] = [
  'project:tester_invited',
  'project:tester_active',
  'project:tester_past',
]

/** Admin-side, regardless of which specific permissions are held. */
export const PLATFORM_RELATIONS: Relation[] = ['platform:admin', 'platform:subadmin']

export const EMPTY_RELATIONS = NONE
