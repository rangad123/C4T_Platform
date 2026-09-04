import { Role, AssignmentStatus } from '@prisma/client'
import { prisma } from '../prisma.js'
import { BadRequestError, ForbiddenError } from '../errors.js'
import { isAdminSide } from '../../middleware/authorize.js'
import { PERMISSIONS } from '../../config/permissions.js'

/**
 * "You may only say something about work that actually happened."
 *
 * The single rule behind both recognitions a person can leave on another —
 * a `Rating` (one number) and a `TesterBadge` (one named commendation).
 * Extracted here rather than duplicated in the badges module: the two
 * features are the same judgement expressed differently, and letting their
 * authorisation drift apart would mean a badge could be handed out in a
 * situation where a rating is refused.
 *
 * Statuses that count as work are ACTIVE and COMPLETED: an invitation never
 * taken up is not work, so it can be neither rated nor badged.
 */
const WORKED: AssignmentStatus[] = [AssignmentStatus.ACTIVE, AssignmentStatus.COMPLETED]

export async function assertWorkedTogether(
  author: Express.AuthenticatedUser,
  subjectUserId: string,
  projectId: string,
): Promise<void> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, organisationId: true },
  })
  if (!project) throw new BadRequestError('Project does not exist')

  /**
   * The delivery team — admins, sub-admins, and the project managers among
   * them, who are admin-side users with a ManagerAssignment rather than a
   * role of their own.
   *
   * They did not "work with" the tester the way a customer did, so the
   * co-membership half of the rule cannot apply to them. What still applies,
   * and is the part that matters, is that the recognition has to describe
   * real work: the tester must actually have been on this project.
   *
   * Gated on a permission rather than on the role, so a sub-admin can be
   * given read-and-moderate without also being able to author. ADMIN passes
   * everything, matching `requirePermission`, which cannot be used here —
   * it is middleware that rejects customers and testers outright, and they
   * post to these routes too.
   */
  if (isAdminSide(author)) {
    const mayWrite =
      author.role === Role.ADMIN || (author.permissions ?? []).includes(PERMISSIONS.RATING_WRITE)
    if (!mayWrite) {
      throw new ForbiddenError('You do not have permission to leave ratings')
    }
    const wasAssigned = await prisma.projectAssignment.findFirst({
      where: { projectId, testerId: subjectUserId, status: { in: WORKED } },
      select: { id: true },
    })
    if (!wasAssigned) throw new BadRequestError('That tester did not work on this project')
    return
  }

  if (author.role === Role.CUSTOMER) {
    const [isMember, wasAssigned] = await Promise.all([
      prisma.organisationMember.findFirst({
        where: { organisationId: project.organisationId, userId: author.id },
        select: { id: true },
      }),
      prisma.projectAssignment.findFirst({
        where: { projectId, testerId: subjectUserId, status: { in: WORKED } },
        select: { id: true },
      }),
    ])
    if (!isMember) throw new ForbiddenError('That project does not belong to your organisation')
    if (!wasAssigned) throw new BadRequestError('That tester did not work on this project')
    return
  }

  if (author.role === Role.TESTER) {
    const [wasAssigned, subjectIsMember] = await Promise.all([
      prisma.projectAssignment.findFirst({
        where: { projectId, testerId: author.id, status: { in: WORKED } },
        select: { id: true },
      }),
      prisma.organisationMember.findFirst({
        where: { organisationId: project.organisationId, userId: subjectUserId },
        select: { id: true },
      }),
    ])
    if (!wasAssigned) throw new BadRequestError('You did not work on this project')
    if (!subjectIsMember) throw new BadRequestError('That customer is not on this project')
    return
  }

  throw new ForbiddenError('Your role cannot leave ratings')
}
