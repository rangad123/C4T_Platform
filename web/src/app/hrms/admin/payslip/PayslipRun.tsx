'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ds/core/Button'
import { Badge } from '@/components/ds/core/Badge'
import { Spinner } from '@/components/ds/core/Spinner'
import { Checkbox } from '@/components/ds/forms/Checkbox'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { generatePayslipForEmployee } from './actions'

export type RunState = 'ready' | 'generated' | 'no-salary-breakdown' | 'not-employed'

export interface RunRow {
  id: string
  employeeCode: string
  firstName: string
  lastName: string
  state: RunState
  generatedAt: string | null
}

type Progress = { kind: 'generating' } | { kind: 'done' } | { kind: 'failed'; reason: string }

interface Summary {
  generated: number
  failed: number
  stopped: boolean
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function generatedOn(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  })
}

const MUTED = {
  color: 'var(--text-secondary)',
  fontSize: 'var(--type-body-sm-size)',
} as const

/**
 * The payslip run: one button that generates the month's payslips for every
 * active employee, in turn, with a live status against each person.
 *
 * ── WHY THE BROWSER DRIVES IT
 *
 * Each payslip is a 10–20 second job. Doing all of them in one request would
 * outlast the proxy in front of the API for anything beyond a handful of
 * people, so this calls a Server Action once per employee and walks the list
 * itself. That also makes it resumable: a run that is stopped, or a tab that is
 * closed, leaves every finished payslip in place, and the next run skips them.
 *
 * ── WHO IS IN A RUN
 *
 * Only people marked `ready`. Someone with a payslip already is left alone
 * unless "regenerate" is ticked, because regenerating replaces a document that
 * may already have been downloaded and filed. Someone with no salary breakdown
 * or who was not employed that month is listed with the reason, not silently
 * missing, so an empty row is never a mystery.
 */
export function PayslipRun({
  rows,
  financialYear,
  month,
  monthLabel,
}: {
  rows: readonly RunRow[]
  financialYear: string
  month: number
  monthLabel: string
}) {
  const router = useRouter()
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [running, setRunning] = useState(false)
  const [current, setCurrent] = useState<{ position: number; total: number } | null>(null)
  const [regenerate, setRegenerate] = useState(false)
  const [summary, setSummary] = useState<Summary | null>(null)
  const stopRequested = useRef(false)

  const counts = {
    ready: rows.filter((r) => r.state === 'ready').length,
    generated: rows.filter((r) => r.state === 'generated').length,
    noBreakdown: rows.filter((r) => r.state === 'no-salary-breakdown').length,
    notEmployed: rows.filter((r) => r.state === 'not-employed').length,
  }
  const queue = rows.filter((r) => r.state === 'ready' || (regenerate && r.state === 'generated'))

  async function run() {
    const work = [...queue]
    stopRequested.current = false
    setRunning(true)
    setSummary(null)
    setProgress({})

    let generated = 0
    let failed = 0
    let stopped = false

    for (const [index, row] of work.entries()) {
      if (stopRequested.current) {
        stopped = true
        break
      }
      setCurrent({ position: index + 1, total: work.length })
      setProgress((prev) => ({ ...prev, [row.id]: { kind: 'generating' } }))

      let outcome: Awaited<ReturnType<typeof generatePayslipForEmployee>>
      try {
        outcome = await generatePayslipForEmployee(row.id, financialYear, month)
      } catch {
        outcome = { ok: false, reason: 'The request did not complete. Try this one again.' }
      }

      if (outcome.ok) {
        generated += 1
        setProgress((prev) => ({ ...prev, [row.id]: { kind: 'done' } }))
      } else {
        const { reason } = outcome
        failed += 1
        setProgress((prev) => ({ ...prev, [row.id]: { kind: 'failed', reason } }))
      }
    }

    setCurrent(null)
    setRunning(false)
    setSummary({ generated, failed, stopped })
    // Pulls the roster again so "ready" becomes "generated" from the server's
    // own record, not just from what this page remembers doing.
    router.refresh()
  }

  const columns: readonly TableColumn<RunRow>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (row) => (
        <Link href={`/admin/${row.id}?section=payslip&fy=${financialYear}`}>
          {row.firstName} {row.lastName}
        </Link>
      ),
    },
    { key: 'employeeCode', header: 'Employee code', render: (row) => row.employeeCode },
    {
      key: 'status',
      header: 'Status',
      // The link below points at the same record's salary tab, so the cell
      // holds its own interactive content.
      interactive: true,
      render: (row) => {
        const step = progress[row.id]
        if (step?.kind === 'generating') {
          return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <Spinner size={16} />
              Generating…
            </span>
          )
        }
        if (step?.kind === 'done') return <Badge tone="success">Generated</Badge>
        if (step?.kind === 'failed') {
          return (
            <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              <Badge tone="error">Not generated</Badge>
              <span style={MUTED}>{step.reason}</span>
            </span>
          )
        }

        switch (row.state) {
          case 'generated':
            return (
              <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <Badge tone="success">Generated</Badge>
                {row.generatedAt ? <span style={MUTED}>{generatedOn(row.generatedAt)}</span> : null}
              </span>
            )
          case 'ready':
            return <Badge tone="info">Ready</Badge>
          case 'no-salary-breakdown':
            return (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                <Badge tone="warning">No salary breakdown</Badge>
                <Button
                  href={`/admin/${row.id}?section=salary&fy=${financialYear}`}
                  variant="link"
                  size="sm"
                >
                  Add breakdown
                </Button>
              </span>
            )
          case 'not-employed':
            return <Badge tone="neutral">Not employed this month</Badge>
        }
      },
    },
  ]

  const parts = [
    counts.ready > 0 ? `${counts.ready} ready to generate` : null,
    counts.generated > 0 ? `${counts.generated} already generated` : null,
    counts.noBreakdown > 0 ? `${counts.noBreakdown} without a salary breakdown` : null,
    counts.notEmployed > 0 ? `${counts.notEmployed} not employed this month` : null,
  ].filter((part): part is string => part !== null)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <p style={{ margin: 0, ...MUTED }}>
        {parts.length > 0 ? `${parts.join(', ')}.` : 'No active employees.'}
      </p>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-5)',
          flexWrap: 'wrap',
        }}
      >
        <Button
          type="button"
          variant="primary"
          iconLeft="credit-card"
          disabled={running || queue.length === 0}
          onClick={run}
        >
          {queue.length === 0
            ? 'Nothing to generate'
            : `Generate ${count(queue.length, 'payslip')} for ${monthLabel}`}
        </Button>
        {running ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              stopRequested.current = true
            }}
          >
            Stop after this one
          </Button>
        ) : null}
        {counts.generated > 0 ? (
          <Checkbox
            id="payslip-regenerate"
            label="Regenerate payslips that already exist"
            description="Replaces the stored PDF and figures."
            checked={regenerate}
            disabled={running}
            onChange={(event) => setRegenerate(event.currentTarget.checked)}
          />
        ) : null}
      </div>

      <div role="status" aria-live="polite" style={MUTED}>
        {running && current
          ? `Generating payslip ${current.position} of ${current.total}. Each takes about 15 seconds. Keep this page open until it finishes.`
          : summary
            ? `${count(summary.generated, 'payslip')} generated${
                summary.failed > 0 ? `, ${summary.failed} not generated` : ''
              }.${summary.stopped ? ' Stopped before the rest. Run again to continue.' : ''}`
            : null}
      </div>

      <Table
        ariaLabel={`Payslips for ${monthLabel}`}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
      />
    </div>
  )
}
