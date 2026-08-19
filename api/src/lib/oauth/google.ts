import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createPublicKey, createVerify } from 'node:crypto'
import { env } from '../../config/env.js'
import { UnauthorizedError } from '../errors.js'

/**
 * Google OAuth 2.0, authorization-code flow.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THE CODE FLOW AND NOT GOOGLE IDENTITY SERVICES
 *
 * GIS hands the browser an ID token to POST at the API, which is fewer moving
 * parts. It also puts a bearer credential in page JavaScript, where an XSS on
 * the marketing site could lift it. The code flow keeps every token exchange
 * server-side: the browser only ever carries an opaque `code` that is useless
 * without the client secret, and the session cookies this API already issues
 * remain the only client-side credential.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * NO GOOGLE SDK
 *
 * `google-auth-library` pulls a large dependency tree to do three things this
 * file does in ~150 lines: build a URL, POST a form, and check a signature.
 * Everything below is Node's own crypto and fetch.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs'
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

/** Identity as Google asserts it, after the ID token has been verified. */
export interface GoogleIdentity {
  /** The `sub` claim — stable per Google account, and the only safe join key. */
  subject: string
  email: string
  /** Google's own verification of the address. False means do NOT trust it. */
  emailVerified: boolean
  firstName?: string
  lastName?: string
}

/* ─── State: CSRF protection across the redirect ─────────────────────────── */

/**
 * The `state` parameter, signed rather than stored.
 *
 * OAuth needs state to survive a round trip through Google and come back
 * provably unmodified, or an attacker can feed a victim's browser their own
 * authorization code and silently link accounts. The usual fix is a server-side
 * store keyed by a nonce; this signs the value with the JWT private key instead,
 * so the API stays stateless and a restart mid-sign-in does not strand anyone.
 *
 * The payload carries a random nonce, an issue time, and the post-login
 * redirect. The nonce is what the caller also drops in a short-lived cookie —
 * the two are compared on return, so possessing a valid signature is not enough
 * without the browser that started the flow.
 */
const STATE_TTL_MS = 10 * 60 * 1000

interface StatePayload {
  nonce: string
  issuedAt: number
  next?: string
  /**
   * 'login' means the visitor clicked "Continue with Google" expecting to
   * reach an EXISTING account — the callback must not silently register a
   * new one for an unrecognised identity. 'register' (the default, for
   * backward compatibility with any caller that omits it) keeps today's
   * behaviour: sign in if the identity is known, create an account if not.
   */
  intent?: 'login' | 'register'
}

function stateSecret(): Buffer {
  // Derived from the JWT private key rather than adding another secret to
  // configure. Rotating the key pair invalidates in-flight sign-ins, which is
  // acceptable — they are ten minutes long.
  return createHmac('sha256', 'oauth-state').update(env.JWT_PRIVATE_KEY).digest()
}

export function createState(
  next?: string,
  intent?: 'login' | 'register',
): { state: string; nonce: string } {
  const nonce = randomBytes(24).toString('base64url')
  const payload: StatePayload = {
    nonce,
    issuedAt: Date.now(),
    ...(next ? { next } : {}),
    ...(intent ? { intent } : {}),
  }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', stateSecret()).update(body).digest('base64url')
  return { state: `${body}.${signature}`, nonce }
}

/**
 * Verifies the returned state and its cookie nonce. Throws on any mismatch —
 * a failure here is an attack or a badly stale tab, and both should restart.
 */
export function verifyState(state: string, cookieNonce: string | undefined): StatePayload {
  const [body, signature] = state.split('.')
  if (!body || !signature) throw new UnauthorizedError('Malformed sign-in state')

  const expected = createHmac('sha256', stateSecret()).update(body).digest('base64url')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new UnauthorizedError('Sign-in state failed verification')
  }

  let payload: StatePayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload
  } catch {
    throw new UnauthorizedError('Malformed sign-in state')
  }

  if (Date.now() - payload.issuedAt > STATE_TTL_MS) {
    throw new UnauthorizedError('This sign-in took too long. Please try again.')
  }
  // The signature proves WE minted the state. The nonce proves it came back in
  // the same browser it was issued to.
  if (!cookieNonce || cookieNonce !== payload.nonce) {
    throw new UnauthorizedError('Sign-in could not be verified. Please try again.')
  }
  return payload
}

/* ─── Step 1: send the user to Google ────────────────────────────────────── */

