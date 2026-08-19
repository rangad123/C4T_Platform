import rateLimit from 'express-rate-limit'
import { env } from '../config/env.js'

const shared = {
  standardHeaders: 'draft-7' as const,
  legacyHeaders: false,
  message: {
    error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please try again shortly.' },
  },
}

/** Broad limit applied to the whole API. */
export const globalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  ...shared,
})

/**
 * Per-IP ceiling on credential attempts, applied FIRST on the auth routes.
 *
 * Without this, an attacker holding a single valid (email, password) pair from
 * a breach could fire `${RATE_LIMIT_MAX}` successful logins per window from one
 * IP with no consequence — the per-account limit further down is the right
 * control for "wrong password against one account" but is irrelevant when the
 * attempts succeed.
 *
 * Capping at the same value as the per-account limit keeps a single host within
 * the same budget whether the attacker is targeting one account or many.
 */
export const authIpLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_RATE_LIMIT_MAX,
  keyGenerator: (req) => req.ip ?? 'unknown',
  ...shared,
})

/**
 * Tight limit for credential endpoints, keyed on IP + email. Applied AFTER
 * the per-IP limit so a single host cannot blanket the same address from
 * many emails and burn the victim's account.
 *
 * Failures and successes both count. The previous `skipSuccessfulRequests:
 * true` left a brute-force surface against stolen credentials — a successful
 * login was free as long as the email-and-IP pair was within budget.
 */
export const authLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_RATE_LIMIT_MAX,
  keyGenerator: (req) => {
    // req.body is `any`; narrow it explicitly rather than trusting the shape.
    const body: unknown = req.body
    const email =
      typeof body === 'object' && body !== null && 'email' in body && typeof body.email === 'string'
        ? body.email.toLowerCase()
        : ''
    return `${req.ip ?? 'unknown'}:${email}`
  },
  ...shared,
})

/** Uploads are expensive; presign requests get their own budget. */
export const uploadLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  ...shared,
})

/**
 * The bank-details reveal endpoint requires the caller's own password, so it
 * is exactly the kind of thing a stolen session token would try to brute-
 * force. Keyed on the caller's user id (the route sits behind `authenticate`,
 * so `req.user` is always set) rather than IP — the threat here is one
 * compromised admin session guessing its own owner's password, which an IP
 * key would not usefully constrain any tighter than this already does.
 */
export const paymentRevealLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'unknown',
  ...shared,
})

/**
 * The public lead form.
 *
 * ⚠ THIS IS THE ONLY UNAUTHENTICATED WRITE ON THE API, so it is the only one an
 * anonymous attacker can use to create rows. `globalLimiter` allows 300 requests
 * per window across the whole API, which is far too generous for a form a human
 * submits once.
 *
 * Five per hour per IP is roughly "a genuine visitor who mistyped their email a
 * few times" and nowhere near enough to be worth scripting. `skipFailedRequests`
 * is deliberately NOT set: a validation failure still costs a database round trip
 * and is exactly what a probing script generates.
 */
export const leadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  ...shared,
})
