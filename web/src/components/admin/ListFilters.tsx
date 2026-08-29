import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Button } from '@/components/ds/core/Button'
import { LiveGetForm, LiveFormStatus } from '@/components/admin/LiveGetForm'
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
  /**
   * Query params to carry through unchanged — a `SectionTabs` value, most
   * commonly. Without this, submitting the filter form drops whatever tab
   * you were on and lands back on the default one, since a plain GET form
   * only ever sends its own named fields.
   */
  hidden?: Record<string, string | undefined>
}

/**
 * The filter strip above an admin table.
 *
 * A GET form (via `LiveGetForm`), so filtering is still a navigation: the URL
 * always describes what you are looking at, and the result is linkable and
 * bookmarkable. The list page itself stays a plain Server Component reading
 * `searchParams` exactly as before — only this strip needs to be a client
 * boundary, since only it needs to react to a field changing.
 *
 * Every field applies itself (immediately for a select, debounced for text),
 * so there is no separate "Filter" button to click — `LiveFormStatus` shows a
 * small "Updating…" in its place while a change is in flight. The Clear link
 * only appears when something is actually applied, so the strip does not
 * offer to undo nothing.
 */
export function ListFilters({
  action,
  search,
  selects = [],
  texts = [],
  sort,
  hidden,
}: ListFiltersProps) {
  const hasApplied =
    Boolean(search?.value) ||
    selects.some((s) => s.value) ||
    texts.some((t) => t.value) ||
    Boolean(sort?.value)

  return (
    /**
     * A wrapping flex row, not a grid with one column per control.
     *
     * The grid this replaced built an explicit `grid-template-columns` from
     * the filter list — `minmax(170px, 220px)` each. An explicit track list
     * cannot wrap, so five filters demanded ~1000px and the whole page
     * scrolled sideways on a phone. `flex-wrap` lets each control keep its
     * preferred width and drop to the next line when there is no room.
     *
     * The `flex` bases below preserve the old proportions: search grows at
     * twice the rate of a select, and the short code inputs stay narrow.
     */
    <LiveGetForm
      action={action}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--space-4)',
        alignItems: 'flex-end',
      }}
    >
      {Object.entries(hidden ?? {}).map(([name, value]) =>
        value ? <input key={name} type="hidden" name={name} value={value} /> : null,
      )}
      {search ? (
        <Field label="Search" htmlFor="search" style={{ flex: '2 1 220px' }}>
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
        <Field
          key={filter.name}
          label={filter.label}
          htmlFor={filter.name}
          style={{ flex: '1 1 170px', maxWidth: 220 }}
        >
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
        <Field
          key={filter.name}
          label={filter.label}
          htmlFor={filter.name}
          style={{ flex: '1 1 140px', maxWidth: 170 }}
        >
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
          <Field label="Sort by" htmlFor={sort.name} style={{ flex: '1 1 150px', maxWidth: 190 }}>
            <Select
              id={sort.name}
              name={sort.name}
              defaultValue={sort.value ?? ''}
              options={[{ value: '', label: 'Default' }, ...sort.options]}
            />
          </Field>
          <Field
            label="Order"
            htmlFor={sort.orderName}
            style={{ flex: '1 1 130px', maxWidth: 150 }}
          >
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

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          flex: '0 0 auto',
          marginLeft: 'auto',
        }}
      >
        <LiveFormStatus />
        {hasApplied ? (
          <Button href={action} type="button" variant="ghost">
            Clear
          </Button>
        ) : null}
      </div>
    </LiveGetForm>
  )
}
