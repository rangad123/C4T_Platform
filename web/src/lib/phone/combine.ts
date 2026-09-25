import { dialCodeOptions } from '@/lib/geo/source'
import { formTrimmed } from '@/lib/form-data'

/**
 * Assembling and disassembling the one phone string every schema and Server
 * Action already expects, from the two visible fields `PhoneNumberField`
 * renders.
 *
 * Deliberately NOT `server-only`: unlike `geo/source.ts`, nothing here pulls
 * in place data, so there is nothing that would bloat a client bundle if this
 * were ever imported from one.
 */

export interface SplitPhone {
  dialCode: string
  number: string
}

/**
 * A stored value like "+91 9876543210" back into its two parts, for
 * pre-filling an edit form.
 *
 * Matched against the KNOWN dial-code set, longest first — `+1684` (American
 * Samoa) must not be mis-split against the shorter, unrelated `+1` (US/CA/…)
 * before its own, more specific code gets a chance. A value with no leading
 * `+`, or one that matches no known code at all, is legacy or hand-typed:
 * the whole thing becomes `number` and `dialCode` stays empty — nothing is
 * ever silently dropped, same as `withCurrent` in `geo/source.ts`.
 */
export function splitStoredPhone(stored: string | null | undefined): SplitPhone {
  const value = (stored ?? '').trim()
  if (!value.startsWith('+')) return { dialCode: '', number: value }

  const digits = value.slice(1)
  const codes = [...new Set(dialCodeOptions().map((o) => o.value))].sort(
    (a, b) => b.length - a.length,
  )
  const match = codes.find((code) => digits.startsWith(code))
  if (!match) return { dialCode: '', number: value }

  return { dialCode: match, number: digits.slice(match.length).trim() }
}

/** `''` when `number` is blank — preserves "empty clears the field" everywhere that reads it. */
export function combinePhone(dialCode: string, number: string): string {
  const trimmedNumber = number.trim()
  if (!trimmedNumber) return ''
  return dialCode ? `+${dialCode} ${trimmedNumber}` : trimmedNumber
}

/** Reads `${name}DialCode` + `${name}Number` and combines them — the one-line replacement for `formTrimmed(formData, name)`. */
export function combinePhoneFromForm(formData: FormData, name = 'phone'): string {
  return combinePhone(
    formTrimmed(formData, `${name}DialCode`),
    formTrimmed(formData, `${name}Number`),
  )
}
