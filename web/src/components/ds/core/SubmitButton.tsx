'use client'

import { useFormStatus } from 'react-dom'
import type { ReactNode } from 'react'
import { Button, type ButtonProps } from './Button'
import { Spinner } from './Spinner'

export interface SubmitButtonProps extends Omit<ButtonProps, 'type' | 'href' | 'prefetch'> {
  /**
   * Shown in place of `children` while the enclosing form is submitting —
   * "Saving…", "Deleting…", "Creating build…". Omit to keep the same label
   * during submission (still gets the spinner and the disabled state).
   */
  pendingLabel?: ReactNode
}

const SPINNER_SIZE = { sm: 16, md: 18, lg: 20 } as const

/**
 * A `<Button type="submit">` that knows whether the form it's inside is
 * actually mid-submission — via `useFormStatus`, not a prop threaded down
 * from the page and not a timer. Swaps in a spinner (replacing `iconLeft`/
 * `iconRight`), an optional pending-specific label, and disables the button
 * (real `disabled`, which is what actually stops a second click from firing
 * a second submission — that's the point of this component).
 *
 * Small `'use client'` leaf, the same shape as `PasswordToggleInput`: the
 * enclosing `<form action={serverAction}>` and everything else on the page
 * stays a Server Component. `useFormStatus` only reports the status of the
 * NEAREST ANCESTOR `<form>`, so this has to render as a descendant of the
 * form it submits — the normal position a submit button already sits in, so
 * swapping `<Button type="submit">` for `<SubmitButton>` is a drop-in
 * replacement at every existing call site.
 *
 * A form with more than one submit control shares one `pending` flag across
 * all of them (React's own `useFormStatus` behaviour, not something this
 * component adds) — every submit button in a form disables together while
 * any one of them is in flight. That matches this app's forms, which almost
 * always have exactly one.
 */
export function SubmitButton({
  children,
  pendingLabel,
  disabled,
  iconLeft,
  iconRight,
  size = 'md',
  ...rest
}: SubmitButtonProps) {
  const { pending } = useFormStatus()

  return (
    <Button
      {...rest}
      size={size}
      type="submit"
      disabled={Boolean(disabled) || pending}
      iconLeft={pending ? undefined : iconLeft}
      iconRight={pending ? undefined : iconRight}
    >
      {pending ? (
        <>
          <Spinner size={SPINNER_SIZE[size]} />
          {pendingLabel ?? children}
        </>
      ) : (
        children
      )}
    </Button>
  )
}
