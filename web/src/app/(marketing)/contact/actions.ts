'use server'

import { z } from 'zod'
import { env } from '@/lib/env'

/**
 * The demo-request server action.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY A SERVER ACTION AND NOT A FETCH FROM THE BROWSER
 *
 * The form posts to this function, which runs on the Next server and then calls
 * the Express API. Three reasons that ordering matters:
 *
 *  1. It works without JavaScript. React posts the form natively when the bundle
 *     has not loaded, so a lead is never lost to a slow connection — which on a
 *     site selling reliability is the point.
 *  2. Validation happens somewhere the submitter cannot edit. Client-side checks
 *     are a courtesy to the user; these are the real ones.
 *  3. No API credentials or internal hostname reach the browser.
 *
 * WHAT `delivered` MEANS. `true` when the API accepted the lead. `false` when it
 * did not and the enquiry was written to the server log for manual recovery
 * instead — see the catch block. The visitor is shown success in both cases,
 * because from their side it is: we have their request. Anything downstream that
 * cares about durability should read the flag, not the status.
 * ──────────────────────────────────────────────────────────────────────────
 */

/**
 * Server-side shape. Deliberately stricter than the browser's `required`
 * attributes, which are trivially removed with devtools.
 *
 * `honeypot` must be empty. It is a hidden field no human fills in; bots that
 * complete every input trip it. Cheap, and it needs no third-party script or
 * consent banner entry, unlike a CAPTCHA.
 */
const LeadSchema = z.object({
  firstName: z.string().trim().min(1, 'Enter your first name').max(80),
  lastName: z.string().trim().min(1, 'Enter your last name').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid work email').max(200),
  /**
   * Optional, and validated by shape rather than by country — the same rule
   * `api/src/lib/phone.ts` applies on arrival, restated here only so the
   * message names the field instead of coming back as a generic 422.
   */
  phone: z
    .string()
    .trim()
    .max(24, 'Use at most 24 characters')
    .refine((v) => v === '' || /^\+?[0-9][0-9\s().-]*$/.test(v), 'Enter a phone number')
    .refine((v) => {
      const digits = (v.match(/[0-9]/g) ?? []).length
      return v === '' || (digits >= 7 && digits <= 15)
    }, 'A phone number needs between 7 and 15 digits')
    .optional(),
  company: z.string().trim().min(1, 'Enter your company').max(160),
  size: z.string().trim().max(40).optional(),
  message: z.string().trim().max(4000).optional(),
  // An unchecked box submits nothing at all, so absence means "no".
  consent: z.literal('on').optional(),
  honeypot: z.string().max(0),
})

export interface LeadState {
  status: 'idle' | 'success' | 'error'
  /** Field name → first message. Rendered next to the input. */
  errors?: Record<string, string>
  /** Non-field error, e.g. the API being unreachable. */
  message?: string
  /** True when the API accepted the lead; false when it was logged for manual recovery. */
  delivered?: boolean
}

export async function submitLead(_prev: LeadState, formData: FormData): Promise<LeadState> {
  const parsed = LeadSchema.safeParse(Object.fromEntries(formData))

  if (!parsed.success) {
    const errors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '_')
      // First message per field only — a list of three complaints about one
      // input is noise.
      errors[key] ??= issue.message
    }

    // A tripped honeypot is a bot, not a user who made a mistake. Return the
    // generic success shape rather than telling the bot what it got wrong.
    if (errors.honeypot) {
      return { status: 'success', delivered: false }
    }

    return { status: 'error', errors, message: 'Check the highlighted fields.' }
  }

  const lead = parsed.data

  try {
    const response = await fetch(new URL('/v1/leads', env.API_ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        firstName: lead.firstName,
        lastName: lead.lastName,
        email: lead.email,
        phone: lead.phone === '' ? undefined : lead.phone,
        company: lead.company,
        teamSize: lead.size,
        message: lead.message,
        // The checkbox submits the string "on" or nothing at all; the API wants
        // a boolean, and consent is the one field where "absent" must mean "no"
        // rather than "unknown".
        marketingConsent: lead.consent === 'on',
        sourcePath: '/contact',
      }),
      // A visitor should not watch a spinner because the API is wedged. Ten
      // seconds is generous for a single insert and short enough that the
      // fallback below runs while they are still on the page.
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      // 429 is the API's own rate limit — a real person who submitted twice, not
      // an outage. Say so, rather than showing the generic failure.
      if (response.status === 429) {
        return {
          status: 'error',
          message: "We already have your request — we'll be in touch shortly.",
        }
      }
      throw new Error(`Lead API responded ${response.status}`)
    }

    return { status: 'success', delivered: true }
  } catch (cause) {
    /**
     * ──────────────────────────────────────────────────────────────────────
     * THE LEAD IS NOT LOST WHEN THE API IS DOWN.
     *
     * The visitor filled in a form and pressed a button; an outage on our side
     * is not their problem, and telling them to try later mostly means they do
     * not. So the enquiry is written to the server log in a form that can be
     * replayed by hand, and they are shown success — which is true from their
     * side: we have their request.
     *
     * `delivered: false` is the honest flag for anything downstream.
     *
     * The message body is deliberately NOT logged: it is customer prose that may
     * name unreleased products, and that does not belong in a log aggregator.
     * Everything needed to contact them is here; the detail can be asked for.
     * ──────────────────────────────────────────────────────────────────────
     */
    console.error('[lead] API unreachable — capture by hand from this line', {
      firstName: lead.firstName,
      lastName: lead.lastName,
      email: lead.email,
      company: lead.company,
      teamSize: lead.size,
      marketingConsent: lead.consent === 'on',
      hasMessage: Boolean(lead.message),
      receivedAt: new Date().toISOString(),
      cause: cause instanceof Error ? cause.message : String(cause),
    })

    return { status: 'success', delivered: false }
  }
}
