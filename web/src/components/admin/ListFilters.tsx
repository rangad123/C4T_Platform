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

/**
 * A compact free-text input alongside the search box. Used for short, fixed-format
 * values like a 2-letter ISO country code — a Select with 250 entries is too long,
 * a full Search box looks too heavy.
 */
export interface TextFilter {
  /** Query-param name, e.g. `countryCode`. */
  name: string
  /** Field label. */
  label: string
  /** Currently applied value, or undefined. */
  value: string | undefined
  /** Placeholder, e.g. "US". */
  placeholder: string
  /** Optional `maxlength` hint — not enforced server-side, just a UI nudge. */
  maxLength?: number
}

export interface SortOption {
  /** Query-param value for `sort`, e.g. `createdAt`. */
  value: string
  /** Human label — sort fields like `createdAt` don't title-case cleanly, so this is explicit rather than derived. */
  label: string
}

export interface SortFilter {
  /** Query-param name for the field — almost always `sort`. */
  name: string
  /** Query-param name for direction — almost always `order`. */
  orderName: string
  options: readonly SortOption[]
  value: string | undefined
  order: 'asc' | 'desc' | undefined
}

export interface ListFiltersProps {
  /** Form target — the page's own path. */
  action: string
  /** Include a free-text search box. */
  search?: { value: string | undefined; placeholder: string }
  /** Zero or more dropdowns. */
  selects?: readonly SelectFilter[]
  /** Zero or more compact text inputs. Use for short, fixed-format codes. */
  texts?: readonly TextFilter[]
  /** Optional "sort by" + direction pair. Omit for a list with a single fixed order. */
  sort?: SortFilter
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
export function ListFilters({ action, search, selects = [], texts = [], sort }: ListFiltersProps) {
  const hasApplied =
    Boolean(search?.value) ||
    selects.some((s) => s.value) ||
    texts.some((t) => t.value) ||
    Boolean(sort?.value)

  // One column per control, plus one that shrink-wraps the buttons.
  const columns = [
    ...(search ? ['minmax(220px, 1fr)'] : []),
    ...selects.map(() => 'minmax(170px, 220px)'),
    ...texts.map(() => 'minmax(140px, 170px)'),
    ...(sort ? ['minmax(150px, 190px)', 'minmax(130px, 150px)'] : []),
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

      {texts.map((filter) => (
        <Field key={filter.name} label={filter.label} htmlFor={filter.name}>
          <Input
            id={filter.name}
            name={filter.name}
            type="text"
            defaultValue={filter.value ?? ''}
            placeholder={filter.placeholder}
            maxLength={filter.maxLength}
          />
        </Field>
      ))}

      {sort ? (
        <>
          <Field label="Sort by" htmlFor={sort.name}>
            <Select
              id={sort.name}
              name={sort.name}
              defaultValue={sort.value ?? ''}
              options={[{ value: '', label: 'Default' }, ...sort.options]}
            />
          </Field>
          <Field label="Order" htmlFor={sort.orderName}>
            <Select
              id={sort.orderName}
              name={sort.orderName}
              defaultValue={sort.order ?? 'desc'}
              options={[
                { value: 'desc', label: 'Descending' },
                { value: 'asc', label: 'Ascending' },
              ]}
            />
          </Field>
        </>
      ) : null}

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
