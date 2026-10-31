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

/** Any origin works: only whether `next` keeps it matters. */
const PROBE_ORIGIN = 'https://c4t.invalid'

/**
 * True when `path` is a path on this site and nothing a browser could read as
 * another host. Rejects:
 *   "https://evil.com"   — full URL
 *   "//evil.com"         — protocol-relative
 *   "/\\evil.com"        — browsers read a backslash as a slash
 *   "/<TAB>/evil.com"    — browsers strip tabs and newlines from a URL, which
 *                          leaves "//evil.com"; so any control character or
 *                          space (below 0x21, and DEL) is refused
 *   "javascript:…"       — scheme-prefixed
 * and, as a last check, anything that resolves to another origin.
 */
export function isSameOriginPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return false
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i)
    if (code < 0x21 || code === 0x7f) return false
  }
  try {
    return new URL(path, PROBE_ORIGIN).origin === PROBE_ORIGIN
  } catch {
    return false
  }
}

/** Returns a same-origin path from `next`, or `null` if `next` is unsafe. */
export function safeNext(next: string | null | undefined): string | null {
  if (!next) return null

  if (!isSameOriginPath(next)) return null

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
