import { z } from 'zod'

/**
 * The one rule for every phone number this platform stores.
 *
 * ── The bug this exists to stop
 *
 * The four schemas that accept a phone number — self-registration, admin
 * user create, user update, and an organisation's contact details — all said
 * `z.string().trim().max(32)` and nothing else. That is a length limit, not a
 * phone rule: "8899889988999999999999999999999" and "aaaa" were both accepted
 * and written to the database. A support agent later dialling that column has
 * no way to tell a typo from a real number.
 *
 * ── The rule
 *
 * Optional leading `+`, then digits, with the separators people actually type
 * between them (spaces, hyphens, parentheses). Between {@link MIN_DIGITS} and
 * {@link MAX_DIGITS} digits once the separators are discounted.
 *
 * `MAX_DIGITS` is 15 because E.164 caps a country code plus subscriber number
 * there — no real number is longer. `MIN_DIGITS` is 7 because the shortest
 * national numbers still in service are 7 digits, and rejecting those would
 * break a legitimate signup to catch nothing.
 *
 * Deliberately NOT a per-country check. Validating an Indian mobile against
 * Indian rules needs a country to validate against, and this field is filled in
 * before `countryCode` on three of the four forms. A shape-and-length rule
 * rejects everything the screenshot showed while staying correct for every
 * country the platform recruits testers in.
 */
const MIN_DIGITS = 7
const MAX_DIGITS = 15

/** Long enough for "+000 (000) 000-0000" and its variants, short enough to bound. */
export const PHONE_MAX_LENGTH = 24

/** Shape only — the digit count is a separate check so each gets its own message. */
const PHONE_SHAPE = /^\+?[0-9][0-9\s().-]*$/

function digitCount(value: string): number {
  return (value.match(/[0-9]/g) ?? []).length
}

/**
 * A phone number, or `''`.
 *
 * The empty string is how the organisation and profile forms say "clear this",
 * so it has to survive validation — the same accommodation `website` already
 * makes in the organisation schema. Call sites add `.optional()` themselves,
 * matching the fields beside them.
 */
export const phoneField = z
  .string()
  .trim()
  .max(PHONE_MAX_LENGTH, `Use at most ${PHONE_MAX_LENGTH} characters.`)
  .refine((value) => value === '' || PHONE_SHAPE.test(value), {
    message: 'Use digits, optionally with a leading + and spaces, hyphens or parentheses.',
  })
  .refine((value) => value === '' || digitCount(value) >= MIN_DIGITS, {
    message: `A phone number needs at least ${MIN_DIGITS} digits.`,
  })
  .refine((value) => value === '' || digitCount(value) <= MAX_DIGITS, {
    message: `A phone number has at most ${MAX_DIGITS} digits.`,
  })
