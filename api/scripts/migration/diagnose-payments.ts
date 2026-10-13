import { PrismaClient, TransactionType } from '@prisma/client'
import { closeLegacyPool, query } from './legacy/client.js'

/**
 * Read-only comparison of what the legacy ledger says testers are owed against
 * what the new ledger says.
 *
 * Nothing is written to either database, and no tester is named — only counts
 * and sums. It answers three questions the Pending payments screen raised:
 *
 *   1. Which currency does each legacy row really carry? `pmt_in` is empty on
 *      some rows, and the loader fell back to INR for those.
 *   2. What do the `release` rows (a third `pmt_type`) do to what is owed?
 *   3. Which way of adding the legacy rows up reproduces the old screen's
 *      "Outstanding" figure?
 *
 *   npx tsx scripts/migration/diagnose-payments.ts [oldInr oldUsd]
 *
 * Pass the old screen's outstanding figures (major units) to have the matching
 * combinations marked.
 */

const prisma = new PrismaClient()

type Cur = 'INR' | 'USD'
interface LegacyRow {
  pmt_user_id: unknown
  pmt_type: unknown
  pmt_method: unknown
  pmt_amount: unknown
  pmt_in: unknown
}

const norm = (v: unknown): string =>
  typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'bigint' ? `${v}` : ''
const fromSymbol = (v: unknown): Cur | null => {
  const s = norm(v).toLowerCase()
  if (s === '$' || s === 'usd') return 'USD'
  if (s === 'inr' || s === '₹') return 'INR'
  return null
}
const fromMethod = (v: unknown): Cur | null => {
  const m = norm(v).toLowerCase()
  if (m === 'ind_bank_acc' || m === 'paytm') return 'INR'
  if (m === 'non-ind_bank_acc' || m === 'paypal') return 'USD'
  return null
}
const money = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })

