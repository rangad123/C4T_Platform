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
