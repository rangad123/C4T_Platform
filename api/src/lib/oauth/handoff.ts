import { randomBytes, timingSafeEqual } from 'node:crypto'
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
 * In-memory, not the database: the code lives for well under a minute, and a
 * lost code just means the visitor retries sign-in — not worth a table and a
 * cleanup job for that. A deploy landing in the few-second window between
 * mint and exchange loses it too; same acceptable failure mode as any other
 * in-flight request during a restart.
 *
 * ── THIS REQUIRES A SINGLE PROCESS
 *
 * A `Map` is per-worker. Under PM2 cluster mode the callback mints a code
 * into one worker and the exchange arrives at whichever worker is free, so
 * roughly half of all sign-ins fail with no trace beyond a refused exchange.
 * That happened: `ecosystem.config.cjs` ran `instances: 'max'` against this
 * assumption for as long as both existed, and now pins one instance with a
 * pointer back here.
 *
 * Anyone wanting more workers has to make this shared first — a table keyed
 * by code, or signing the tokens into the code so nothing is stored at all.
 * The second is tempting and worse: it puts session material in a URL, which
 * is exactly what this indirection exists to avoid.
 *
 * ── BOUND TO THE BROWSER THAT SIGNED IN
 *
 * A code alone is not enough to redeem. Otherwise anyone could finish a Google
 * sign-in with their OWN account, stop at the completion link, and send it to
 * someone else: opening it would sign the victim's browser into the
 * attacker's account (login CSRF), and whatever they then typed or uploaded
 * would land there. So each code is minted with a `binding`, a random value
 * the callback also writes into a short-lived cookie on the browser it is
 * talking to, the one that passed the state check. The web app's completion
 * route reads that cookie and must present the same value with the code.
 */
const TTL_MS = 60_000

interface Entry {
  tokens: SessionTokens
  binding: string
  expiresAt: number
}

const store = new Map<string, Entry>()

function sweep(): void {
  const now = Date.now()
  for (const [code, entry] of store) {
    if (entry.expiresAt <= now) store.delete(code)
  }
}

/** How long the binding cookie lives: the code's own TTL, so both go together. */
export const HANDOFF_TTL_MS = TTL_MS

/**
 * Mints a one-time code for these tokens, valid for TTL_MS, and the binding
 * the browser must hold to redeem it (put it in that browser's cookie).
 */
export function createHandoff(tokens: SessionTokens): { code: string; binding: string } {
  sweep()
  const code = randomBytes(32).toString('base64url')
  const binding = randomBytes(32).toString('base64url')
  store.set(code, { tokens, binding, expiresAt: Date.now() + TTL_MS })
  return { code, binding }
}

function sameBinding(expected: string, given: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Redeems a code — single-use, so it is deleted the moment it is read,
 * whether or not it turns out to be valid. Returns `null` for an unknown,
 * already-used, or expired code, or one presented without its binding.
 */
export function consumeHandoff(code: string, binding: string | undefined): SessionTokens | null {
  const entry = store.get(code)
  store.delete(code)
  if (!entry || entry.expiresAt <= Date.now()) return null
  if (!binding || !sameBinding(entry.binding, binding)) return null
  return entry.tokens
}
