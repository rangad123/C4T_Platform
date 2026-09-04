import type { NotificationType } from '@prisma/client'

/**
 * Which in-app notifications also go out as email, and how each one reads.
 *
 * ── WHY A TABLE AND NOT A DECISION AT EACH CALL SITE
 *
 * Notifications are raised from a dozen modules. If each one decided for
 * itself whether to send mail, the answer would drift — some events would go
 * out twice, new ones would silently go out not at all, and there would be no
 * single place to look when a recipient asks "why did I get this?". The
 * notification payload already carries everything an email needs (title, body,
 * link), so the only thing missing was a policy, and this is it.
 *
 * A type absent from this table sends no email. That is the safe default: a
 * new `NotificationType` starts life in-app only, and turning it into mail is
 * a deliberate edit here.
 */
export interface EmailPolicy {
  /** The button under the copy. Verb-first, per the copy rules. */
  action: string
  /**
   * Skip the email when the recipient already has an unread notification of
   * this same type and link.
   *
   * For the bursty kinds — a back-and-forth in a thread, a tester filing six
   * bugs in an hour — the second email tells the recipient nothing the first
   * one did not, and a mailbox full of them is how people learn to filter the
   * sender into a folder. They still get every notification in the app; what
   * throttles is the nudge, and it resumes the moment they read the last one.
   */
  throttle?: boolean
  /**
   * Sent even to recipients who have turned notification email off.
   *
   * Reserved for money and account standing — the two things someone who
   * muted us would still hold us responsible for not telling them. Everything
   * else respects the preference.
   */
  essential?: boolean
}

export const EMAIL_POLICY: Partial<Record<NotificationType, EmailPolicy>> = {
  PROJECT_ASSIGNED: { action: 'View the invitation' },
  PROJECT_STATUS_CHANGED: { action: 'Open the project' },
  BUG_REPORTED: { action: 'Review the bug', throttle: true },
  BUG_STATUS_CHANGED: { action: 'Open the bug' },
  MESSAGE_RECEIVED: { action: 'Read the message', throttle: true },
  RATING_RECEIVED: { action: 'See your rating' },
  TRANSACTION_UPDATED: { action: 'View the payment', essential: true },
  TESTER_STATUS_CHANGED: { action: 'Open your profile', essential: true },
  ANNOUNCEMENT: { action: 'Read the announcement' },
  SYSTEM: { action: 'Open Crowd4Test' },
}

/**
 * The footer line explaining why this arrived. Recipients who cannot tell why
 * they were emailed report it as spam; one honest sentence prevents that.
 */
export const EMAIL_REASON = 'You received this because of activity on your Crowd4Test account.'
