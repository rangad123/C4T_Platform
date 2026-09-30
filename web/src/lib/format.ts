/**
 * Display formatters for server-rendered data.
 *
 * These live in a Server Component scope — most of them are small enough that
 * adding a date library would be the bigger cost. The only format that's worth
 * pulling in a library for is `format.amount(...)`, and that gets a BigInt-aware
 * helper so we never round-trip through `Number`.
 */

/*
 * These formatters run inside Server Components — on the Node.js process,
 * not the reader's browser. Without an explicit `timeZone`, `Intl` falls
 * back to the SERVER's own zone (UTC in production), not India's, so every
 * date and time rendered here was off by a fixed 5:30. See `todayInIndia` in
 * `api/src/lib/hrms/hr-calendar.ts` for the same fix applied server-side.
 */
const date = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
})

const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
})

export const format = {
  /** "12 Aug 2026" — used for date-only fields. */
  date(iso: string): string {
    return date.format(new Date(iso))
  },
  /** "12 Aug 2026, 14:35" — used where the time matters. */
  dateTime(iso: string): string {
    return dateTime.format(new Date(iso))
  },
}
