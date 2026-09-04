'use client'

import { useCallback, useState } from 'react'
import { Button } from '@/components/ds/core/Button'
import { Icon } from '@/components/ds/core/Icon'
import { TesterPicker } from './TesterPicker'
import { ConfigureAndConfirm, type TesterConfig } from './ConfigureAndConfirm'
import type { BuildTargets } from './compatibility'
import type { Candidate, CandidateMeta, FilterOptions } from './types'
import {
  assignSelectedTesters,
  type AssignResult,
} from '@/app/app/admin/projects/[id]/assign/actions'

/**
 * Invite testers onto a build: find, review, select, configure, confirm.
 *
 * ── WHAT THIS OWNS, AND WHAT IT DOES NOT
 *
 * Finding testers is `TesterPicker` — the same panel the message composer
 * uses, because "which testers do I want" is one question with one answer,
 * and two copies of it drift. What lives here is everything specific to
 * ASSIGNING them: the step machine, per-tester device/browser configuration,
 * the invitation notes, and what to say afterwards.
 *
 * Selection is held here rather than in the picker because it has to survive
 * the step change into configure-and-confirm, which unmounts the picker
 * entirely.
 */

export interface AssignWorkspaceProps {
  projectId: string
  buildId: string
  buildName: string
  projectLabel: string
  options: FilterOptions
  targets: BuildTargets
  templates: readonly { id: string; name: string; subject: string | null; body: string }[]
  /** Rendered by the server so the first paint has rows, not a spinner. */
  initialCandidates: Candidate[]
  initialMeta: CandidateMeta
}

export function AssignWorkspace({
  projectId,
  buildId,
  buildName,
  projectLabel,
  options,
  targets,
  templates,
  initialCandidates,
  initialMeta,
}: AssignWorkspaceProps) {
  const [step, setStep] = useState<'find' | 'configure'>('find')
  const [config, setConfig] = useState<Map<string, TesterConfig>>(new Map())
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [result, setResult] = useState<AssignResult | null>(null)

  /**
   * Keyed by `user.id`, not profile id: that is what the assign endpoint
   * takes, and keeping the two apart is how you avoid posting a profile id
   * and getting a confusing 422.
   *
   * A Map rather than a Set because the chosen tester has to stay legible
   * once they are no longer in the picker's rows — the confirmation step
   * lists people the current filter may have scrolled past.
   */
  const [selected, setSelected] = useState<Map<string, Candidate>>(new Map())

  const setTesterConfig = useCallback((testerId: string, patch: Partial<TesterConfig>) => {
    setConfig((current) => {
      const next = new Map(current)
      const existing = next.get(testerId) ?? { deviceId: '', browserId: '' }
      next.set(testerId, { ...existing, ...patch })
      return next
    })
  }, [])

  /**
   * Submitting is guarded by `submitting` rather than only by disabling the
   * button: a double Enter on the keyboard can fire twice before React has
   * re-rendered the disabled state, and every one of those would be a second
   * batch of invitations.
   */
  const submit = useCallback(async () => {
    if (submitting) return
    setSubmitting(true)
    setSubmitError(null)

    const chosen = [...selected.values()]
    const configurations = chosen
      .map((candidate) => {
        const entry = config.get(candidate.user.id)
        return {
          testerId: candidate.user.id,
          deviceId: entry?.deviceId || null,
          browserId: entry?.browserId || null,
        }
      })
      .filter((c) => c.deviceId || c.browserId)

    try {
      const outcome = await assignSelectedTesters({
        projectId,
        buildId,
        testerIds: chosen.map((c) => c.user.id),
        notes: notes.trim() || undefined,
        configurations,
      })
      if (!outcome.ok) {
        setSubmitError(outcome.message ?? 'The invitations could not be sent.')
        return
      }
      setResult(outcome)
      setSelected(new Map())
      setConfig(new Map())
    } catch {
      setSubmitError('The invitations could not be sent. Try again in a moment.')
    } finally {
      setSubmitting(false)
    }
  }, [submitting, selected, config, notes, projectId, buildId])

  /** Sent. The roster is already revalidated, so the link lands on fresh data. */
  if (result?.ok) {
    return (
      <SuccessPanel
        invited={result.invited ?? 0}
        reinvited={result.reinvited ?? 0}
        skipped={result.skipped ?? 0}
        buildName={buildName}
        rosterHref={`/app/admin/projects/${projectId}?section=testers&buildId=${buildId}`}
        onAssignMore={() => setResult(null)}
      />
    )
  }

  if (step === 'configure') {
    return (
      <ConfigureAndConfirm
        selected={[...selected.values()]}
        targets={targets}
        projectLabel={projectLabel}
        buildName={buildName}
        templates={templates}
        config={config}
        onConfigChange={setTesterConfig}
        notes={notes}
        onNotesChange={setNotes}
        onBack={() => setStep('find')}
        onAssign={() => void submit()}
        submitting={submitting}
        error={submitError}
      />
    )
  }

  return (
    <TesterPicker
      endpoint={`/app/admin/projects/${projectId}/assign/candidates`}
      fixedQuery={{ buildId }}
      options={options}
      initialCandidates={initialCandidates}
      initialMeta={initialMeta}
      selected={selected}
      onSelectionChange={setSelected}
      buildName={buildName}
      projectLabel={projectLabel}
      idPrefix="assign"
      emptyMessage="No testers are available to assign yet."
      summaryAction={
        <Button
          type="button"
          variant="primary"
          size="sm"
          iconRight="arrow-right"
          onClick={() => setStep('configure')}
        >
          Configure assignment
        </Button>
      }
    />
  )
}

