import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import supertest from 'supertest'

/**
 * Two holes in how a sign-in reaches the browser.
 *
 * The refresh cookie is a 30-day credential. With COOKIE_DOMAIN set it was
 * written for the whole parent domain, so every subdomain received it though
 * none spends it. Only the access cookie may carry the Domain.
 *
 * The Google handoff code was redeemable by anyone holding the link: finish a
 * Google sign-in with your own account, send the completion link to someone
 * else, and their browser signs into your account. The code now only redeems
 * with the `c4t_oauth_handoff` cookie the callback wrote on the browser that
 * passed the state check.
 */

vi.hoisted(() => {
  process.env.COOKIE_DOMAIN = '.c4t.test'
  process.env.GOOGLE_CLIENT_ID = 'test-client'
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret'
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost:4000/v1/auth/google/callback'
})

vi.mock('../../src/lib/oauth/google.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  exchangeCodeForIdentity: vi.fn(() =>
    Promise.resolve({
      subject: 'google-sub-sign-in-cookies',
      email: 'google-sign-in-cookies@example.com',
      emailVerified: true,
      firstName: 'Grace',
      lastName: 'Google',
    }),
  ),
}))

const { prisma } = await import('../../src/lib/prisma.js')
const { createState } = await import('../../src/lib/oauth/google.js')
const { resetDatabase, seedWorld, PASSWORD } = await import('../helpers/fixtures.js')
const { testApp } = await import('../helpers/client.js')

type World = Awaited<ReturnType<typeof seedWorld>>
let world: World

const setCookies = (response: { headers: Record<string, unknown> }): string[] => {
  const raw = response.headers['set-cookie']
  return Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : []
}
const cookieLines = (response: { headers: Record<string, unknown> }, name: string) =>
  setCookies(response).filter((line) => line.startsWith(`${name}=`))
const hasDomain = (line: string) => /;\s*Domain=/i.test(line)

beforeAll(async () => {
  await resetDatabase()
  world = await seedWorld()
}, 60_000)

afterAll(async () => {
  await prisma.$disconnect()
})

describe('session cookies with COOKIE_DOMAIN set', () => {
  it('scopes the access cookie to the domain and keeps the refresh cookie host-only', async () => {
    const response = await supertest(testApp())
      .post('/v1/auth/login')
      .send({ email: world.customerA.email, password: PASSWORD })
    expect(response.status).toBe(200)

    const [access] = cookieLines(response, 'c4t_access')
    const refresh = cookieLines(response, 'c4t_refresh')
    expect(access).toBeDefined()
    expect(access).toMatch(/Domain=\.c4t\.test/i)
    expect(refresh).toHaveLength(1)
    expect(hasDomain(refresh[0]!)).toBe(false)
  })

  it('signing out clears the refresh cookie host-only and any old copy under the domain', async () => {
    const login = await supertest(testApp())
      .post('/v1/auth/login')
      .send({ email: world.customerA.email, password: PASSWORD })
    const token = login.body.data.accessToken as string

    const response = await supertest(testApp())
      .post('/v1/auth/logout')
      .set('authorization', `Bearer ${token}`)
      .send({})
    expect(response.status).toBe(200)

    const refresh = cookieLines(response, 'c4t_refresh')
    expect(refresh.some((line) => !hasDomain(line))).toBe(true)
    expect(refresh.some((line) => /Domain=\.c4t\.test/i.test(line))).toBe(true)
    expect(cookieLines(response, 'c4t_access').every((line) => hasDomain(line))).toBe(true)
  })
})

describe('Google handoff code', () => {
  /** Runs the callback as the browser that started the flow would. */
  async function completedCallback(): Promise<{ code: string; binding: string }> {
    const { state, nonce } = createState('/app', 'register')
    const response = await supertest(testApp())
      .get('/v1/auth/google/callback')
      .query({ code: 'google-code', state })
      .set('cookie', `c4t_oauth_nonce=${nonce}`)
    expect(response.status).toBe(302)

    const location = new URL(String(response.headers.location))
    expect(location.pathname).toBe('/auth/google/complete')
    const code = location.searchParams.get('code')!

    const [line] = cookieLines(response, 'c4t_oauth_handoff')
    expect(line).toBeDefined()
    expect(line).toMatch(/HttpOnly/i)
    const binding = decodeURIComponent(line!.slice('c4t_oauth_handoff='.length).split(';')[0]!)
    expect(binding.length).toBeGreaterThan(20)
    return { code, binding }
  }

  const exchange = (body: object) =>
    supertest(testApp()).post('/v1/auth/google/exchange').send(body)

  it('refuses a code presented without the browser binding', async () => {
    const { code } = await completedCallback()
    const response = await exchange({ code })
    expect(response.status).toBe(401)
    expect(cookieLines(response, 'c4t_access')).toHaveLength(0)
  })

  it("refuses a code presented with another flow's binding", async () => {
    const attacker = await completedCallback()
    const victim = await completedCallback()
    const response = await exchange({ code: attacker.code, binding: victim.binding })
    expect(response.status).toBe(401)
  })

  it('redeems a code with its own binding, once', async () => {
    const { code, binding } = await completedCallback()
    const response = await exchange({ code, binding })
    expect(response.status).toBe(200)
    expect(cookieLines(response, 'c4t_access')).toHaveLength(1)
    expect(hasDomain(cookieLines(response, 'c4t_refresh')[0]!)).toBe(false)

    const again = await exchange({ code, binding })
    expect(again.status).toBe(401)
  })

  it('a wrong binding still uses the code up', async () => {
    const { code, binding } = await completedCallback()
    expect((await exchange({ code, binding: `${binding}x` })).status).toBe(401)
    expect((await exchange({ code, binding })).status).toBe(401)
  })
})
