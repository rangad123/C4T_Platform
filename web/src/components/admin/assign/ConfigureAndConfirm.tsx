'use client'

import { useMemo, useState } from 'react'
import { Avatar } from '@/components/admin/Avatar'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { Icon } from '@/components/ds/core/Icon'
import { Spinner } from '@/components/ds/core/Spinner'
import { Field } from '@/components/ds/forms/Field'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import {
  browserLabel,
  compatibilityIssues,
  deviceLabel,
  relevantBrowsers,
  relevantDevices,
  type BuildTargets,
} from './compatibility'
import type { Candidate } from './types'
import { personLabel } from './types'

export interface TesterConfig {
  deviceId: string
  browserId: string
}

export interface ConfigureAndConfirmProps {
  selected: Candidate[]
  targets: BuildTargets
  projectLabel: string
  buildName: string
  templates: readonly { id: string; name: string; subject: string | null; body: string }[]
  config: Map<string, TesterConfig>
  onConfigChange: (testerId: string, patch: Partial<TesterConfig>) => void
  notes: string
  onNotesChange: (value: string) => void
  onBack: () => void
  onAssign: () => void
  submitting: boolean
  error: string | null
}

/**
 * Steps 3 and 4 — configure what each tester covers, then confirm.
 *
 * Kept on one screen rather than two. The confirmation is a summary of what
 * is directly above it, and making the reader navigate away from the choices
 * to read a list of those same choices adds a step without adding certainty.
 * The warnings are what a confirmation is actually for, so they sit at the
 * top where they cannot be missed.
 */
