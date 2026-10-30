import { z } from 'zod'
import { Role } from '@prisma/client'

export const organisationsQuery = z.object({
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

export const organisationIdParam = z.object({ id: z.string().min(1).max(64) })

/** USER is absent on purpose: an unfinished sign-up cannot join a project. */
export const PEOPLE_KINDS = [Role.CUSTOMER, Role.TESTER, Role.SUB_ADMIN, Role.ADMIN] as const

export const peopleQuery = z.object({
  q: z.string().trim().max(120).optional(),
  kind: z.enum(PEOPLE_KINDS).optional(),
  organisationId: z.string().min(1).max(64).optional(),
})

export type OrganisationsQuery = z.infer<typeof organisationsQuery>
export type PeopleQuery = z.infer<typeof peopleQuery>
