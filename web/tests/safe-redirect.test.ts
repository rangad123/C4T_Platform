/**
 * Run with `npx tsx --test tests/*.test.ts`. No test runner is installed in this
 * package, so these use Node's own.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSameOriginPath, safeNext } from '@/lib/safe-redirect'

test('refuses targets a browser would send to another host', () => {
  for (const next of [
    '/\t/evil.example', // browsers strip the tab, leaving //evil.example
    '/\n/evil.example',
    '/\r/evil.example',
    '/ /evil.example',
    '/\u007f/evil.example',
    decodeURIComponent('/%09/evil.example'), // what ?next=/%09/evil.example arrives as
    '/\\evil.example',
    '/\\/evil.example',
    '//evil.example',
    'https://evil.example',
    'javascript:alert(1)',
    'evil.example',
    '',
  ]) {
    assert.equal(safeNext(next), null, JSON.stringify(next))
    assert.equal(isSameOriginPath(next), false, JSON.stringify(next))
  }
})

test('keeps paths on this site', () => {
  for (const next of [
    '/app',
    '/app/tester/projects?tab=open&page=2',
    '/invitations/AbC-123_xyz',
    '/app/customer#section',
    '/blog/%E2%9C%93',
  ]) {
    assert.equal(safeNext(next), next)
  }
  // Logout sends people back to sign-in with their invitation queued.
  assert.equal(isSameOriginPath('/login?next=%2Finvitations%2Fabc'), true)
  assert.equal(safeNext('/login?next=%2Finvitations%2Fabc'), null)
})
