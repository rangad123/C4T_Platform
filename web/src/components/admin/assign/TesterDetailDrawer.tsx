'use client'

import { useEffect } from 'react'
import { Avatar } from '@/components/admin/Avatar'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { IconButton } from '@/components/ds/core/IconButton'
import type { Candidate } from './types'
import { describeAssignment, personLabel } from './types'

/**
 * One tester, without leaving the selection workflow.
 *
 * A drawer rather than a route: navigating to the tester's own page would
 * unmount the workspace and lose the selection built up to that point, which
 * is exactly the trip this is meant to save. Closing returns to the list with
 * everything intact, and the tester can be selected from in here too.
 *
 * Shows what helps decide — skills, languages, the devices and browsers they
 * actually own, their record — and deliberately not phone, Skype, LinkedIn or
 * date of birth. The candidate payload does not carry those, so there is
 * nothing here to leak even by accident.
 */
export interface TesterDetailDrawerProps {
  candidate: Candidate | null
  /** Only reached for a candidate who already holds a standing on a build. */
  buildName?: string
  projectLabel?: string
  onClose: () => void
  onToggle?: () => void
  selected: boolean
}

export function TesterDetailDrawer({
  candidate,
  buildName = '',
  projectLabel = '',
  onClose,
  onToggle,
  selected,
}: TesterDetailDrawerProps) {
  useEffect(() => {
    if (!candidate) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [candidate, onClose])

  if (!candidate) return null

  const standing = describeAssignment(candidate.assignment)
  const blocked = Boolean(standing && !standing.assignableAgain)

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 40,
          background: 'var(--overlay-scrim, rgba(23, 19, 15, 0.44))',
        }}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`${personLabel(candidate)} details`}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          zIndex: 41,
          width: 'min(460px, 100vw)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--surface-raised)',
          borderLeft: '1px solid var(--border-default)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 'var(--space-4)',
            padding: 'var(--space-5)',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <span style={{ display: 'inline-flex', gap: 'var(--space-4)', alignItems: 'center' }}>
            <Avatar name={personLabel(candidate)} fileId={candidate.user.avatarFileId} size="lg" />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <strong style={{ fontSize: 'var(--type-body-lg-size)' }}>
                {personLabel(candidate)}
              </strong>
              <span
                style={{ color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}
              >
                {candidate.profession ?? candidate.headline ?? '—'}
              </span>
              {standing ? (
                <span>
                  <Badge tone={standing.tone} uppercase={false}>
                    {standing.label}
                  </Badge>
                </span>
              ) : null}
            </span>
          </span>
          <IconButton icon="x" label="Close details" onClick={onClose} />
        </header>

        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: 'var(--space-5)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-6)',
          }}
        >
          <Facts
            items={[
              { label: 'Location', value: [candidate.city, candidate.countryCode].filter(Boolean).join(', ') },
              {
                label: 'Rating',
                value: candidate.ratingAverage
                  ? `${candidate.ratingAverage} from ${candidate.ratingCount} rating${candidate.ratingCount === 1 ? '' : 's'}`
                  : 'Not yet rated',
              },
              {
                label: 'Experience',
                value: candidate.experienceYears ? `${candidate.experienceYears} years` : '—',
              },
              { label: 'Bugs accepted', value: String(candidate.bugsAcceptedCount) },
              { label: 'Projects completed', value: String(candidate.projectsCompletedCount) },
            ]}
          />

          <Group title="Skills">
            {candidate.skills.length > 0 ? (
              <ChipRow items={candidate.skills.map((s) => s.skill.name)} />
            ) : (
              <Muted>No skills listed.</Muted>
            )}
          </Group>

          <Group title="Languages">
            {candidate.languages.length > 0 ? (
              <ChipRow
                items={candidate.languages.map((l) => `${l.code.toUpperCase()} · ${l.proficiency.toLowerCase()}`)}
              />
            ) : (
              <Muted>No languages listed.</Muted>
            )}
          </Group>

          {/*
            Devices and browsers are the part that decides whether this tester
            can cover the build at all, so they are listed in full rather than
            summarised — Step 3 configures the assignment from exactly these.
          */}
          <Group title="Devices">
            {candidate.devices.length > 0 ? (
              <ul style={LIST_STYLE}>
                {candidate.devices.map((d) => (
                  <li key={d.id}>
                    {[d.manufacturer, d.model].filter(Boolean).join(' ') || d.type}
                    <span style={{ color: 'var(--text-muted)' }}>
                      {d.osName ? ` · ${d.osName}${d.osVersion ? ` ${d.osVersion}` : ''}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Muted>No devices registered.</Muted>
            )}
          </Group>

          <Group title="Browsers">
            {candidate.browsers.length > 0 ? (
              <ul style={LIST_STYLE}>
                {candidate.browsers.map((b) => (
                  <li key={b.id}>
                    {b.browser.name}
                    {b.browserVersion ? ` ${b.browserVersion.version}` : ''}
                    <span style={{ color: 'var(--text-muted)' }}>
                      {b.osVersionRef
                        ? ` · ${b.osVersionRef.operatingSystem.name} ${b.osVersionRef.version}`
                        : b.operatingSystem
                          ? ` · ${b.operatingSystem.name}`
                          : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Muted>No browsers registered.</Muted>
            )}
          </Group>
        </div>

        <footer
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            padding: 'var(--space-5)',
            borderTop: '1px solid var(--border-subtle)',
          }}
        >
          {blocked ? (
            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>
              Already on {buildName} — {projectLabel}.
            </p>
          ) : (
            <Button type="button" variant={selected ? 'secondary' : 'primary'} onClick={onToggle}>
              {selected ? 'Remove from selection' : 'Add to selection'}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </footer>
      </aside>
    </>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <h3 className="c4t-heading-sm" style={{ margin: 0 }}>
        {title}
      </h3>
      {children}
    </section>
  )
}

function Facts({ items }: { items: { label: string; value: string }[] }) {
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 'var(--space-4)',
        margin: 0,
      }}
    >
      {items.map((item) => (
        <div key={item.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <dt className="c4t-eyebrow" style={{ color: 'var(--text-muted)', margin: 0 }}>
            {item.label}
          </dt>
          <dd style={{ margin: 0, color: 'var(--text-primary)' }}>{item.value || '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

function ChipRow({ items }: { items: string[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
      {items.map((item) => (
        <Badge key={item} tone="neutral" uppercase={false}>
          {item}
        </Badge>
      ))}
    </div>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>
      {children}
    </p>
  )
}

const LIST_STYLE = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 'var(--space-2)',
  fontSize: 'var(--type-body-sm-size)',
  color: 'var(--text-primary)',
}
