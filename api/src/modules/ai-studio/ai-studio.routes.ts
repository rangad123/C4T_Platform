import { Router } from 'express'
import { env } from '../../config/env.js'
import { param } from '../../lib/http.js'
import { requireServiceToken } from '../../middleware/serviceToken.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import * as service from './ai-studio.service.js'
import {
  organisationsQuery,
  organisationIdParam,
  peopleQuery,
  type OrganisationsQuery,
  type PeopleQuery,
} from './ai-studio.schema.js'

/**
 * `/v1/ai-studio/*` — read-only, server-to-server, for AI Studio's own API.
 *
 * Authenticated by AI_STUDIO_SERVICE_TOKEN alone, never by a user session:
 * these reads cross every organisation, which no single person's session is
 * meant to see. AI Studio decides who may see the results on its side. With
 * the variable unset every route here answers 404.
 */
export const aiStudioRouter = Router()

aiStudioRouter.use(requireServiceToken(env.AI_STUDIO_SERVICE_TOKEN))

aiStudioRouter.get('/organisations', validate({ query: organisationsQuery }), async (_req, res) => {
  const query = validatedQuery<OrganisationsQuery>(res)
  res.json({ data: await service.listOrganisations(query) })
})

aiStudioRouter.get(
  '/organisations/:id/projects',
  validate({ params: organisationIdParam }),
  async (req, res) => {
    res.json({ data: await service.listOrganisationProjects(param(req, 'id')) })
  },
)

aiStudioRouter.get('/people', validate({ query: peopleQuery }), async (_req, res) => {
  const query = validatedQuery<PeopleQuery>(res)
  res.json({ data: await service.searchPeople(query) })
})