export function ConfigureAndConfirm({
  selected,
  targets,
  projectLabel,
  buildName,
  templates,
  config,
  onConfigChange,
  notes,
  onNotesChange,
  onBack,
  onAssign,
  submitting,
  error,
}: ConfigureAndConfirmProps) {
  const [template, setTemplate] = useState('')

  /** Testers the build's own targets say cannot cover it. Warned, never blocked. */
  const problems = useMemo(
    () =>
      selected
        .map((candidate) => ({ candidate, issues: compatibilityIssues(candidate, targets) }))
        .filter((entry) => entry.issues.length > 0),
    [selected, targets],
  )

  const noAssets = useMemo(
    () => selected.filter((c) => c.devices.length === 0 && c.browsers.length === 0),
    [selected],
  )

  function applyTemplate(id: string) {
    setTemplate(id)
    const chosen = templates.find((t) => t.id === id)
    if (chosen) onNotesChange(chosen.body)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <Panel
        title="Assignment details"
        description={`${selected.length} tester${selected.length === 1 ? '' : 's'} · ${projectLabel} · ${buildName}`}
      >
        {/*
          Project and build are stated, never chosen. They come from the route
          this workspace was opened from, so there is no control here that
          could send invitations to the wrong build.
        */}
        <dl style={FACTS_STYLE}>
          <Fact label="Project" value={projectLabel} />
          <Fact label="Build" value={buildName} />
          <Fact
            label="Targets"
            value={
              [
                targets.operatingSystems.join(', '),
                targets.browsers.join(', '),
                targets.devices.join(', '),
              ]
                .filter(Boolean)
                .join(' · ') || 'None set on this build'
            }
          />
        </dl>
      </Panel>

      {problems.length > 0 || noAssets.length > 0 ? (
        <Panel title="Before you send">
          <ul style={{ margin: 0, paddingLeft: 'var(--space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {noAssets.map((c) => (
              <li key={`assets-${c.user.id}`} style={{ color: 'var(--status-warning-fg)' }}>
                <strong>{personLabel(c)}</strong> has no devices or browsers registered — nothing to
                configure, and no way to confirm they can run this build.
              </li>
            ))}
            {problems
              .filter((p) => !noAssets.includes(p.candidate))
              .map((p) => (
                <li key={`issue-${p.candidate.user.id}`} style={{ color: 'var(--status-warning-fg)' }}>
                  <strong>{personLabel(p.candidate)}</strong> — {p.issues.map((i) => i.message).join(' ')}
                </li>
              ))}
          </ul>
          <p
            style={{
              margin: 'var(--space-4) 0 0',
              color: 'var(--text-secondary)',
              fontSize: 'var(--type-body-sm-size)',
            }}
          >
            These are warnings, not blocks — a tester may still be the right choice. The build&rsquo;s
            targets are free text, so treat a mismatch as worth a look rather than a verdict.
          </p>
        </Panel>
      ) : null}

      <Panel
        title="What each tester covers"
        description="Chosen from the assets each tester has registered. Optional — leave as “Not specified” to let them choose."
      >
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {selected.map((candidate) => {
            const devices = relevantDevices(candidate, targets)
            const browsers = relevantBrowsers(candidate, targets)
            const current = config.get(candidate.user.id)
            return (
              <li
                key={candidate.user.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(180px, 1fr) minmax(160px, 1fr) minmax(160px, 1fr)',
                  gap: 'var(--space-4)',
                  alignItems: 'end',
                  paddingBottom: 'var(--space-4)',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                  <Avatar name={personLabel(candidate)} fileId={candidate.user.avatarFileId} size="sm" />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 'var(--fw-medium)' }}>
                      {personLabel(candidate)}
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
                      {candidate.devices.length} device{candidate.devices.length === 1 ? '' : 's'} ·{' '}
                      {candidate.browsers.length} browser{candidate.browsers.length === 1 ? '' : 's'}
                    </span>
                  </span>
                </span>

                <Field label="Device" htmlFor={`device-${candidate.user.id}`}>
                  <Select
                    id={`device-${candidate.user.id}`}
                    value={current?.deviceId ?? ''}
                    disabled={devices.length === 0}
                    onChange={(e) => onConfigChange(candidate.user.id, { deviceId: e.target.value })}
                    options={[
                      {
                        value: '',
                        label: devices.length === 0 ? 'None registered' : 'Not specified',
                      },
                      ...devices.map((d) => ({ value: d.id, label: deviceLabel(d) })),
                    ]}
                  />
                </Field>

                <Field label="Browser" htmlFor={`browser-${candidate.user.id}`}>
                  <Select
                    id={`browser-${candidate.user.id}`}
                    value={current?.browserId ?? ''}
                    disabled={browsers.length === 0}
                    onChange={(e) => onConfigChange(candidate.user.id, { browserId: e.target.value })}
                    options={[
                      {
                        value: '',
                        label: browsers.length === 0 ? 'None registered' : 'Not specified',
                      },
                      ...browsers.map((b) => ({ value: b.id, label: browserLabel(b) })),
                    ]}
                  />
                </Field>
              </li>
            )
          })}
        </ul>
      </Panel>

      <Panel
        title="Message"
        description="Sent with the invitation and shown in the tester's notifications."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {/*
            The notification's title is composed by the API from the project
            name, so there is no subject to edit here. Showing it read-only is
            honest; an editable box that the API discards would not be.
          */}
          <Field label="Subject" hint="Set by the platform from the project name.">
            <p
              style={{
                margin: 0,
                padding: 'var(--space-3) 0',
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--type-body-sm-size)',
              }}
            >
              You have been invited to test “{projectLabel.split(' · ').slice(1).join(' · ')}”
            </p>
          </Field>

          {templates.length > 0 ? (
            <Field
              label="Start from a template"
              htmlFor="assign-template"
              hint="Optional. Replaces the message below."
            >
              <Select
                id="assign-template"
                value={template}
                onChange={(e) => applyTemplate(e.target.value)}
                options={[
                  { value: '', label: 'No template' },
                  ...templates.map((t) => ({ value: t.id, label: t.name })),
                ]}
              />
            </Field>
          ) : null}

          <Field label="Message" htmlFor="assign-notes" hint="Optional.">
            <Textarea
              id="assign-notes"
              rows={5}
              maxLength={1000}
              value={notes}
              onChange={(e) => onNotesChange(e.target.value)}
            />
          </Field>
        </div>
      </Panel>

      {error ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: 'var(--space-4) var(--space-5)',
            borderRadius: 'var(--radius-card)',
            background: 'var(--status-error-bg)',
            color: 'var(--status-error-fg)',
          }}
        >
          {error}
        </p>
      ) : null}

      <div
        style={{
          display: 'flex',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Button type="button" variant="secondary" iconLeft="arrow-left" onClick={onBack} disabled={submitting}>
          Back to selection
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={onAssign}
          disabled={submitting || selected.length === 0}
        >
          {submitting ? (
            <>
              <Spinner size={16} />
              Sending invitations…
            </>
          ) : (
            `Invite ${selected.length} tester${selected.length === 1 ? '' : 's'}`
          )}
        </Button>
      </div>
    </div>
  )
}

function Panel({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section
      style={{
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-panel)',
        background: 'var(--surface-raised)',
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          padding: 'var(--space-5) var(--space-6)',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 'var(--type-body-md-size)', fontWeight: 'var(--fw-semibold)' }}>
          {title}
        </h2>
        {description ? (
          <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>
            {description}
          </p>
        ) : null}
      </header>
      <div style={{ padding: 'var(--space-6)' }}>{children}</div>
    </section>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <dt className="c4t-eyebrow" style={{ color: 'var(--text-muted)', margin: 0 }}>
        {label}
      </dt>
      <dd style={{ margin: 0, color: 'var(--text-primary)' }}>{value}</dd>
    </div>
  )
}

const FACTS_STYLE = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: 'var(--space-5)',
  margin: 0,
} as const
