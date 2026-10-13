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
  const testerCurrency = (id: string): Cur | null => {
    const v = votes.get(id)
    if (!v) return null
    return v.USD > v.INR ? 'USD' : 'INR'
  }
  const mixed = [...votes.values()].filter((v) => v.INR > 0 && v.USD > 0).length
  console.log(`\nTesters with rows in both currencies: ${mixed} of ${votes.size}`)

  // ── 2 · Ways of reading a row's currency ──────────────────────────────────
  const policies: Record<string, (r: LegacyRow) => Cur> = {
    'pmt_in, else INR (what the loader did)': (r) => fromSymbol(r.pmt_in) ?? 'INR',
    'pmt_in, else payment method, else INR': (r) =>
      fromSymbol(r.pmt_in) ?? fromMethod(r.pmt_method) ?? 'INR',
    "pmt_in, else the tester's usual currency, else INR": (r) =>
      fromSymbol(r.pmt_in) ?? testerCurrency(norm(r.pmt_user_id)) ?? 'INR',
  }

  // ── 3 · Ways of adding up what is owed ────────────────────────────────────
  const formulas: Record<
    string,
    (t: { credit: number; release: number; debit: number }) => number
  > = {
    'credit − debit': (t) => t.credit - t.debit,
    'release − debit': (t) => t.release - t.debit,
    'credit + release − debit': (t) => t.credit + t.release - t.debit,
    'credit − release': (t) => t.credit - t.release,
  }

  const near = (got: number, want: number | undefined) =>
    want !== undefined && !Number.isNaN(want) && Math.abs(got - want) <= 1 ? '  <= matches' : ''

  console.log('\nOutstanding per way of reading it (sum of positive per-tester balances)')
  for (const [pName, policy] of Object.entries(policies)) {
    const perTester = new Map<string, { credit: number; release: number; debit: number }>()
    for (const r of rows) {
      const type = norm(r.pmt_type).toLowerCase()
      if (type !== 'credit' && type !== 'release' && type !== 'debit') continue
      const key = `${norm(r.pmt_user_id)}|${policy(r)}`
      const t = perTester.get(key) ?? { credit: 0, release: 0, debit: 0 }
      t[type] += Number(r.pmt_amount) || 0
      perTester.set(key, t)
    }
    console.log(`\n  currency = ${pName}`)
    for (const [fName, formula] of Object.entries(formulas)) {
      const total: Record<Cur, number> = { INR: 0, USD: 0 }
      for (const [key, t] of perTester) {
        const owed = formula(t)
        if (owed > 0) total[key.split('|')[1] as Cur] += owed
      }
      console.log(
        `    ${fName.padEnd(26)} INR ${money(total.INR).padStart(12)}${near(total.INR, oldInr)}   USD ${money(total.USD).padStart(10)}${near(total.USD, oldUsd)}`,
      )
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