/**
 * What happened, including what did not.
 *
 * `skipped` is reported rather than hidden: the API silently drops anyone who
 * already holds a row on this build, and an admin who selected eight and
 * invited six needs to know which number is real.
 */
function SuccessPanel({
  invited,
  reinvited,
  skipped,
  buildName,
  rosterHref,
  onAssignMore,
}: {
  invited: number
  reinvited: number
  skipped: number
  buildName: string
  rosterHref: string
  onAssignMore: () => void
}) {
  const total = invited + reinvited
  return (
    <section
      style={{
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-panel)',
        background: 'var(--surface-raised)',
        padding: 'var(--space-8)',
        textAlign: 'center',
      }}
    >
      <Icon name="check" size={28} style={CENTRED_ICON} />
      <h2 style={{ margin: 'var(--space-4) 0 0', fontSize: 'var(--type-body-lg-size)' }}>
        {total} invitation{total === 1 ? '' : 's'} sent
      </h2>
      <p style={{ margin: 'var(--space-2) 0 0', color: 'var(--text-secondary)' }}>
        {total > 0 ? `They have been notified and now appear on ${buildName}.` : 'Nothing was sent.'}
        {/*
          Revivals are called out rather than folded into the total: bringing
          back someone who declined or was removed is a different act from
          inviting a newcomer, and the reader chose it deliberately.
        */}
        {reinvited > 0
          ? ` ${reinvited} of ${reinvited === 1 ? 'those was' : 'those were'} re-invited after declining or being removed.`
          : ''}
        {skipped > 0
          ? ` ${skipped} ${skipped === 1 ? 'was' : 'were'} skipped — already active on this build.`
          : ''}
      </p>
      <div
        style={{
          display: 'flex',
          gap: 'var(--space-3)',
          justifyContent: 'center',
          marginTop: 'var(--space-6)',
          flexWrap: 'wrap',
        }}
      >
        <Button href={rosterHref} variant="primary">
          View the roster
        </Button>
        <Button type="button" variant="secondary" onClick={onAssignMore}>
          Invite more testers
        </Button>
      </div>
    </section>
  )
}

/**
 * Centred by `display: inline-block`, not by the parent's `text-align`.
 *
 * Lucide's SVGs compute to `display: block` here, and a block-level child
 * ignores `text-align` on its parent — so the tick sat hard against the left
 * edge of a panel that was otherwise centred. Making it inline-block is what
 * lets the parent's centring reach it.
 */
const CENTRED_ICON = { display: 'inline-block' } as const
