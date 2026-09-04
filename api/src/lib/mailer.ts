import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import type { MessageHeader } from '@aws-sdk/client-sesv2'
import { env } from '../config/env.js'
import { logger } from './logger.js'
import { renderEmail } from './email/layout.js'

/**
 * Transactional email — the transport.
 *
 * SCOPE NOTE: this module used to say email automation was out of scope and
 * that it covered only what authentication cannot work without. That is no
 * longer true: platform notifications go out as mail as well, via
 * `lib/email/dispatch.ts`. This file stayed a thin transport — one `sendMail`,
 * no policy — and the fan-out, the recipient rules and the per-event copy live
 * next door under `lib/email/`.
 *
 * ── AMAZON SES, OVER IAM, AND NOTHING ELSE
 *
 * There is no SMTP path and no mail library. The platform already runs on AWS
 * and already authenticates to S3 with IAM, so mail uses the same credential
 * chain: explicit keys when the environment carries them, otherwise the EC2
 * instance role. On a properly provisioned box that means there is no mail
 * credential stored anywhere — nothing in a `.env` file to leak, and nothing
 * to rotate by hand, which is exactly the failure mode a long-lived SMTP
 * username and password invites.
 *
 * SES composes the MIME itself from the parts below. `Charset: 'UTF-8'` on
 * each part is what allows a non-ASCII subject or body — an accented project
 * title, a true minus sign — to arrive intact; SES applies the RFC 2047
 * encoding a raw message would otherwise have to carry.
 *
 * MAIL_DRIVER=console logs the message instead of sending, so development and
 * demos need no AWS access at all.
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

let client: SESv2Client | null = null

/**
 * The SES client, built the same way `lib/storage.ts` builds the S3 one.
 *
 * Omitting `credentials` is not an oversight — it is the point. The SDK then
 * walks its default chain and, on EC2, finds the instance role, so the box
 * sends mail with an identity AWS rotates and nobody writes down. Explicit
 * keys are honoured when present, for running against SES from a laptop.
 *
 * `SES_REGION` is separate from `AWS_REGION` because SES identities, sandbox
 * status and sending quotas are all per region, and there is no reason the
 * bucket and the mail domain have to live in the same one.
 */
function getClient(): SESv2Client {
  client ??= new SESv2Client({
    region: env.SES_REGION ?? env.AWS_REGION,
    ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  })
  return client
}

/**
 * `List-Unsubscribe` wants a URL that answers a POST with no session — the
 * mail client presses it on the recipient's behalf and never shows them a
 * page. That is a Route Handler in the web app, which relays to the API; the
 * human-facing link in the email footer points at the page instead, so
 * clicking it explains what happened.
 */
function unsubscribeHeaders(token: string): MessageHeader[] {
  const url = `${env.WEB_PUBLIC_URL}/api/email/unsubscribe?token=${encodeURIComponent(token)}`
  return [
    { Name: 'List-Unsubscribe', Value: `<${url}>` },
    { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
  ]
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
    await getClient().send(
      new SendEmailCommand({
        /**
         * The envelope sender SES checks the sending identity against. An
         * address on an unverified domain fails here, by name, rather than
         * somewhere less obvious later.
         */
        FromEmailAddress: env.MAIL_FROM,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: message.text, Charset: 'UTF-8' },
              ...(message.html ? { Html: { Data: message.html, Charset: 'UTF-8' } } : {}),
            },
            ...(message.unsubscribeToken
              ? { Headers: unsubscribeHeaders(message.unsubscribeToken) }
              : {}),
          },
        },
        /**
         * Optional, and worth setting: without a configuration set, a hard
         * bounce or a complaint is invisible here and shows up only as a
         * falling reputation score in the SES console.
         */
        ...(env.SES_CONFIGURATION_SET ? { ConfigurationSetName: env.SES_CONFIGURATION_SET } : {}),
      }),
    )
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
