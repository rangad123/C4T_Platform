import type { Tone } from '@/components/admin/StatusBadge'
import { toneColor } from './tone-color'
import styles from './BarChart.module.css'

export interface BarSegment {
  label: string
  value: number
  tone: Tone
  /** Overrides the displayed number — e.g. a formatted currency amount, when
   *  `value` itself is only used for the bar's proportional length. */
  displayValue?: string
}

export interface BarChartProps {
  title: string
  segments: readonly BarSegment[]
  /** Optional link target for the whole card — the dashboard card drills into the filtered list. */
  href?: string
}

/**
 * A real bar chart — one bar per category, each length proportional to the
 * shared maximum, so magnitudes compare directly at a glance.
 *
 * This replaces the earlier "segmented single bar" (one 100%-wide track
 * split into colored slices, sized to each segment's SHARE of the total).
 * That form answers "what's the mix" but hides the actual counts — a status
 * with 2 bugs and one with 20 could draw the same width if every other
 * status shrank to match. Separate bars scaled to one shared max answer the
 * more common question here directly: which category has the most.
 *
 * Every bar is direct-labeled (the count sits right next to it), so there is
 * no separate legend to keep in sync — a fixed, meaningful category order
 * (severity high-to-low, a lifecycle's stages) is preserved exactly as the
 * caller passed it in, never re-sorted by value.
 */
export function BarChart({ title, segments, href }: BarChartProps) {
  const total = segments.reduce((sum, s) => sum + s.value, 0)
  const max = Math.max(1, ...segments.map((s) => s.value))

  const body = (
    <>
      <div className={styles.header}>
        <span className={styles.title}>{title}</span>
        <span className={styles.total}>{total} total</span>
      </div>
      {total === 0 ? (
        <span className={styles.emptyLabel}>No data yet.</span>
      ) : (
        <div className={styles.rows}>
          {segments.map((s) => (
            <div key={s.label} className={styles.row}>
              <span className={styles.label}>{s.label}</span>
              <span className={styles.track}>
                <span
                  className={styles.fill}
                  title={`${s.label}: ${s.displayValue ?? s.value}`}
                  style={{ width: `${(s.value / max) * 100}%`, background: toneColor(s.tone) }}
                />
              </span>
              <span className={styles.value}>{s.displayValue ?? s.value}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )

  return href ? (
    <a href={href} className={styles.wrapper}>
      {body}
    </a>
  ) : (
    <div className={styles.wrapper}>{body}</div>
  )
}
