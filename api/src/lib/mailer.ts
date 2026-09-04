import nodemailer from 'nodemailer'
import { env } from '../config/env.js'
import { logger } from './logger.js'
import { renderEmail } from './email/layout.js'

/**
 * Transactional email — the transport.
 *
 * SCOPE NOTE: this module used to say email automation was out of scope and
 * that it covered only what authentication cannot work without. That is no
 * longer true: platform notifications now go out as mail as well, via
 * `lib/email/dispatch.ts`. This file stayed a thin transport — one `sendMail`,
 * one transport, no policy — and the fan-out, the recipient rules and the
 * per-event copy live next door under `lib/email/`.
 *
 * MAIL_DRIVER=console logs the message instead of sending, so development and
 * demos work with no provider configured at all.
 *
 * The provider is reached over SMTP, which is deliberately boring: SES,
 * Postmark, Mailgun and a plain relay all speak it, so moving between them is
 * a change of `SMTP_*` values and nothing else.
 */

export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
  /**
   * Present on bulk-ish notification mail. Becomes the `List-Unsubscribe`
   * pair, which is what lets Gmail and Outlook show their own "Unsubscribe"
   * control next to the sender — recipients who have that button use it
   * instead of the spam button, and the difference shows up directly in
   * whether the domain keeps landing in inboxes.
   *
   * Absent on account mail (verification, password reset). There is no opting
   * out of being told your password was reset.
   */
  unsubscribeToken?: string
}

let transport: nodemailer.Transporter | null = null

function getTransport(): nodemailer.Transporter {
  transport ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  })
  return transport
}

/**
 * `List-Unsubscribe` wants a URL that answers a POST with no session — the
 * mail client presses it on the recipient's behalf and never shows them a
 * page. That is a Route Handler in the web app, which relays to the API; the
 * human-facing link in the email footer points at the page instead, so
 * clicking it explains what happened.
 */
function unsubscribeHeaders(token: string): Record<string, string> {
  const url = `${env.WEB_PUBLIC_URL}/api/email/unsubscribe?token=${encodeURIComponent(token)}`
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}

export async function sendMail(message: MailMessage): Promise<void> {
  if (env.MAIL_DRIVER === 'console') {
    logger.info(
      { to: message.to, subject: message.subject, body: message.text },
      'Email (console driver — not sent)',
    )
    return
  }

  try {
    await getTransport().sendMail({
      from: env.MAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      ...(message.unsubscribeToken
        ? { headers: unsubscribeHeaders(message.unsubscribeToken) }
        : {}),
    })
  } catch (error) {
    // Never let a mail failure break the request that triggered it. A user who
    // cannot receive a verification email must still get a created account.
    logger.error({ err: error, to: message.to, subject: message.subject }, 'Failed to send email')
  }
}

// ─── Account email ───────────────────────────────────────────────────────────
//
// These three are sent explicitly, at the moment the thing they describe
// happens, and they are the only emails that do NOT come from a notification:
// two of them go to someone who may not have an account yet, and all three are
// account mail nobody may opt out of.
//
// Everything else — invitations to a project, messages, announcements, bug and
// payment updates — is raised as a notification and mailed by
// `lib/email/dispatch.ts`, so the app and the inbox cannot tell different
// stories.

export function verificationEmail(to: string, token: string): MailMessage {
  const url = `${env.WEB_PUBLIC_URL}/verify-email?token=${encodeURIComponent(token)}`
  const { html, text } = renderEmail(
    {
      heading: 'Confirm your email address',
      paragraphs: ['Confirm this address to finish setting up your Crowd4Test account.'],
      action: { label: 'Verify my email', url },
      note: 'This link expires in 24 hours. If you did not create an account, you can ignore this email.',
    },
    {},
  )
  return { to, subject: 'Verify your Crowd4Test email address', text, html }
}

export function passwordResetEmail(to: string, token: string): MailMessage {
  const url = `${env.WEB_PUBLIC_URL}/reset-password?token=${encodeURIComponent(token)}`
  const { html, text } = renderEmail(
    {
      heading: 'Set a new password',
      paragraphs: ['Use the button below to choose a new password for your Crowd4Test account.'],
      action: { label: 'Set a new password', url },
      note: 'The link expires in 60 minutes. If you did not request a reset, you can ignore this email — your password will not change.',
    },
    {},
  )
  return { to, subject: 'Reset your Crowd4Test password', text, html }
}

/**
 * §42 — an invitation to join an organisation's team.
 *
 * Sent directly rather than through a notification because the recipient is an
 * email address, not necessarily a user: the whole point is that they may have
 * no account yet, and there is no row to notify.
 *
 * The inviter's own note is passed through as a quote. `renderEmail` escapes
 * it, so markup in a note is shown rather than rendered.
 */
export function teamInvitationEmail(
  to: string,
  token: string,
  organisationName: string,
  invitedByName: string,
  message?: string | null,
): MailMessage {
  const url = `${env.WEB_PUBLIC_URL}/invitations/${encodeURIComponent(token)}`
  /* Length-tested rather than `??`: a note of "   " trims to "", which is not
     nullish and would otherwise render an empty quote block. */
  const trimmed = message?.trim()
  const note = trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
  const { html, text } = renderEmail(
    {
      heading: `Join ${organisationName} on Crowd4Test`,
      paragraphs: [
        `${invitedByName} invited you to join ${organisationName} on Crowd4Test.`,
        ...(note ? [`${invitedByName} wrote:`] : []),
      ],
      quote: note,
      action: { label: 'Accept the invitation', url },
      note: 'The link expires in 14 days. If you were not expecting this, you can ignore it.',
    },
    {},
  )
  return {
    to,
    subject: `${invitedByName} invited you to join ${organisationName} on Crowd4Test`,
    text,
    html,
  }
}
