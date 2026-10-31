/**
 * Run with `npx tsx --test tests/*.test.ts`. The refresh cookie must stay on
 * crowd4test.com; only the access cookie and the marker go to the domain.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import './with-cookie-domain'
import {
  domainFor,
  sharedSessionFixes,
  SHARED_MARKER_COOKIE,
  SHARED_MARKER_VALUE,
  markerCookie,
} from '@/lib/auth/shared-session'

/** A JWT-shaped value whose `exp` is an hour away. Never verified here. */
const access = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.y`

function fixes(
  jar: Record<string, string>,
  header?: string,
  alreadySet: string[] = [],
  action = false,
) {
  const cookieHeader =
    header ??
    Object.entries(jar)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')
  return sharedSessionFixes(cookieHeader, (name) => jar[name], alreadySet, action)
}

test('only the access cookie and the marker are written under the domain', () => {
  assert.equal(domainFor('c4t_access'), '.c4t.test')
  assert.equal(domainFor(SHARED_MARKER_COOKIE), '.c4t.test')
  assert.equal(domainFor('c4t_refresh'), undefined)
  assert.equal(markerCookie('.c4t.test').value, SHARED_MARKER_VALUE)
  assert.notEqual(SHARED_MARKER_VALUE, '1')
})

test('a browser on the old marker has its domain refresh cookie moved to this host', () => {
  const result = fixes({ c4t_access: access, c4t_refresh: 'r1', [SHARED_MARKER_COOKIE]: '1' })
  const refresh = result.set.find((cookie) => cookie.name === 'c4t_refresh')
  assert.ok(refresh, 'refresh cookie re-written')
  assert.equal(refresh.domain, undefined)
  assert.equal(refresh.value, 'r1')
  assert.ok(
    result.expire.includes(
      'c4t_refresh=; Domain=.c4t.test; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    ),
  )
  assert.equal(result.set.find((cookie) => cookie.name === 'c4t_access')?.domain, '.c4t.test')
  assert.equal(
    result.set.find((cookie) => cookie.name === SHARED_MARKER_COOKIE)?.value,
    SHARED_MARKER_VALUE,
  )
})

test('a browser with no marker gets the same treatment, and the marker', () => {
  const result = fixes({ c4t_refresh: 'r1' })
  assert.equal(result.set.find((cookie) => cookie.name === 'c4t_refresh')?.domain, undefined)
  assert.ok(result.expire.some((line) => line.startsWith('c4t_refresh=; Domain=.c4t.test')))
  assert.ok(result.set.some((cookie) => cookie.name === SHARED_MARKER_COOKIE))
})

test('a current browser is left alone', () => {
  const result = fixes({
    c4t_access: access,
    c4t_refresh: 'r1',
    [SHARED_MARKER_COOKIE]: SHARED_MARKER_VALUE,
  })
  assert.deepEqual(result, { set: [], expire: [], duplicated: false })
})

test('a refresh cookie sent twice keeps the newer value, host-only', () => {
  const jar = {
    c4t_access: access,
    c4t_refresh: 'newer',
    [SHARED_MARKER_COOKIE]: SHARED_MARKER_VALUE,
  }
  const header = `c4t_access=${access}; c4t_refresh=older; c4t_refresh=newer; ${SHARED_MARKER_COOKIE}=${SHARED_MARKER_VALUE}`
  const result = fixes(jar, header)
  assert.equal(result.duplicated, true)
  assert.deepEqual(
    result.set.map((cookie) => [cookie.name, cookie.value, cookie.domain]),
    [['c4t_refresh', 'newer', undefined]],
  )
  assert.ok(result.expire.some((line) => line.startsWith('c4t_refresh=; Domain=.c4t.test')))
})

test('a refresh this response already wrote is not overwritten', () => {
  const result = fixes({ c4t_refresh: 'old', [SHARED_MARKER_COOKIE]: '1' }, undefined, [
    'c4t_refresh',
  ])
  assert.equal(
    result.set.find((cookie) => cookie.name === 'c4t_refresh'),
    undefined,
  )
  assert.ok(result.expire.some((line) => line.startsWith('c4t_refresh=; Domain=.c4t.test')))
})

test('every Server Action expires a domain refresh cookie, so sign-out removes both copies', () => {
  const jar = { c4t_access: access, c4t_refresh: 'r1', [SHARED_MARKER_COOKIE]: SHARED_MARKER_VALUE }
  const result = fixes(jar, undefined, [], true)
  assert.deepEqual(result.set, [])
  assert.deepEqual(
    result.expire.map((line) => line.split(';').slice(0, 2).join(';')),
    ['c4t_refresh=; Domain=.c4t.test'],
  )
})
