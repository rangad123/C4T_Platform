import type { Tone } from '@/components/admin/StatusBadge'

/**
 * The solid, readable color a `Badge` tone maps to — its foreground token,
 * not the pale background wash a pill uses. A chart segment needs a color
 * that reads at a glance on its own, the way a badge's `bg`+`fg` pairing
 * doesn't need to (the pill's shape already carries the emphasis).
 *
 * Kept here rather than duplicating `Badge`'s `TONES` map, so a status keeps
 * the exact same color whether it's shown as a pill on a detail page or a
 * segment on a dashboard chart.
 */
const TONE_COLOR: Record<Tone, string> = {
  neutral: 'var(--text-muted)',
  brand: 'var(--text-brand)',
  accent: 'var(--text-accent)',
  success: 'var(--status-success-fg)',
  warning: 'var(--status-warning-fg)',
  error: 'var(--status-error-fg)',
  info: 'var(--status-info-fg)',
  inverse: 'var(--text-inverse)',
}

export function toneColor(tone: Tone): string {
  return TONE_COLOR[tone]
}
