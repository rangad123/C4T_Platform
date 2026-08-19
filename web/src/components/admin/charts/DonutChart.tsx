import type { Tone } from '@/components/admin/StatusBadge'
import { toneColor } from './tone-color'
import styles from './DonutChart.module.css'

export interface DonutSegment {
  label: string
  value: number
  tone: Tone
  /** Overrides the legend's displayed number — e.g. a formatted currency
   *  amount, when `value` itself is in minor units and only used for the
   *  segment's proportional size. */
  displayValue?: string
}

export interface DonutChartProps {
  title: string
  segments: readonly DonutSegment[]
  /** Rendered in the donut's hollow center — usually the total. */
  centerLabel?: string
  /** Optional link target for the whole card — mirrors `BarRow`'s drill-through. */
  href?: string
}

/** Visual gap between adjacent ring segments, in degrees. */
const GAP_DEG = 3

/**
 * A ring of proportions with a legend — bug severity, payout category, that
 * kind of distribution. Built from a single CSS `conic-gradient`, not
 * `<svg>` arc math: the segment boundaries are exact percentages the server
 * already computed, and `conic-gradient` turns that list directly into a
 * ring with no trigonometry and no client JS. A small gap is carved between
 * adjacent segments (assumes the ring sits on `--surface-raised`, same as
 * the center hole) so the ring reads as distinct wedges rather than one
 * blurred band of colour.
 *
 * Zero data renders a flat neutral ring with "No data yet" in the center
 * rather than an empty gradient — a ring with nothing in it is easy to
 * mistake for a loading state instead of an honest zero.
 */
export function DonutChart({ title, segments, centerLabel, href }: DonutChartProps) {
  const total = segments.reduce((sum, s) => sum + s.value, 0)
  const nonZero = segments.filter((s) => s.value > 0)

  const gapDeg = nonZero.length > 1 ? GAP_DEG : 0
  const usableDeg = 360 - gapDeg * nonZero.length

  let cursor = 0
  const stops: string[] = []
  for (const s of nonZero) {
    const arc = (s.value / total) * usableDeg
    const start = cursor
    const end = cursor + arc
    stops.push(`${toneColor(s.tone)} ${start}deg ${end}deg`)
    if (gapDeg > 0) stops.push(`var(--surface-raised) ${end}deg ${end + gapDeg}deg`)
    cursor = end + gapDeg
  }

  const gradient = total === 0 ? 'var(--surface-sunken)' : `conic-gradient(${stops.join(', ')})`

  const content = (
    <>
      <div className={styles.title}>{title}</div>
      <div className={styles.body}>
        <div
          role="img"
          aria-label={`${title}: ${nonZero.map((s) => `${s.label} ${s.displayValue ?? s.value}`).join(', ') || 'no data'}`}
          className={styles.ring}
          style={{ background: gradient }}
        >
          <div className={styles.hole}>
            <span className={styles.centerValue}>{centerLabel ?? total}</span>
            <span className={styles.centerCaption}>Total</span>
          </div>
        </div>
        {total === 0 ? (
          <span className={styles.emptyLabel}>No data yet.</span>
        ) : (
          <div className={styles.legend}>
            {segments.map((s) => (
              <span key={s.label} className={styles.legendItem}>
                <span
                  aria-hidden="true"
                  className={styles.legendDot}
                  style={{ background: toneColor(s.tone) }}
                />
                <span className={styles.legendLabel}>{s.label}</span>
                <span className={styles.legendValue}>{s.displayValue ?? s.value}</span>
                <span className={styles.legendPercent}>
                  ({Math.round((s.value / total) * 100)}%)
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
    </>
  )

  return href ? (
    <a href={href} className={styles.wrapper}>
      {content}
    </a>
  ) : (
    <div className={styles.wrapper}>{content}</div>
  )
}
