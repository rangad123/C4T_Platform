import type { CSSProperties, InputHTMLAttributes, ReactNode } from 'react'
import { Icon } from '../core/Icon'

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'style'
> {
  label: string
  /** Second line under the label. */
  description?: string
  /**
   * Extra content rendered INLINE after the label — links, typically.
   *
   * Exists because anchors cannot go in `label`: it is typed as a string
   * deliberately, since assistive tech announces a control's label as one
   * string and burying links in it produces a run-on name and traps focus
   * between the box and the anchors.
   *
   * When this is set the wrapper stops being a `<label>` and becomes a
   * `<span>`, with an explicit `<label htmlFor>` around the text only — so the
   * links sit beside the label rather than inside it, stay individually
   * focusable, and the announced name is still just `label`. Requires `id`.
   */
  labelSuffix?: ReactNode
  /**
   * Surface the checkbox sits on. `inverse` for the dark bands.
   *
   * NOT cosmetic. The first version had no tone, so on the cookie banner's
   * ink-950 band the label rendered in `--text-primary` (dark ink on dark) and
   * was invisible, and the CHECKED box filled with ink-950 — the same colour as
   * the band, leaving a floating tick and no box. Both states need inverting.
   */
  tone?: 'canvas' | 'inverse'
  style?: CSSProperties
  className?: string
}

/**
 * A styled checkbox that works without JavaScript.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * PORT NOTE — THIS IS A REWRITE, NOT A TRANSCRIPTION.
 *
 * The kit's Checkbox took `checked` and `onChange` and rendered its tick with
 * `{checked ? <Icon/> : null}`. Three consequences:
 *
 *  1. It was controlled-only. Passing `defaultChecked` gave a box that could be
 *     ticked but never showed a tick, because nothing re-rendered.
 *  2. It therefore could not appear in a form that posts to a server action
 *     without a client component wrapping it purely to hold a boolean.
 *  3. With JavaScript unavailable it was permanently unticked on screen while
 *     still submitting `on` — the worst of both.
 *
 * So the tick is always rendered and its visibility comes from CSS keyed on the
 * input's `:checked` state (`.c4t-checkbox` in styles/overrides.css). The
 * component is now uncontrolled by default, needs no state, and stays a Server
 * Component. `checked`/`onChange` still work if a caller wants to control it.
 *
 * The source also filled the tick with `var(--white)`, which CLAUDE.md rule 2
 * bars from composition; it uses `--text-on-brand` (ink-50).
 * ──────────────────────────────────────────────────────────────────────────
 */
export function Checkbox({
  label,
  description,
  labelSuffix,
  tone = 'canvas',
  disabled,
  id,
  style,
  className,
  ...rest
}: CheckboxProps) {
  const inverse = tone === 'inverse'
  /* A wrapping <label> cannot contain the links, so it becomes a span and the
     text gets its own `htmlFor` label. Clicking the words still toggles. */
  const Wrapper = labelSuffix ? 'span' : 'label'

  return (
    <Wrapper
      className={['c4t-checkbox', inverse ? 'c4t-checkbox--inverse' : null, className]
        .filter(Boolean)
        .join(' ')}
      style={{
        display: 'flex',
        gap: 10,
        alignItems: description ? 'flex-start' : 'center',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        ...style,
      }}
    >
      <span
        style={{
          position: 'relative',
          display: 'inline-flex',
          flex: 'none',
          marginTop: description ? 2 : 0,
        }}
      >
        <input
          type="checkbox"
          id={id}
          disabled={disabled}
          // Background and border-colour are NOT set here. They differ by
          // :checked, and an inline style outranks the class rule that switches
          // them — which is how the first version of this shipped an ink-50 tick
          // on an ink-50 box, i.e. invisible. Both live in `.c4t-checkbox`.
          style={{
            appearance: 'none',
            margin: 0,
            width: 20,
            height: 20,
            borderRadius: 'var(--radius-xs)',
            borderWidth: 1,
            borderStyle: 'solid',
            cursor: 'inherit',
            transition: 'var(--transition-control)',
          }}
          {...rest}
        />
        {/* Always mounted; `.c4t-checkbox` reveals it on :checked. */}
        <Icon
          name="check"
          size={14}
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            margin: 'auto',
            // Sits on the checked fill: ink-50 on ink-950 by default, and the
            // reverse on an inverse surface. The fills are in overrides.css.
            color: inverse ? 'var(--ink-950)' : 'var(--text-on-brand)',
            pointerEvents: 'none',
          }}
        />
      </span>

      <span>
        <span
          style={{
            display: 'block',
            fontSize: 'var(--type-body-sm-size)',
            lineHeight: 'var(--type-body-sm-line)',
            color: inverse ? 'var(--text-inverse)' : 'var(--text-primary)',
          }}
        >
          {labelSuffix ? (
            <>
              <label htmlFor={id} style={{ cursor: 'inherit' }}>
                {label}
              </label>{' '}
              {labelSuffix}
            </>
          ) : (
            label
          )}
        </span>
        {description ? (
          <span
            style={{
              display: 'block',
              fontSize: 'var(--type-caption-size)',
              color: inverse ? 'var(--text-inverse-muted)' : 'var(--text-muted)',
              marginTop: 2,
            }}
          >
            {description}
          </span>
        ) : null}
      </span>
    </Wrapper>
  )
}