export function buildAuthorizationUrl(state: string): string {
  const url = new URL(AUTH_ENDPOINT)
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID!)
  url.searchParams.set('redirect_uri', env.GOOGLE_REDIRECT_URI!)
  url.searchParams.set('response_type', 'code')
  // `openid email profile` is the minimum that yields a verified address and a
  // display name. Nothing here needs Gmail, Drive or contacts scopes, and
  // asking for them would trigger Google's verification review.
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', state)
  // Ask for a fresh consent screen only when we have no refresh token; we never
  // call Google APIs on the user's behalf, so offline access is not requested.
  url.searchParams.set('access_type', 'online')
  // Lets the user pick when several Google accounts are signed in, instead of
  // silently reusing whichever is first.
  url.searchParams.set('prompt', 'select_account')
  return url.toString()
}

/* ─── Step 2: exchange the code, verify the ID token ─────────────────────── */

interface TokenResponse {
  id_token?: string
  error?: string
  error_description?: string
}

export async function exchangeCodeForIdentity(code: string): Promise<GoogleIdentity> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: env.GOOGLE_REDIRECT_URI!,
      grant_type: 'authorization_code',
    }),
  })

  const body = (await response.json()) as TokenResponse
  if (!response.ok || !body.id_token) {
    // Google's error text is safe to log but not to show — it leaks client
    // configuration detail to whoever triggered the callback.
    throw new UnauthorizedError('Google sign-in failed. Please try again.')
  }

  return verifyIdToken(body.id_token)
}

/* ─── ID token verification ──────────────────────────────────────────────── */

interface GoogleJwk {
  kid: string
  n: string
  e: string
  alg?: string
  kty?: string
}

/**
 * Google's signing keys, cached in memory.
 *
 * They rotate roughly daily, so this refetches when a token names a `kid` the
 * cache does not hold, and otherwise honours the cache window. A restart empties
 * it, which costs one extra request.
 */
let jwksCache: { keys: GoogleJwk[]; fetchedAt: number } | null = null
const JWKS_TTL_MS = 60 * 60 * 1000

async function getSigningKey(kid: string): Promise<GoogleJwk> {
  const fresh = jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS
  if (fresh) {
    const hit = jwksCache!.keys.find((k) => k.kid === kid)
    if (hit) return hit
  }

  const response = await fetch(JWKS_URI)
  if (!response.ok) throw new UnauthorizedError('Could not verify Google sign-in')
  const body = (await response.json()) as { keys: GoogleJwk[] }
  jwksCache = { keys: body.keys, fetchedAt: Date.now() }

  const key = body.keys.find((k) => k.kid === kid)
  if (!key) throw new UnauthorizedError('Could not verify Google sign-in')
  return key
}

interface IdTokenClaims {
  iss: string
  aud: string
  sub: string
  exp: number
  email?: string
  email_verified?: boolean | string
  given_name?: string
  family_name?: string
}

/**
 * Verifies signature, issuer, audience and expiry on a Google ID token.
 *
 * EVERY ONE OF THOSE MATTERS. A valid signature alone only proves Google minted
 * the token — not that it was minted for THIS application. Skipping the `aud`
 * check is the classic OAuth hole: a token issued to any other Google client
 * would then authenticate its bearer here as the user it describes.
 */
export async function verifyIdToken(idToken: string): Promise<GoogleIdentity> {
  const [headerPart, payloadPart, signaturePart] = idToken.split('.')
  if (!headerPart || !payloadPart || !signaturePart) {
    throw new UnauthorizedError('Malformed Google token')
  }

  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as {
    kid?: string
    alg?: string
  }
  // Pin the algorithm. Without this, a token with alg:"none" — or a symmetric
  // algorithm keyed on the public material — can be forged.
  if (header.alg !== 'RS256' || !header.kid) {
    throw new UnauthorizedError('Unsupported Google token algorithm')
  }

  const jwk = await getSigningKey(header.kid)
  const publicKey = createPublicKey({ key: { ...jwk, kty: 'RSA' }, format: 'jwk' })

  const verifier = createVerify('RSA-SHA256')
  verifier.update(`${headerPart}.${payloadPart}`)
  verifier.end()
  if (!verifier.verify(publicKey, Buffer.from(signaturePart, 'base64url'))) {
    throw new UnauthorizedError('Google token signature failed verification')
  }

  const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as IdTokenClaims

  if (!ISSUERS.includes(claims.iss)) throw new UnauthorizedError('Unexpected Google token issuer')
  if (claims.aud !== env.GOOGLE_CLIENT_ID) {
    throw new UnauthorizedError('Google token was issued for another application')
  }
  if (claims.exp * 1000 <= Date.now()) throw new UnauthorizedError('Google token has expired')
  if (!claims.email) throw new UnauthorizedError('Google did not return an email address')

  return {
    subject: claims.sub,
    email: claims.email.trim().toLowerCase(),
    // Google sends this as a boolean or the string "true" depending on the
    // endpoint; normalise both.
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    ...(claims.given_name ? { firstName: claims.given_name } : {}),
    ...(claims.family_name ? { lastName: claims.family_name } : {}),
  }
}
