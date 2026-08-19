import { randomBytes } from 'node:crypto'
import type { SessionTokens } from '../../modules/auth/auth.service.js'

/**
 * A short-lived, single-use handoff between the Google OAuth callback (which
 * necessarily lands on THIS API's own origin — Google redirects there, not
 * to the web app) and the web app that actually needs to hold the resulting
 * session cookies.
 *
 * The API and the web app are on unrelated domains in a split deploy (Render
 * + Vercel, or any two arbitrary hosts) — there is no `Domain` a cookie set
 * here could ever carry to make it visible on the web app's origin. So
 * instead of setting cookies in the callback, it mints a one-time code and
 * redirects the browser to the web app with just that code; the web app's
 * own server then exchanges it (server to server, `POST /v1/auth/google/
 * exchange`) for the same tokens the callback would otherwise have put
 * straight into cookies, and sets its OWN cookies from that response —
 * exactly the way password login already does via `cookie-bridge.ts`.
 *
 * In-memory, not the database: this API runs as a single instance, the code
 * lives for well under a minute, and a lost code just means the visitor
 * retries sign-in — not worth a table and a cleanup job for that. A deploy
 * landing in the few-second window between mint and exchange loses it too;
 * same acceptable failure mode as any other in-flight request during a
 * restart.
 */
const TTL_MS = 60_000

interface Entry {
  tokens: SessionTokens
  expiresAt: number
}

const store = new Map<string, Entry>()

function sweep(): void {
  const now = Date.now()
  for (const [code, entry] of store) {
    if (entry.expiresAt <= now) store.delete(code)
  }
}

/** Mints a one-time code for these tokens, valid for TTL_MS. */
export function createHandoff(tokens: SessionTokens): string {
  sweep()
  const code = randomBytes(32).toString('base64url')
  store.set(code, { tokens, expiresAt: Date.now() + TTL_MS })
  return code
}

/**
 * Redeems a code — single-use, so it is deleted the moment it is read,
 * whether or not it turns out to be valid. Returns `null` for an unknown,
 * already-used, or expired code.
 */
export function consumeHandoff(code: string): SessionTokens | null {
  const entry = store.get(code)
  store.delete(code)
  if (!entry || entry.expiresAt <= Date.now()) return null
  return entry.tokens
}
