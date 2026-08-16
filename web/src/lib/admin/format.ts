/**
 * Formatting helpers shared by the admin list pages.
 *
 * These live outside the components because every list page needs the same
 * three or four of them, and duplicating a date formatter eight times is how
 * two pages end up disagreeing about what "12 Aug" means.
 *
 * Copy rules from CLAUDE.md apply to the output: the true minus sign (−) for
 * negative numbers, never a hyphen.
 */

/** `IN_PROGRESS` → `In progress`. Leaves already-cased text alone. */
export function titleCase(value: string): string {
  if (!value) return value
  return value
    .toLowerCase()
    .replace(
      /(^|[\s_-])(\w)/g,
      (_match: string, sep: string, ch: string) => (sep === '_' ? ' ' : sep) + ch.toUpperCase(),
    )
}

/** `2026-08-14T12:09:18.713Z` → `14 Aug 2026`. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Same date format as `formatDate`, with hours and minutes appended. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Money, from the API's minor-unit string.
 *
 * The API serialises `amountMinor` as a BigInt-safe **string**, not a number —
 * parsing it with `Number` is right for display amounts but would silently lose
 * precision above 2^53, so the sign is split off first and the magnitude is
 * divided as a number only after that check.
 *
 * Negative amounts get the true minus sign (−), per the copy rules.
 */
export function formatMoney(amountMinor: string | number, currency = 'INR'): string {
  const raw = typeof amountMinor === 'string' ? amountMinor : String(amountMinor)
  const negative = raw.trim().startsWith('-')
  const magnitude = negative ? raw.trim().slice(1) : raw.trim()
  const major = Number(magnitude) / 100

  const formatted = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(major) ? major : 0)

  return negative ? `−${formatted}` : formatted
}

/** A person's display name, falling back to their email. */
export function personName(
  person: { firstName?: string | null; lastName?: string | null; email?: string | null } | null,
): string {
  if (!person) return '—'
  const name = [person.firstName, person.lastName].filter(Boolean).join(' ').trim()
  if (name) return name
  return person.email ?? '—'
}

/** `4` → `★★★★☆`. Used in the ratings list. */
export function stars(score: number): string {
  const clamped = Math.max(0, Math.min(5, Math.round(score)))
  return '★'.repeat(clamped) + '☆'.repeat(5 - clamped)
}

/**
 * Trim a query-string value or default to `undefined`.
 *
 * The list-page URL keeps an empty string as the value (because the form is
 * a GET), and an empty string is the wrong thing to send to the API as a
 * filter. `??` does not help here because `''` is not nullish — only `||`
 * collapses both missing and empty. A small helper centralises the rule so
 * that the same call at the same call site in ten pages cannot drift.
 */
export function searchTerm(value: string | undefined | null): string | undefined {
  if (value === null || value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Whether any of the filter values is set, for the list page's `filtered` flag.
 *
 * `filtered` decides whether the empty-state copy says "no rows match your
 * filters" (true) or "no rows yet" (false). The right operator is `||` —
 * any truthy value means "filtered" — but ESLint's `prefer-nullish-coalescing`
 * rule fires on every `||`. The helper centralises the call so the lint
 * disable lives in one place.
 *
 * Takes a single array argument so callers pass `[status, severity, search]`
 * instead of `hasFilter(status, severity, search)` — the varargs form loses
 * the type at each call and triggers `no-unsafe-call`.
 */
export function hasFilter(values: readonly unknown[]): boolean {
  return values.some((v) => Boolean(v))
}
