'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'

export type PaymentType = 'IND_BANK_ACCOUNT' | 'NON_IND_BANK_ACCOUNT' | 'PAYPAL' | 'PAYTM'

interface PaymentMethodFieldsProps {
  defaultPaymentType: PaymentType
  typeOptions: readonly { value: string; label: string }[]
  /** The Country field — stays server-rendered; this just lays it out next to Payout method. */
  countryField: ReactNode
}

const FIELD_GRID = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: 'var(--space-4)',
} as const

/**
 * Only the fields the selected payout method actually uses.
 *
 * The alternative — every field always visible with a paragraph asking the
 * tester to "fill in the section that matches your payout method above" and
 * ignore the rest — put the form's own logic into a sentence instead of the
 * layout. `paymentType` has to live in client state to drive that, which is
 * why this one piece of an otherwise server-rendered form is a client
 * component; the surrounding `<form>` and its Server Action are untouched.
 */
export function PaymentMethodFields({
  defaultPaymentType,
  typeOptions,
  countryField,
}: PaymentMethodFieldsProps) {
  const [paymentType, setPaymentType] = useState<PaymentType>(defaultPaymentType)
  const isBank = paymentType === 'IND_BANK_ACCOUNT' || paymentType === 'NON_IND_BANK_ACCOUNT'

  return (
    <>
      <div style={FIELD_GRID}>
        {countryField}
        <Field label="Payout method" htmlFor="paymentType">
          <Select
            id="paymentType"
            name="paymentType"
            value={paymentType}
            onChange={(event) => setPaymentType(event.target.value as PaymentType)}
            options={typeOptions}
          />
        </Field>
      </div>

      {isBank ? (
        <div style={FIELD_GRID}>
          <Field label="Account holder name" htmlFor="accountName">
            <Input id="accountName" name="accountName" maxLength={255} />
          </Field>
          <Field label="Account number" htmlFor="accountNumber" required>
            <Input id="accountNumber" name="accountNumber" maxLength={25} required />
          </Field>
          <Field label="Bank name" htmlFor="bankName">
            <Input id="bankName" name="bankName" maxLength={255} />
          </Field>
          <Field label="Branch name" htmlFor="branchName">
            <Input id="branchName" name="branchName" maxLength={255} />
          </Field>
          {paymentType === 'IND_BANK_ACCOUNT' ? (
            <Field label="IFSC code" htmlFor="ifscCode">
              <Input
                id="ifscCode"
                name="ifscCode"
                maxLength={25}
                style={{ textTransform: 'uppercase' }}
              />
            </Field>
          ) : null}
        </div>
      ) : null}

      {paymentType === 'PAYPAL' ? (
        <div style={FIELD_GRID}>
          <Field label="PayPal email" htmlFor="paypalEmail" required>
            <Input id="paypalEmail" name="paypalEmail" type="email" maxLength={255} required />
          </Field>
        </div>
      ) : null}

      {paymentType === 'PAYTM' ? (
        <div style={FIELD_GRID}>
          <Field label="Paytm number" htmlFor="paytmNumber" required>
            <Input id="paytmNumber" name="paytmNumber" maxLength={10} required />
          </Field>
        </div>
      ) : null}
    </>
  )
}
