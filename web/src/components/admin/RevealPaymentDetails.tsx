'use client'

import { useState } from 'react'
import { Button } from '@/components/ds/core/Button'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import {
  revealPaymentAccountAction,
  type RevealedPaymentDetails,
} from '@/app/app/admin/testers/[id]/actions'

export interface RevealPaymentDetailsProps {
  paymentAccountId: string
}

const FIELD_LABELS: Record<keyof RevealedPaymentDetails, string> = {
  accountName: 'Account holder name',
  accountNumber: 'Account number',
  ifscCode: 'IFSC code',
  paypalEmail: 'PayPal email',
  paytmNumber: 'Paytm number',
}

/**
 * The one genuinely interactive piece the bank-details panel needs: confirm
 * the ADMIN's OWN password, then show the decrypted fields inline. Kept as a
 * small, self-contained leaf so the rest of the tester detail page stays a
 * Server Component — only this control ships JS.
 *
 * Nothing here persists anywhere. The revealed details live in this
 * component's state only, cleared by unmount, navigation, or the Hide
 * button — never written to a cookie, the URL, or `localStorage`.
 */
export function RevealPaymentDetails({ paymentAccountId }: RevealPaymentDetailsProps) {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [details, setDetails] = useState<RevealedPaymentDetails | null>(null)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    const result = await revealPaymentAccountAction(paymentAccountId, password)
    setPending(false)
    setPassword('')
    if (result.ok) {
      setDetails(result.details)
    } else {
      setError(result.message)
    }
  }

  function handleHide() {
    setDetails(null)
    setOpen(false)
    setError(null)
  }

  if (details) {
    const rows = (Object.keys(FIELD_LABELS) as (keyof RevealedPaymentDetails)[]).filter(
      (key) => details[key],
    )
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
          padding: 'var(--space-4)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-card)',
          background: 'var(--surface-canvas)',
        }}
      >
        {rows.length === 0 ? (
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
            No sensitive fields are on file.
          </span>
        ) : (
          rows.map((key) => (
            <div key={key} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-4)' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
                {FIELD_LABELS[key]}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--type-body-sm-size)',
                  color: 'var(--text-primary)',
                }}
              >
                {details[key]}
              </span>
            </div>
          ))
        )}
        <div>
          <Button type="button" variant="secondary" size="sm" onClick={handleHide}>
            Hide
          </Button>
        </div>
      </div>
    )
  }

  if (!open) {
    return (
      <Button type="button" variant="secondary" size="sm" iconLeft="eye" onClick={() => setOpen(true)}>
        View decrypted details
      </Button>
    )
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: 'flex',
        gap: 'var(--space-3)',
        alignItems: 'flex-end',
        flexWrap: 'wrap',
        padding: 'var(--space-4)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-card)',
        background: 'var(--surface-canvas)',
      }}
    >
      <div style={{ flex: 1, minWidth: 200 }}>
        <Field
          label="Confirm your password"
          htmlFor="reveal-password"
          hint="This reveal is audited."
          error={error ?? undefined}
        >
          <Input
            id="reveal-password"
            type="password"
            required
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      </div>
      <Button type="submit" variant="primary" size="sm" disabled={pending || !password}>
        {pending ? 'Checking…' : 'Reveal'}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  )
}
