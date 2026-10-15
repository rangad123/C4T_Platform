/**
 * A web address that is safe to put in an `href`, or null.
 *
 * Text a tester typed ends up as a link on pages other people open — an
 * admin's, a customer's. A URL with any other scheme (`javascript:`, `data:`)
 * would run when clicked, and React does not stop it. The API now refuses to
 * store one, but rows written before that, and anything else that reaches a
 * page, still go through here.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  const text = value?.trim()
  if (!text) return null
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/** `drive.google.com` from a full link — enough to tell the reader where it leads. */
export function linkHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '')
  } catch {
    return value
  }
}
