'use client'

import { useState } from 'react'
import { Field } from '@/components/ds/forms/Field'
import { Select } from '@/components/ds/forms/Select'
import { Button } from '@/components/ds/core/Button'

interface Option {
  value: string
  label: string
}

/**
 * Client-side only so the period selector can hide the field it does not use.
 *
 * Both Month and Quarter used to render at once, and a plain GET form submits
 * every field it has: choosing Quarterly without also noticing the separate
 * Quarter dropdown sent `month=4&quarter=`, which the API rejects. The form
 * now shows exactly one of them and marks it required, so the invalid
 * combination cannot be submitted in the first place.
 */
export function ReportForm({
  financialYear,
  yearOptions,
  monthOptions,
  reportTypes,
  periods,
  quarters,
}: {
  financialYear: string
  yearOptions: readonly Option[]
  monthOptions: readonly Option[]
  reportTypes: readonly Option[]
  periods: readonly Option[]
  quarters: readonly Option[]
}) {
  const [period, setPeriod] = useState('MONTHLY')

  return (
    <form
      method="get"
      action="/admin/reports/download"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 'var(--space-5)',
        alignItems: 'end',
      }}
    >
      <Field label="Financial year" htmlFor="financialYear" required>
        <Select
          id="financialYear"
          name="financialYear"
          required
          defaultValue={financialYear}
          options={yearOptions}
        />
      </Field>
      <Field label="Report type" htmlFor="reportType" required>
        <Select id="reportType" name="reportType" required options={reportTypes} />
      </Field>
      <Field label="Report period" htmlFor="period" required>
        <Select
          id="period"
          name="period"
          required
          value={period}
          onChange={(event) => setPeriod(event.target.value)}
          options={periods}
        />
      </Field>

      {period === 'MONTHLY' ? (
        <Field label="Month" htmlFor="month" required>
          <Select id="month" name="month" required options={monthOptions} />
        </Field>
      ) : null}

      {period === 'QUARTERLY' ? (
        <Field label="Quarter" htmlFor="quarter" required>
          <Select
            id="quarter"
            name="quarter"
            required
            options={quarters}
            placeholder="Select quarter"
          />
        </Field>
      ) : null}

      <Button type="submit" variant="primary" iconLeft="download">
        Generate report
      </Button>
    </form>
  )
}
