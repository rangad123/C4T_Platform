/**
 * Run with `npx tsx --test tests/*.test.ts`. Where `/app/ai-studio` sends a
 * visitor. A session the API could not read (a restart during a deploy, a
 * rate limit) used to count as signed out and sent the person to type their
 * password again; it now answers 503 so they reload instead.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aiStudioHandOff } from '@/lib/navigation/ai-studio'
import { couldNotTell } from '@/lib/auth/session-read'
import { ApiError } from '@/lib/api/types'

const STUDIO = 'https://aistudio.c4t.test/'

test('a session that could not be read is not sent to the sign-in form', () => {
  assert.deepEqual(aiStudioHandOff(undefined, '/projects/p1', STUDIO), { status: 503 })
})

test('signed out: sign in, then back to the same AI Studio page', () => {
  const next = aiStudioHandOff(null, '/projects/p1/tests', STUDIO)
  assert.equal(next.status, 307)
  assert.equal(
    next.location,
    `/login?next=${encodeURIComponent(`/app/ai-studio?to=${encodeURIComponent('/projects/p1/tests')}`)}`,
  )
})

test('signed in: on to the page asked for, and never another host', () => {
  const admin = { role: 'ADMIN' as const, permissions: [] }
  assert.equal(aiStudioHandOff(admin, '/projects/p1', STUDIO).location, `${STUDIO}#/projects/p1`)
  assert.equal(aiStudioHandOff(admin, '//evil.example', STUDIO).location, `${STUDIO}#/`)
  assert.equal(aiStudioHandOff({ role: 'TESTER', permissions: [] }, '/', STUDIO).location, '/app/tester?notice=ai-studio-no-access')
})

test('only a dropped connection, a 5xx or a 429 count as "could not tell"; a 403 is an answer', () => {
  assert.equal(couldNotTell(new Error('fetch failed')), true)
  assert.equal(couldNotTell(new ApiError(502, {})), true)
  assert.equal(couldNotTell(new ApiError(429, {})), true)
  // A suspended or deactivated account: answering 503 would ask them to reload for ever.
  assert.equal(couldNotTell(new ApiError(403, { error: { code: 'FORBIDDEN', message: 'This account is suspended' } })), false)
  assert.equal(couldNotTell(new ApiError(400, {})), false)
})
