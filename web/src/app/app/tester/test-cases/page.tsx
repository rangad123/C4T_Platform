import Link from 'next/link'
import { requireRole } from '@/lib/auth/session'
import { serverFetchPage } from '@/lib/api/server'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Field } from '@/components/ds/forms/Field'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { Input } from '@/components/ds/forms/Input'
import { Button } from '@/components/ds/core/Button'
import { formatDate } from '@/lib/admin/format'
import { submitTestReport } from './actions'

const RESULTS = ['PASS', 'FAIL', 'BLOCKED'] as const

interface TestCaseRow {
  id: string
  feature: string | null
  title: string
  description: string
  steps: string
  expectedResult: string
  build: { id: string; name: string; project: { id: string; reference: string; title: string } }
  reports: readonly {
    id: string
    result: string
    notes: string | null
    createdAt: string
    tester: { id: string }
  }[]
}

/**
 * `/app/tester/test-cases` — the scripted checks assigned to this tester,
 * across every project and build they are on.
 *
 * Distinct from `/app/tester/bugs`: a test case is a script an admin or
 * manager wrote; a bug is a defect this tester found, which may or may not
 * have come from running one of these. Submitting a report here does not
 * create a bug — file one separately from Report a bug if the case failed
 * because of a real defect.
 */
export default async function TesterTestCasesPage({
  searchParams,
}: {
  searchParams: Promise<{ submitted?: string }>
}) {
  const user = await requireRole(['TESTER'])
  const justSubmitted = (await searchParams).submitted === '1'

  let rows: TestCaseRow[] = []
  let failed = false
  try {
    const result = await serverFetchPage<TestCaseRow>('test-cases', {
      query: { limit: 50, sort: 'createdAt', order: 'desc' },
    })
    rows = result.data
  } catch {
    failed = true
  }

  return (
    <main
      id="main"
      style={{
        maxWidth: 960,
        margin: '0 auto',
        padding: 'var(--space-9) var(--space-7)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
      }}
    >
      {justSubmitted ? (
        <div
          role="status"
          style={{
            padding: 'var(--space-4) var(--space-5)',
            borderRadius: 'var(--radius-card)',
            background: 'var(--status-success-bg)',
            color: 'var(--status-success-fg)',
          }}
        >
          Report submitted.
        </div>
      ) : null}

      <header style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        <Link
          href="/app/tester"
          style={{ color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}
        >
          ← Back to your account
        </Link>
        <h1 className="c4t-display-md" style={{ margin: 0 }}>
          Test cases
        </h1>
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
          Scripted checks assigned to you. Run each one and file the result — pass, fail or
          blocked. If a case fails because of a real defect, report it separately from Report a
          bug and link it there.
        </p>
      </header>

      {failed ? (
        <EmptyState
          icon="alert-triangle"
          title="Could not load your test cases"
          description="The service is unreachable. Refresh in a moment."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="test-tube-diagonal"
          title="No test cases assigned"
          description="A project manager assigns scripted checks to you here when there is one to run."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          {rows.map((tc) => {
            const myReports = tc.reports.filter((r) => r.tester.id === user.id)
            const latest = myReports[0]
            return (
              <section
                key={tc.id}
                style={{
                  border: '1px solid var(--border-default)',
                  borderRadius: 'var(--radius-card)',
                  padding: 'var(--space-6)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-4)',
                  background: 'var(--surface-raised)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
                  <div>
                    <h2 className="c4t-heading-md" style={{ margin: 0 }}>
                      {tc.title}
                    </h2>
                    <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
                      {tc.build.project.reference} · {tc.build.project.title} · {tc.build.name}
                      {tc.feature ? ` · ${tc.feature}` : ''}
                    </p>
                  </div>
                  {latest ? <StatusBadge status={latest.result} /> : null}
                </div>

                <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                  <div>
                    <dt className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>
                      Steps
                    </dt>
                    <dd style={{ margin: 'var(--space-1) 0 0', whiteSpace: 'pre-wrap' }}>{tc.steps}</dd>
                  </div>
                  <div>
                    <dt className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>
                      Expected result
                    </dt>
                    <dd style={{ margin: 'var(--space-1) 0 0' }}>{tc.expectedResult}</dd>
                  </div>
                </dl>

                {myReports.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                    <p className="c4t-eyebrow" style={{ margin: 0, color: 'var(--text-muted)' }}>
                      Your reports
                    </p>
                    {myReports.map((r) => (
                      <p key={r.id} style={{ margin: 0, fontSize: 'var(--type-body-sm-size)' }}>
                        <StatusBadge status={r.result} /> <Caption>{formatDate(r.createdAt)}</Caption>
                        {r.notes ? ` — ${r.notes}` : ''}
                      </p>
                    ))}
                  </div>
                ) : null}

                <form
                  action={submitTestReport}
                  style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
                >
                  <input type="hidden" name="testCaseId" value={tc.id} />
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--space-3)' }}>
                    <Field label="Result" htmlFor={`result-${tc.id}`} required>
                      <Select
                        id={`result-${tc.id}`}
                        name="result"
                        required
                        placeholder="Choose a result"
                        options={RESULTS.map((v) => ({ value: v, label: v.charAt(0) + v.slice(1).toLowerCase() }))}
                      />
                    </Field>
                    <Field label="Devices" htmlFor={`devices-${tc.id}`}>
                      <Input id={`devices-${tc.id}`} name="devices" maxLength={200} />
                    </Field>
                    <Field label="Browsers" htmlFor={`browsers-${tc.id}`}>
                      <Input id={`browsers-${tc.id}`} name="browsers" maxLength={200} />
                    </Field>
                  </div>
                  <Field label="Notes" htmlFor={`notes-${tc.id}`}>
                    <Textarea id={`notes-${tc.id}`} name="notes" rows={2} maxLength={4000} />
                  </Field>
                  <div>
                    <Button type="submit" variant="primary" size="sm">
                      Submit report
                    </Button>
                  </div>
                </form>
              </section>
            )
          })}
        </div>
      )}
    </main>
  )
}

function Caption({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ color: 'var(--text-muted)', fontSize: 'var(--type-caption-size)' }}>{children}</span>
  )
}
