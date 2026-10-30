import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import supertest from 'supertest'

vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }))

import { requireServiceToken } from '../../src/middleware/serviceToken.js'
import { errorHandler, notFoundHandler } from '../../src/middleware/errorHandler.js'

const TOKEN = 'a'.repeat(20) + 'service-token-for-tests'

/** The guard in front of one route, with the API's own error handlers. */
function appWith(expected: string | undefined) {
  const app = express()
  const router = express.Router()
  router.use(requireServiceToken(expected))
  router.get('/organisations', (_req, res) => {
    res.json({ data: [] })
  })
  app.use('/v1/ai-studio', router)
  app.use(notFoundHandler)
  app.use(errorHandler)
  return supertest(app)
}

describe('requireServiceToken', () => {
  it('answers 404 when no token is configured', async () => {
    const response = await appWith(undefined)
      .get('/v1/ai-studio/organisations')
      .set('authorization', `Bearer ${TOKEN}`)
    expect(response.status).toBe(404)
    expect(response.body.error.message).toBe('Route GET /v1/ai-studio/organisations not found')
  })

  it('treats a token shorter than 32 characters as not configured', async () => {
    const short = 'too-short'
    const response = await appWith(short)
      .get('/v1/ai-studio/organisations')
      .set('authorization', `Bearer ${short}`)
    expect(response.status).toBe(404)
  })

  it('refuses a request without a token', async () => {
    const response = await appWith(TOKEN).get('/v1/ai-studio/organisations')
    expect(response.status).toBe(401)
  })

  it('refuses a wrong token, including one that differs only in length', async () => {
    for (const presented of ['wrong', TOKEN.slice(0, -1), `${TOKEN}x`]) {
      const response = await appWith(TOKEN)
        .get('/v1/ai-studio/organisations')
        .set('authorization', `Bearer ${presented}`)
      expect(response.status).toBe(401)
    }
  })

  it('ignores a user session cookie: a session alone does not get in', async () => {
    const response = await appWith(TOKEN)
      .get('/v1/ai-studio/organisations')
      .set('cookie', 'c4t_access=some-user-access-token')
    expect(response.status).toBe(401)
  })

  it('refuses the token in any scheme other than Bearer', async () => {
    const response = await appWith(TOKEN)
      .get('/v1/ai-studio/organisations')
      .set('authorization', `Basic ${TOKEN}`)
    expect(response.status).toBe(401)
  })

  it('lets the right token through, uncached', async () => {
    const response = await appWith(TOKEN)
      .get('/v1/ai-studio/organisations')
      .set('authorization', `Bearer ${TOKEN}`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ data: [] })
    expect(response.headers['cache-control']).toBe('no-store')
  })
})
