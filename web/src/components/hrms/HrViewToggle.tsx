import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { setHrListView } from '@/lib/hrms/list-view-actions'
import type { HrListView } from '@/lib/hrms/list-view'

export interface HrViewToggleProps {
  /** Which view is currently showing. */
  active: HrListView
  /** The list's current URL, query string and all, so the switch keeps it. */
  returnTo: string
}

const OPTIONS: readonly { value: HrListView; label: string; icon: string }[] = [
  { value: 'table', label: 'Table', icon: 'table' },
  { value: 'cards', label: 'Cards', icon: 'layout-grid' },
]

/**
 * Table / cards switch for a list page.
 *
 * A form of two submit buttons rather than two links: the choice is
 * remembered in a cookie, and only a Server Action can set one. Both stay
 * rendered, so the control reads as a pair of states rather than a single
 * button whose label keeps changing — the ambiguous kind where you cannot
 * tell whether the label describes what you are seeing or what you will get.
 *
 * Which one is current is shown by the variant, and said in text for anyone
 * not seeing the variant. Not `aria-pressed`, which would mean teaching the
 * shared `Button` a prop for this one call site.
 */
export function HrViewToggle({ active, returnTo }: HrViewToggleProps) {
  return (
    <form
      action={setHrListView}
      role="group"
      aria-label="List view"
      style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
    >
      <input type="hidden" name="returnTo" value={returnTo} />
      {OPTIONS.map((option) => (
        <SubmitButton
          key={option.value}
          name="view"
          value={option.value}
          variant={active === option.value ? 'secondary' : 'ghost'}
          size="sm"
          iconLeft={option.icon}
          pendingLabel="…"
        >
          {option.label}
          {active === option.value ? (
            <span className="c4t-visually-hidden"> (showing now)</span>
          ) : null}
        </SubmitButton>
      ))}
    </form>
  )
}
