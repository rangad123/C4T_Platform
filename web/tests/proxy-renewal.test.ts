/**
 * Run with `npx tsx --test tests/*.test.ts`. Proxy's renewal against a
 * stand-in API on a local port: when Proxy spends the refresh cookie.
 *
 * The access cookie's Max-Age runs from when the browser received it, while
 * the token's `exp` runs from when the API signed it (to the whole second,
 * rounded down), so the browser keeps sending the cookie for up to a second
 * or more after the API has started refusing it. A renewal that only looked
 * for a missing cookie did nothing in that window, and AI Studio, retrying,
 * sent the person to the sign-in form although their session was good.
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

let refreshes = 0
const api = http.createServer((req, res) => {
  if (req.url === '/v1/auth/refresh') {
    refreshes += 1
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': [`c4t_access=${token(900)}; Path=/; Max-Age=900; HttpOnly; SameSite=Lax`],
    })
    return res.end('{}')
  }
  res.writeHead(404).end()
})

/** A JWT-shaped value whose `exp` is `seconds` away (negative: already past), signed `age` seconds ago. Never verified. */
function token(seconds: number, age = 900 - seconds): string {
  const now = Math.floor(Date.now() / 1000)
  return `x.${Buffer.from(JSON.stringify({ exp: now + seconds, iat: now - age })).toString('base64url')}.y`
}

let proxy: typeof import('@/proxy').proxy
let NextRequest: typeof import('next/server').NextRequest

before(async () => {
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
  process.env.API_ORIGIN = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
  ;({ proxy } = await import('@/proxy'))
  ;({ NextRequest } = await import('next/server'))
})
after(() => new Promise<void>((r) => api.close(() => r())))
beforeEach(() => {
  refreshes = 0
})

async function visit(path: string, cookies: Record<string, string>, headers: Record<string, string> = {}) {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
  const res = await proxy(
    new NextRequest(`http://localhost:3000${path}`, { headers: { cookie, ...headers } }),
  )
  return { res, renewed: res.cookies.get('c4t_access')?.value }
}

/** How AI Studio's background request arrives: from aistudio.crowd4test.com, the same site. */
const FROM_AI_STUDIO = { 'sec-fetch-site': 'same-site' }

test('renews an access cookie the browser still sends after its token has run out', async () => {
  const { renewed } = await visit('/app/dashboard', {
    c4t_access: token(-1),
    c4t_refresh: 'r-stale-cookie',
  })
  assert.equal(refreshes, 1)
  assert.ok(renewed, 'the rotated access cookie is set on the response')
})

test('renews a token about to run out, so a page is not served with it', async () => {
  await visit('/app/dashboard', { c4t_access: token(5), c4t_refresh: 'r-expiring' })
  assert.equal(refreshes, 1)
})

test('renews an access cookie that is not a readable token', async () => {
  await visit('/app/dashboard', { c4t_access: 'not-a-token', c4t_refresh: 'r-garbled' })
  await visit('/app/dashboard', { c4t_access: 'x.bm90IGpzb24.y', c4t_refresh: 'r-garbled-2' })
  assert.equal(refreshes, 2)
})

test("renews on AI Studio's renewal path when AI Studio asks, the cookie's age aside", async () => {
  // AI Studio asks only after the API refused the cookie, whatever the reason.
  await visit('/app/ai-studio/refresh', { c4t_access: token(600), c4t_refresh: 'r-asked' }, FROM_AI_STUDIO)
  await visit('/app/ai-studio/refresh', { c4t_access: token(600), c4t_refresh: 'r-asked-2' }, { 'sec-fetch-site': 'same-origin' })
  assert.equal(refreshes, 2)
})

test('a link from another site, or no Sec-Fetch-Site, cannot make the renewal path rotate a good token', async () => {
  await visit('/app/ai-studio/refresh', { c4t_access: token(600), c4t_refresh: 'r-cross' }, { 'sec-fetch-site': 'cross-site' })
  await visit('/app/ai-studio/refresh', { c4t_access: token(600), c4t_refresh: 'r-none' })
  assert.equal(refreshes, 0)
  // An expired one is still renewed, as anywhere under /app.
  await visit('/app/ai-studio/refresh', { c4t_access: token(-1), c4t_refresh: 'r-cross-expired' }, { 'sec-fetch-site': 'cross-site' })
  assert.equal(refreshes, 1)
})

test('a token renewed a moment ago is not rotated again when AI Studio asks once more', async () => {
  await visit('/app/ai-studio/refresh', { c4t_access: token(895, 5), c4t_refresh: 'r-just' }, FROM_AI_STUDIO)
  assert.equal(refreshes, 0)
})

test('leaves a fresh access cookie alone elsewhere, and never renews without a refresh cookie', async () => {
  await visit('/app/dashboard', { c4t_access: token(600), c4t_refresh: 'r-fresh' })
  await visit('/app/ai-studio/refresh', { c4t_access: token(-1) }, FROM_AI_STUDIO)
  assert.equal(refreshes, 0)
})
