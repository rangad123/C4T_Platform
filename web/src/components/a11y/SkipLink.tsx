'use client'

/**
 * Skip-to-content link.
 *
 * The first focusable element on every marketing page. Hidden by default
 * with the `c4t-visually-hidden` utility (which clips the element to a
 * 1px square and sr-onlys it), and revealed on focus so keyboard users
 * see a button-shaped target appear at the top of the page.
 *
 * The page's `<main id="main">` is the target — the admin layout uses the
 * same id, so the skip link works on both surfaces.
 */
export function SkipLink() {
  return (
    <a
      href="#main"
      className="c4t-visually-hidden"
      style={{
        position: 'absolute',
        top: 'var(--space-4)',
        left: 'var(--space-4)',
        zIndex: 200,
        padding: 'var(--space-3) var(--space-4)',
        background: 'var(--surface-ink)',
        color: 'var(--text-inverse)',
        borderRadius: 'var(--radius-input)',
        textDecoration: 'none',
        fontWeight: 'var(--fw-semibold)',
      }}
      onFocus={(e) => {
        e.currentTarget.classList.remove('c4t-visually-hidden')
      }}
      onBlur={(e) => {
        e.currentTarget.classList.add('c4t-visually-hidden')
      }}
    >
      Skip to content
    </a>
  )
}
