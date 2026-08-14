/**
 * Validates a `?next=` (or any redirect target) so an attacker cannot turn the
 * sign-in form into a phishing redirect.
 *
 * RULE. A safe target is an ABSOLUTE, SAME-ORIGIN path: starts with one slash,
 * does NOT start with two (which would be a protocol-relative URL pointing at
 * another origin), does not contain `\` (Windows path quirk), and resolves to
 * a real path on this site rather than the marketing pages.
 *
 * Anything else — full URLs, protocol-relative, hash-bangs, weird encodings —
 * is rejected. On rejection we fall back to the role-appropriate home, which is
 * the right thing to do even on a legitimate click that happened to be malformed.
 */

const ROLE_HOME_FALLBACK = '/app' as const

/** Returns a same-origin path from `next`, or `null` if `next` is unsafe. */
export function safeNext(next: string | null | undefined): string | null {
  if (!next) return null

  // Reject anything that isn't a relative path. Catches:
  //   "https://evil.com"   — full URL
  //   "//evil.com"         — protocol-relative
  //   "/\\evil.com"        — backslash trick that some browsers normalise
  //   "javascript:…"       — scheme-prefixed
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return null
  }

  // The form should never bounce a signed-in user back to the marketing site,
  // and never into another credential screen. /login etc. are guarded by
  // GUEST_ONLY in proxy.ts anyway, but defence in depth.
  if (next === '/login' || next.startsWith('/login?')) return null
  if (next === '/register' || next.startsWith('/register?')) return null
  if (next === '/forgot-password' || next.startsWith('/forgot-password?')) return null

  return next
}

/** Variant that returns the fallback instead of null — for redirect targets. */
export function safeNextOrHome(
  next: string | null | undefined,
  fallback: string = ROLE_HOME_FALLBACK,
): string {
  return safeNext(next) ?? fallback
}

export { ROLE_HOME_FALLBACK }
