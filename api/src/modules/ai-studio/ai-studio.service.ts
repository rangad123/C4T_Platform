import { type Prisma, UserStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { searchTerms } from '../../lib/search.js'
import { NotFoundError } from '../../lib/errors.js'
import { PEOPLE_KINDS, type OrganisationsQuery, type PeopleQuery } from './ai-studio.schema.js'

/**
 * Read-only lookups for AI Studio's server. AI Studio keeps no copy of C4T's
 * admin data: it mirrors organisations and people lazily, and asks here when a
 * project admin picks an organisation, links a C4T project or adds a person.
 *
 * Each read returns the few fields AI Studio stores and nothing else — no
 * contact details, notes or tax ids, whatever the caller might find useful.
 */

const PROJECT_LIMIT = 500
const PEOPLE_LIMIT = 20

export async function listOrganisations(query: OrganisationsQuery) {
  const terms = searchTerms(query.q)
  return prisma.organisation.findMany({
    where: {
      deletedAt: null,
      ...(terms.length > 0
        ? { AND: terms.map((term) => ({ name: { contains: term, mode: 'insensitive' as const } })) }
        : {}),
    },
    select: { id: true, name: true, status: true },
    orderBy: { name: 'asc' },
    take: query.limit,
  })
}

export async function listOrganisationProjects(organisationId: string) {
  const organisation = await prisma.organisation.findFirst({
    where: { id: organisationId, deletedAt: null },
    select: { id: true },
  })
  if (!organisation) throw new NotFoundError('Organisation')

  return prisma.project.findMany({
    where: { organisationId, deletedAt: null },
    select: { id: true, reference: true, title: true, status: true },
    orderBy: { createdAt: 'desc' },
    take: PROJECT_LIMIT,
  })
}

/**
 * People a project admin can add to an AI Studio project. Active accounts
 * only: a suspended, archived or unverified account cannot sign in to AI
 * Studio anyway. `name` falls back to the email for accounts without one.
 */
export async function searchPeople(query: PeopleQuery) {
  const terms = searchTerms(query.q)
  const where: Prisma.UserWhereInput = {
    deletedAt: null,
    status: UserStatus.ACTIVE,
    role: query.kind ?? { in: [...PEOPLE_KINDS] },
    ...(query.organisationId
      ? { orgMemberships: { some: { organisationId: query.organisationId } } }
      : {}),
    ...(terms.length > 0
      ? {
          AND: terms.map((term) => ({
            OR: [
              { email: { contains: term, mode: 'insensitive' as const } },
              { firstName: { contains: term, mode: 'insensitive' as const } },
              { lastName: { contains: term, mode: 'insensitive' as const } },
            ],
          })),
        }
      : {}),
  }

  const users = await prisma.user.findMany({
    where,
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      orgMemberships: {
        select: { organisationId: true },
        orderBy: { createdAt: 'asc' },
        take: 1,
      },
    },
    orderBy: [{ firstName: 'asc' }, { email: 'asc' }],
    take: PEOPLE_LIMIT,
  })

  return users.map((user) => ({
    id: user.id,
    name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
    email: user.email,
    kind: user.role,
    organisationId: user.orgMemberships[0]?.organisationId ?? null,
  }))
}
