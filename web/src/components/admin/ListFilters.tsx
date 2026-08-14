import Link from 'next/link'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Button } from '@/components/ds/core/Button'
import { titleCase } from '@/lib/admin/format'

export interface SelectFilter {
  /** Query-param name, e.g. `status`. */
  name: string
  /** Field label. */
  label: string
  /** Enum values. The "all" option is prepended automatically. */
  options: readonly string[]
  /** Currently applied value, or undefined. */
  value: string | undefined
  /** Label for the empty option, e.g. "All statuses". */
  allLabel: string
}

export interface ListFiltersProps {
  /** Form target — the page's own path. */
  action: string
  /** Include a free-text search box. */
  search?: { value: string | undefined; placeholder: string }
  /** Zero or more dropdowns. */
  selects?: readonly SelectFilter[]
}

/**
 * The filter strip above an admin table.
 *
 * A plain GET form, so filtering is a navigation: the URL always describes what
 * you are looking at, the back button works, and the result is linkable and
 * bookmarkable. That keeps the whole list page a Server Component — no client
 * state, no `useSearchParams`, no hydration for a control that only ever
 * produces a URL.
 *
 * The Clear link only appears when something is actually applied, so the strip
 * does not offer to undo nothing.
 */
export function ListFilters({ action, search, selects = [] }: ListFiltersProps) {
  const hasApplied = Boolean(search?.value) || selects.some((s) => s.value)

  // One column per control, plus one that shrink-wraps the buttons.
  const columns = [
    ...(search ? ['minmax(220px, 1fr)'] : []),
    ...selects.map(() => 'minmax(170px, 220px)'),
    'auto',
  ].join(' ')

  return (
    <form
      method="get"
      action={action}
      style={{
        display: 'grid',
        gridTemplateColumns: columns,
        gap: 'var(--space-4)',
        alignItems: 'end',
      }}
    >
      {search ? (
        <Field label="Search" htmlFor="search">
          <Input
            id="search"
            name="search"
            type="search"
            defaultValue={search.value ?? ''}
            placeholder={search.placeholder}
            iconLeft="search"
          />
        </Field>
      ) : null}

      {selects.map((filter) => (
        <Field key={filter.name} label={filter.label} htmlFor={filter.name}>
          <Select
            id={filter.name}
            name={filter.name}
            defaultValue={filter.value ?? ''}
            options={[
              { value: '', label: filter.allLabel },
              ...filter.options.map((value) => ({ value, label: titleCase(value) })),
            ]}
          />
        </Field>
      ))}

      <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
        <Button type="submit" variant="primary" iconLeft="filter">
          Filter
        </Button>
        {hasApplied ? (
          <Link href={action}>
            <Button type="button" variant="ghost">
              Clear
            </Button>
          </Link>
        ) : null}
      </div>
    </form>
  )
}
