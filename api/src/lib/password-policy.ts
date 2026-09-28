import { z } from 'zod'

/**
 * The one rule for every NEW password this platform accepts — registration,
 * password reset, change-password, an admin creating an account, and an
 * admin force-setting one. Never used for a LOGIN check, which must accept
 * whatever a password was originally set to, however weak.
 *
 * ── What this replaces
 *
 * The rule used to be length-only: 12–200 characters plus a small blocklist,
 * on the reasoning that length beats composition for real-world resistance —
 * a real, NIST-aligned position. It also meant "aaaaaaaaaaaa" and
 * "123456789012" both passed. The platform now requires real composition on
 * top of length, so every character class below is individually mandatory —
 * not "3 of 4" — because that maps directly onto a checklist in the UI where
 * every row must be checked, which is a clearer promise to the person filling
 * it in than a rule with partial credit.
 *
 * Previously duplicated near-identically across four schema files (this one
 * included two other places, plus a completely separate copy for HRMS that
 * was missing the blocklist entirely). One rule now, imported everywhere.
 */
export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 200

const COMMON_PASSWORDS = ['password', '123456789012', 'qwertyuiop12']

export const passwordField = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine((v) => /[a-z]/.test(v), 'Include a lowercase letter')
  .refine((v) => /[A-Z]/.test(v), 'Include an uppercase letter')
  .refine((v) => /[0-9]/.test(v), 'Include a number')
  .refine((v) => /[^a-zA-Z0-9]/.test(v), 'Include a symbol')
  .refine((v) => !COMMON_PASSWORDS.includes(v.toLowerCase()), 'That password is too common')
