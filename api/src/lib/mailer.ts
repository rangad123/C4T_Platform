import nodemailer from 'nodemailer'
import { env } from '../config/env.js'
import { logger } from './logger.js'

/**
 * Transactional email.
 *
 * SCOPE NOTE: Service Agreement §5 excludes "email automation integrations"
 * unless separately scoped. This module deliberately stays a thin transport
 * abstraction covering only what authentication cannot work without — email
 * verification and password reset. Choosing and paying for a provider (SES,
 * Postmark, etc.) is a Client decision under §4 (third-party costs).
 *
 * MAIL_DRIVER=console logs the message instead of sending, so development and
 * demos work with no provider configured at all.
 */

export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
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
    })
  } catch (error) {
    // Never let a mail failure break the request that triggered it. A user who
    // cannot receive a verification email must still get a created account.
    logger.error({ err: error, to: message.to, subject: message.subject }, 'Failed to send email')
  }
}

// ─── Templates ───────────────────────────────────────────────────────────────

export function verificationEmail(to: string, token: string): MailMessage {
  const url = `${env.WEB_PUBLIC_URL}/verify-email?token=${encodeURIComponent(token)}`
  return {
    to,
    subject: 'Verify your Crowd4Test email address',
    text: `Confirm your email address to finish setting up your Crowd4Test account:\n\n${url}\n\nThis link expires in 24 hours. If you did not create an account, ignore this email.`,
  }
}

export function passwordResetEmail(to: string, token: string): MailMessage {
  const url = `${env.WEB_PUBLIC_URL}/reset-password?token=${encodeURIComponent(token)}`
  return {
    to,
    subject: 'Reset your Crowd4Test password',
    text: `Use this link to set a new password:\n\n${url}\n\nThe link expires in 60 minutes. If you did not request a reset, you can ignore this email — your password will not change.`,
  }
}

export function projectAssignedEmail(
  to: string,
  projectTitle: string,
  projectId: string,
): MailMessage {
  const url = `${env.WEB_PUBLIC_URL}/app/tester/projects/${projectId}`
  return {
    to,
    subject: `You have been invited to test: ${projectTitle}`,
    text: `You have a new project invitation on Crowd4Test.\n\nProject: ${projectTitle}\n\nReview the scope and respond here:\n${url}`,
  }
}

/**
 * §42 — an invitation to join an organisation's team.
 *
 * The inviter's own note is passed through verbatim when they wrote one. It is
 * plain text in a plain-text email, so there is no markup for it to escape.
 */
export function teamInvitationEmail(
  to: string,
  token: string,
  organisationName: string,
  invitedByName: string,
  message?: string | null,
): MailMessage {
  const url = `${env.WEB_PUBLIC_URL}/invitations/${encodeURIComponent(token)}`
  const note = message?.trim() ? `\n\n${invitedByName} wrote:\n"${message.trim()}"\n` : '\n'
  return {
    to,
    subject: `${invitedByName} invited you to join ${organisationName} on Crowd4Test`,
    text: `You have been invited to join ${organisationName} on Crowd4Test.${note}\nAccept the invitation here:\n${url}\n\nThe link expires in 14 days. If you were not expecting this, you can ignore it.`,
  }
}
