'use client'

import { useRouter, useSearchParams } from 'next/navigation'

export interface BuildSwitcherOption {
  id: string
  name: string
}

export interface BuildSwitcherProps {
  basePath: string
  builds: readonly BuildSwitcherOption[]
  activeBuildId: string
}

/**
 * The one control on the project page that changes which test cycle every
 * build-scoped tab (Testers, Materials, Features, Bugs) shows.
 *
 * A `<select>` rather than a row of links: a project can accumulate many
 * builds over its life, and a link per build would grow the header
 * unboundedly. `'use client'` only for the auto-submit-on-change — there is
 * no other client state here, and the actual scoping happens server-side via
 * the `?buildId=` this pushes, exactly like every other filter in this app.
 *
 * ── WHY NO "(default)" MARKER
 *
 * Options used to render as `name (default)` for the build carrying
 * `isDefault`. That flag is pure plumbing: it is set once, on the build every
 * project is created with, and no screen in any portal can move it. Its only
 * behavioural consequence lives in `archiveBuild`, which the frontend never
 * calls. So the suffix marked something a reader could neither change nor act
 * on — and after renaming that build it read as leftover text, as though the
 * new name had only half applied. The default build still sorts first
 * (`orderBy: [{ isDefault: 'desc' }, …]`), which is all the ordering cue this
 * control needs. `isDefault` is still read on the page itself, to prefill the
 * New build modal — it is the label that was noise, not the field.
 */
export function BuildSwitcher({ basePath, builds, activeBuildId }: BuildSwitcherProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  function onChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('buildId', event.target.value)
    router.push(`${basePath}?${params.toString()}`)
  }

  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        fontSize: 'var(--type-body-sm-size)',
        color: 'var(--text-secondary)',
      }}
    >
      <span className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>
        Build
      </span>
      <select
        value={activeBuildId}
        onChange={onChange}
        className="c4t-input"
        aria-label="Active build"
        style={{
          width: 'auto',
          // Build names are free text. Without a ceiling the control sizes to
          // the longest one and overflows a narrow viewport.
          maxWidth: '100%',
          minWidth: 0,
          height: 32,
          padding: '0 var(--space-6) 0 var(--space-3)',
          fontSize: 'var(--type-body-sm-size)',
        }}
      >
        {builds.map((build) => (
          <option key={build.id} value={build.id}>
            {build.name}
          </option>
        ))}
      </select>
    </label>
  )
}