async function main(): Promise<void> {
  const [oldInr, oldUsd] = process.argv.slice(2).map(Number)
  const rows = await query<LegacyRow>(
    'SELECT pmt_user_id, pmt_type, pmt_method, pmt_amount, pmt_in FROM `payment_history`',
  )
  console.log(`\nLegacy payment_history: ${rows.length} rows\n`)

  // ── 1 · What the rows carry ───────────────────────────────────────────────
  const shape = new Map<string, { n: number; sum: number }>()
  for (const r of rows) {
    const key = `${norm(r.pmt_type) || '(none)'} | in=${norm(r.pmt_in) || '(empty)'} | method=${norm(r.pmt_method) || '(empty)'}`
    const s = shape.get(key) ?? { n: 0, sum: 0 }
    s.n += 1
    s.sum += Number(r.pmt_amount) || 0
    shape.set(key, s)
  }
  console.log('Rows by type | currency column | method')
  for (const [key, s] of [...shape].sort()) {
    console.log(`  ${key.padEnd(62)} ${String(s.n).padStart(5)} rows  ${money(s.sum).padStart(14)}`)
  }

  // A tester's own currency, taken from the rows that do say: the one used most.
  const votes = new Map<string, { INR: number; USD: number }>()
  for (const r of rows) {
    const c = fromSymbol(r.pmt_in) ?? fromMethod(r.pmt_method)
    if (!c) continue
    const v = votes.get(norm(r.pmt_user_id)) ?? { INR: 0, USD: 0 }
    v[c] += 1
    votes.set(norm(r.pmt_user_id), v)
  }
  const usualCurrency = (id: string): Cur | null => {
    const v = votes.get(id)
    if (!v) return null
    return v.USD > v.INR ? 'USD' : 'INR'
  }
  const mixed = [...votes.values()].filter((v) => v.INR > 0 && v.USD > 0).length
  console.log(`
Testers with rows in both currencies: ${mixed} of ${votes.size}`)

  // What the tester says about themselves: the payout account, then the country.
  const accountCountry = new Map<string, Cur>()
  for (const a of await query<Record<string, unknown>>(
    "SELECT pmt_user_id, pmt_country FROM `payment_acc_details` WHERE pmt_status = 'Active' ORDER BY pmt_acc_updated",
  )) {
    accountCountry.set(
      norm(a.pmt_user_id),
      norm(a.pmt_country).toLowerCase() === 'indian' ? 'INR' : 'USD',
    )
  }
  const profileCountry = new Map<string, Cur>()
  for (const u of await query<Record<string, unknown>>('SELECT usr_id, usr_country FROM `users`')) {
    const c = norm(u.usr_country).toLowerCase()
    if (c) profileCountry.set(norm(u.usr_id), c === 'india' || c === 'in' ? 'INR' : 'USD')
  }
  console.log(
    `Payout accounts: ${accountCountry.size} (${[...accountCountry.values()].filter((c) => c === 'USD').length} non-Indian); profiles with a country: ${profileCountry.size}`,
  )

  // TDS the old system withheld, per tester (rupees).
  const tdsByUser = new Map<string, number>()
  for (const t of await query<Record<string, unknown>>(
    'SELECT tds_user_id, tds_amount FROM `tds_history`',
  )) {
    const id = norm(t.tds_user_id)
    tdsByUser.set(id, (tdsByUser.get(id) ?? 0) + (Number(t.tds_amount) || 0))
  }
  console.log(
    `TDS rows: ${tdsByUser.size} testers, ${money([...tdsByUser.values()].reduce((a, b) => a + b, 0))} in total`,
  )

  // ── 2 · Ways of reading a currency ────────────────────────────────────────
  const policies: Record<string, (r: LegacyRow) => Cur> = {
    'row: pmt_in, else INR (what the loader did)': (r) => fromSymbol(r.pmt_in) ?? 'INR',
    "row: pmt_in, else the tester's usual currency": (r) =>
      fromSymbol(r.pmt_in) ?? usualCurrency(norm(r.pmt_user_id)) ?? 'INR',
    'tester: payout account, else usual currency, else country': (r) => {
      const id = norm(r.pmt_user_id)
      return accountCountry.get(id) ?? usualCurrency(id) ?? profileCountry.get(id) ?? 'INR'
    },
    'tester: profile country only': (r) => profileCountry.get(norm(r.pmt_user_id)) ?? 'INR',
    'tester: usual currency from their rows': (r) => usualCurrency(norm(r.pmt_user_id)) ?? 'INR',
  }

  const near = (got: number, want: number | undefined) =>
    want !== undefined && !Number.isNaN(want) && Math.abs(got - want) <= 1 ? '  <= matches' : ''

  console.log('\nOutstanding (credit − debit) per way of reading the currency')
  for (const [pName, policy] of Object.entries(policies)) {
    const perTester = new Map<string, number>()
    for (const r of rows) {
      const type = norm(r.pmt_type).toLowerCase()
      if (type !== 'credit' && type !== 'debit') continue
      const key = `${norm(r.pmt_user_id)}|${policy(r)}`
      perTester.set(
        key,
        (perTester.get(key) ?? 0) + (type === 'credit' ? 1 : -1) * (Number(r.pmt_amount) || 0),
      )
    }
    console.log(`
  currency = ${pName}`)
    for (const lessTds of [false, true]) {
      for (const positiveOnly of [true, false]) {
        const total: Record<Cur, number> = { INR: 0, USD: 0 }
        for (const [key, balance] of perTester) {
          const [id, cur] = key.split('|') as [string, Cur]
          const owed = balance - (lessTds && cur === 'INR' ? (tdsByUser.get(id) ?? 0) : 0)
          if (!positiveOnly || owed > 0) total[cur] += owed
        }
        const label = `${positiveOnly ? 'positive balances only' : 'all balances netted'}${lessTds ? ', less TDS' : ''}`
        console.log(
          `    ${label.padEnd(40)} INR ${money(total.INR).padStart(12)}${near(total.INR, oldInr)}   USD ${money(total.USD).padStart(10)}${near(total.USD, oldUsd)}`,
        )
      }
    }
  }

  // ── The new ledger ────────────────────────────────────────────────────────
  console.log('\nNew ledger (production rows)')
  const grouped = await prisma.transaction.groupBy({
    by: ['type', 'currency'],
    _count: true,
    _sum: { amountMinor: true, tdsAmountMinor: true },
  })
  for (const g of grouped.sort((a, b) =>
    `${a.type}${a.currency}`.localeCompare(`${b.type}${b.currency}`),
  )) {
    console.log(
      `  ${g.type.padEnd(18)} ${g.currency}  ${String(g._count).padStart(5)} rows  ${money(Number(g._sum.amountMinor ?? 0n) / 100).padStart(14)}  tds ${money(Number(g._sum.tdsAmountMinor ?? 0n) / 100)}`,
    )
  }
  const adjustments = await prisma.transaction.count({
    where: { type: TransactionType.ADJUSTMENT, legacyId: { not: null } },
  })
  console.log(`  legacy rows stored as ADJUSTMENT (unrecognised pmt_type): ${adjustments}`)

  const balances = await prisma.transaction.groupBy({
    by: ['counterpartyId', 'currency', 'type'],
    where: {
      type: { in: [TransactionType.TESTER_EARNING, TransactionType.TESTER_PAYOUT] },
      counterpartyId: { not: null },
    },
    _sum: { amountMinor: true },
  })
  const owed = new Map<string, number>()
  for (const b of balances) {
    const k = `${b.counterpartyId}|${b.currency}`
    const sign = b.type === TransactionType.TESTER_EARNING ? 1 : -1
    owed.set(k, (owed.get(k) ?? 0) + (sign * Number(b._sum.amountMinor ?? 0n)) / 100)
  }
  const newTotal: Record<string, number> = {}
  for (const [k, v] of owed) {
    const currency = k.slice(k.indexOf('|') + 1)
    if (v > 0) newTotal[currency] = (newTotal[currency] ?? 0) + v
  }
  console.log(
    `\nNew system owed: ${Object.entries(newTotal)
      .map(([c, v]) => `${c} ${money(v)}`)
      .join('   ')}`,
  )
  const negatives = [...owed.values()].filter((v) => v < 0)
  console.log(
    `Tester/currency balances below zero (paid more than credited): ${negatives.length}, totalling ${money(negatives.reduce((a, b) => a + b, 0))}`,
  )
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeLegacyPool()
    await prisma.$disconnect()
  })
