/**
 * What each kind of notification calls itself in a list.
 *
 * MESSAGE_RECEIVED reads as "Communication" and ANNOUNCEMENT as
 * "Announcement" because those are the two places a reader is being sent,
 * and the label is what tells them which before they click. The rest fall
 * back to their enum name in sentence case.
 *
 * Shared by the bell and the dashboard's activity feed. Two copies would be
 * two things to update when a `NotificationType` is added, and the reader
 * would see the same event named differently in two places on one screen.
 */
const TYPE_LABELS: Record<string, string> = {
  MESSAGE_RECEIVED: 'Communication',
  ANNOUNCEMENT: 'Announcement',
  PROJECT_ASSIGNED: 'Project',
  PROJECT_STATUS_CHANGED: 'Project',
  BUG_REPORTED: 'Bug',
  BUG_STATUS_CHANGED: 'Bug',
  RATING_RECEIVED: 'Rating',
  TRANSACTION_UPDATED: 'Payment',
  TESTER_STATUS_CHANGED: 'Account',
  SYSTEM: 'System',
}

export function notificationTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, ' ')
}
