'use client'

import { useState } from 'react'
import { Button } from '@/components/ds/core/Button'
import { Spinner } from '@/components/ds/core/Spinner'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import {
  revealFinancialDetailsAction,
  type RevealedFinancialDetails,
} from '@/app/hrms/admin/[id]/actions'

export interface HrRevealFinancialDetailsProps {
  employeeId: string
}

const FIELD_LABELS: Record<keyof RevealedFinancialDetails, string> = {
  panNumber: 'PAN number',
  accountNumber: 'Account number',
  accountName: 'Account holder name',
  ifscCode: 'IFSC code',
}

/**
 * HRMS's own step-up reveal for PAN/bank details — structural copy of
 * `components/admin/RevealPaymentDetails.tsx`. Nothing here persists
 * anywhere: the decrypted fields live only in this component's state,
 * cleared by Hide, unmount, or navigation.
 */
export function HrRevealFinancialDetails({ employeeId }: HrRevealFinancialDetailsProps) {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [details, setDetails] = useState<RevealedFinancialDetails | null>(null)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    const result = await revealFinancialDetailsAction(employeeId, password)
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
    const rows = (Object.keys(FIELD_LABELS) as (keyof RevealedFinancialDetails)[]).filter(
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
            No financial details are on file.
          </span>
        ) : (
          rows.map((key) => (
            <div
              key={key}
              style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-4)' }}
            >
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
      <Button
        type="button"
        variant="secondary"
        size="sm"
        iconLeft="eye"
        onClick={() => setOpen(true)}
      >
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
        {pending ? (
          <>
            <Spinner size={16} />
            Checking…
          </>
        ) : (
          'Reveal'
        )}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  )
}
