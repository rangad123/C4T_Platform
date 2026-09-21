'use client'

import { useActionState, useState } from 'react'
import { Panel } from '@/components/admin/Panel'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { setTemporaryPassword } from './actions'
import type { TemporaryPasswordState } from './temporary-password-state'

const IDLE: TemporaryPasswordState = { status: 'idle' }

/**
 * HR gives an employee a temporary password: for when the invitation link did
 * not work, or the person is standing next to them.
 *
 * The password comes back in the action's result and lives only in this
 * component's state. It is never put in the address bar, where a browser
 * history or a server log would keep it, and it is not shown again once the
 * page is left. It is shown for copying, and that is the only time.
 */
export function TemporaryPasswordPanel({ employeeId }: { employeeId: string }) {
  const [state, submit] = useActionState(setTemporaryPassword, IDLE)
  const [copied, setCopied] = useState(false)

  return (
    <Panel
      title="Sign-in"
      description="Set a temporary password if the invitation link did not work. It signs them out everywhere, cancels any link they have not used, and is shown once. Ask them to change it from their profile after signing in."
    >
      <form
        action={submit}
        onSubmit={() => setCopied(false)}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-5)',
          maxWidth: 420,
        }}
      >
        <input type="hidden" name="employeeId" value={employeeId} />
        <Field
          label="Temporary password"
          htmlFor="temporaryPassword"
          hint="Leave blank to generate one. If you type one, use at least 12 characters."
        >
          <Input
            id="temporaryPassword"
            name="password"
            autoComplete="off"
            minLength={12}
            maxLength={200}
          />
        </Field>

        {state.status === 'error' ? (
          <p
            role="alert"
            style={{
              margin: 0,
              padding: 'var(--space-4) var(--space-5)',
              borderRadius: 'var(--radius-input)',
              background: 'var(--status-error-bg)',
              color: 'var(--status-error-fg)',
              fontSize: 'var(--type-body-sm-size)',
            }}
          >
            {state.message}
          </p>
        ) : null}

        <div>
          <SubmitButton variant="secondary" iconLeft="lock" pendingLabel="Setting…">
            Set temporary password
          </SubmitButton>
        </div>
      </form>

      {state.status === 'done' ? (
        <div
          role="status"
          style={{
            marginTop: 'var(--space-6)',
            padding: 'var(--space-5)',
            borderRadius: 'var(--radius-card)',
            border: '1px solid var(--border-default)',
            background: 'var(--status-success-bg)',
            color: 'var(--status-success-fg)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
            maxWidth: 420,
          }}
        >
          <span style={{ fontSize: 'var(--type-body-sm-size)' }}>
            Temporary password set. This is the only time it is shown.
          </span>
          <code
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--type-body-md-size)',
              fontWeight: 'var(--fw-semibold)',
              wordBreak: 'break-all',
            }}
          >
            {state.password}
          </code>
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(state.password).then(() => setCopied(true))
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      ) : null}
    </Panel>
  )
}
