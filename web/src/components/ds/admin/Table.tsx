import type { CSSProperties, ReactNode } from 'react'
import styles from './Table.module.css'

export interface TableColumn<Row> {
  /** Stable key for React. Should also be unique in this column set. */
  key: string
  /** Header label. Sentence case, never all-caps — the th style does that. */
  header: ReactNode
  /** Render the cell content for one row. */
  render: (row: Row) => ReactNode
  /** Optional: render a sub-line under the primary cell content. */
  renderSecondary?: (row: Row) => ReactNode
  /** Right-align numeric columns. */
  align?: 'left' | 'right'
  /** Optional width hint (px or %). */
  width?: string | number
}

export interface TableProps<Row> {
  columns: readonly TableColumn<Row>[]
  rows: readonly Row[]
  /** Stable key per row. */
  rowKey: (row: Row) => string
  /** Renders the row as a link. Mutually exclusive with `onRowClick`. */
  rowHref?: (row: Row) => string
  /** Called when a row is clicked. Mutually exclusive with `rowHref`. */
  onRowClick?: (row: Row) => void
  /** Rendered in place of an empty rows array. */
  emptyState?: ReactNode
  /** Optional aria-label on the table. Defaults to undefined. */
  ariaLabel?: string
  style?: CSSProperties
}

/**
 * The admin data table.
 *
 * A real `<table>` — divs-as-rows lose keyboard semantics, lose column
 * alignment under zoom, and re-implement sortable headers badly. Native
 * `<table>` gets correct `role="table"`, scope-based headers, and a working
 * "next column" key in screen readers for free.
 *
 * `rowHref` and `onRowClick` are exclusive: clicking a row either navigates or
 * triggers a callback. If both are passed, the href wins because a navigation
 * is the safer default.
 *
 * Keyboard nav: when `rowHref` is set the row is a real `<a>`, so Tab and
 * Enter work natively. With `onRowClick` only, the row is non-interactive —
 * callers that need keyboard support should wrap the row content in a button.
 */
export function Table<Row>({
  columns,
  rows,
  rowKey,
  rowHref,
  onRowClick,
  emptyState,
  ariaLabel,
  style,
}: TableProps<Row>) {
  if (rows.length === 0 && emptyState) {
    return <div style={style}>{emptyState}</div>
  }

  return (
    <div className={styles.wrapper} style={style}>
      <table className={styles.table} aria-label={ariaLabel}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className={col.align === 'right' ? styles.alignRight : undefined}
                style={
                  typeof col.width === 'number'
                    ? { width: col.width }
                    : col.width
                      ? { width: col.width }
                      : undefined
                }
                scope="col"
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row)
            const href = rowHref?.(row)

            if (href) {
              return (
                <tr key={key} className={styles.clickable}>
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={col.align === 'right' ? styles.alignRight : undefined}
                    >
                      {col.align === 'right' ? (
                        <a
                          href={href}
                          style={{
                            color: 'inherit',
                            textDecoration: 'none',
                            display: 'block',
                            textAlign: 'right',
                          }}
                        >
                          {col.render(row)}
                        </a>
                      ) : (
                        <a
                          href={href}
                          style={{ color: 'inherit', textDecoration: 'none', display: 'block' }}
                        >
                          <span className={styles.cellPrimary}>{col.render(row)}</span>
                          {col.renderSecondary ? (
                            <span className={styles.cellSecondary}>{col.renderSecondary(row)}</span>
                          ) : null}
                        </a>
                      )}
                    </td>
                  ))}
                </tr>
              )
            }

            return (
              <tr
                key={key}
                className={onRowClick ? styles.clickable : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onRowClick(row)
                        }
                      }
                    : undefined
                }
                role={onRowClick ? 'button' : undefined}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={col.align === 'right' ? styles.alignRight : undefined}
                  >
                    <span className={styles.cellPrimary}>{col.render(row)}</span>
                    {col.renderSecondary ? (
                      <span className={styles.cellSecondary}>{col.renderSecondary(row)}</span>
                    ) : null}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
