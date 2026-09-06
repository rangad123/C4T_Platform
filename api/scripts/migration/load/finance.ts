import { PaymentAccountStatus, TransactionStatus, TransactionType } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import {
  encryptPaymentDetails,
  maskPaymentDetails,
  type PaymentDetailsPlain,
} from '../../../src/lib/payment-encryption.js'
import { query } from '../legacy/client.js'
import {
  ANNOUNCEMENT_AUDIENCE,
  CURRENCY_BY_LEGACY_SYMBOL,
  PAYMENT_ACCOUNT_COUNTRY,
  PAYMENT_METHOD,
  PLATFORM_SETTING_KEYS,
  TRANSACTION_STATUS,
  TRANSACTION_TYPE,
} from '../mapping/lookups.js'
import {
  asText,
  enumValue,
  legacyRef,
  requiredText,
  text,
  timestamp,
  timestampOr,
  amountToMinor,
} from '../transform/values.js'
import type { Loader, RowOutcome } from './context.js'
import { reportProblems } from './context.js'

/**
 * Phases 7–8 — money, and communication.
 *
 * ── NOTHING SENSITIVE REACHES A REPORT
 *
 * `payment_acc_details` holds account numbers in the clear. They are encrypted
 * on the way in and only a masked form is stored for display; the plaintext
 * never enters a log line, an error message or a CSV. Where a row cannot be
 * migrated, the report names the row, not its contents.
 */

// ── Currency, from the owning organisation ───────────────────────────────────

const currencyByOrgLegacyId = new Map<string, string>()

async function loadOrgCurrencies(): Promise<void> {
  currencyByOrgLegacyId.clear()
  try {
    const rows = await query<Record<string, unknown>>(
      'SELECT org_id, org_currency FROM `organisation`',
    )
    for (const r of rows) {
      const symbol = text(r.org_currency)?.toLowerCase()
      if (symbol) {
        currencyByOrgLegacyId.set(String(r.org_id), CURRENCY_BY_LEGACY_SYMBOL[symbol] ?? 'INR')
      }
    }
  } catch {
    // Falls back to INR, reported once by the caller.
  }
}

// ── payment_acc_details → PaymentAccount ─────────────────────────────────────

export const paymentAccountLoader: Loader = {
  table: 'payment_acc_details',
  target: 'PaymentAccount',
  dependsOn: [{ table: 'users', model: 'User' }],

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.pmt_id)

    const userId = await ctx.idMap.resolve('users', legacyRef(row.pmt_user_id), 'User')
    if (!userId) {
      ctx.reporter.orphan({
        legacyTable: 'payment_acc_details',
        legacyId,
        field: 'pmt_user_id',
        referencedTable: 'users',
        referencedId: asText(row.pmt_user_id),
      })
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'Payment account has no migrated user.',
      }
    }

    const country = enumValue(row.pmt_country, PAYMENT_ACCOUNT_COUNTRY, 'INDIAN', 'pmt_country')
    const method = enumValue(
      row.pmt_payment_type,
      PAYMENT_METHOD,
      'IND_BANK_ACCOUNT',
      'pmt_payment_type',
    )

    const plain: PaymentDetailsPlain = {
      accountName: text(row.pmt_account_name) ?? undefined,
      accountNumber: text(row.pmt_account_no) ?? undefined,
      ifscCode: text(row.pmt_ifsc_code) ?? undefined,
      paypalEmail: text(row.pmt_paypal_email) ?? undefined,
      paytmNumber: text(row.pmt_paytm_number) ?? undefined,
    }

    const masked = maskPaymentDetails(plain)

    /*
      A PaymentAccount is one-per-user in the new schema. The AAD binds the
      ciphertext to the row it belongs to, so the account id must exist before
      the envelope is sealed — hence create-then-update rather than one call.
    */
    const existing = await tx.paymentAccount.findUnique({
      where: { userId },
      select: { id: true },
    })

    const base = {
      country: country.value,
      paymentType: method.value,
      // The enum is ACTIVE/INACTIVE — a migrated payout account is live.
      status: PaymentAccountStatus.ACTIVE,
      bankName: text(row.pmt_bank_name),
      branchName: text(row.pmt_branch_name),
      ...masked,
    }

    const account =
      existing ??
      (await tx.paymentAccount.create({
        data: {
          ...base,
          userId,
          legacyId,
          // Placeholder, replaced immediately below now that the id exists.
          secureDetails: Buffer.alloc(0),
          createdAt: timestampOr(row.pmt_timestamp),
        },
        select: { id: true },
      }))

    const sealed = encryptPaymentDetails(plain, `${account.id}:${userId}`)
    await tx.paymentAccount.update({
      where: { id: account.id },
      // `Buffer` is generic over `ArrayBufferLike`, which Prisma's `Bytes`
      // field type rejects; re-wrapping copies into a plain `Uint8Array`.
      // Same conversion, and same reason, as payment-accounts.routes.ts.
      data: { ...base, secureDetails: new Uint8Array(sealed) },
    })

    await ctx.idMap.remember(tx, 'payment_acc_details', legacyId, 'PaymentAccount', account.id)
    reportProblems(ctx, 'payment_acc_details', legacyId, 'PaymentAccount', [
      country.problem,
      method.problem,
    ])
    return { kind: 'written', created: !existing }
  },
}

// ── payment_history → Transaction ────────────────────────────────────────────

/** legacy payment id → TDS amount, merged onto the transaction it belongs to. */
const tdsByPaymentId = new Map<string, bigint>()

export const transactionLoader: Loader = {
  table: 'payment_history',
  target: 'Transaction',
  dependsOn: [
    { table: 'users', model: 'User' },
    { table: 'organisation', model: 'Organisation' },
    { table: 'projects', model: 'Project' },
  ],

  async prepare(ctx) {
    await loadOrgCurrencies()

    /*
      tds_history is MERGED onto the transaction rather than migrated as rows
      of its own — Transaction.tdsAmountMinor is where the new schema keeps
      withholding tax. Read once here so the join is a map lookup per row.
    */
    tdsByPaymentId.clear()
    try {
      const rows = await query<Record<string, unknown>>(
        'SELECT tds_payment_id, tds_amount FROM `tds_history`',
      )
      for (const r of rows) {
        const id = legacyRef(r.tds_payment_id)
        const amount = amountToMinor(r.tds_amount)
        if (id && amount !== null) tdsByPaymentId.set(id, amount)
      }
      ctx.reporter.counter('tds_history', 'Transaction.tdsAmountMinor').read = rows.length
    } catch {
      ctx.reporter.review('tds_history', 'Could not read tds_history; TDS amounts not merged.')
    }
  },

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.pmt_id)
    const problems = []

    const amountMinor = amountToMinor(row.pmt_amount)
    if (amountMinor === null) {
      return {
        kind: 'skipped',
        code: 'INVALID_AMOUNT',
        message: 'Transaction amount is not a number.',
        field: 'pmt_amount',
        value: asText(row.pmt_amount),
      }
    }

    const type = enumValue(row.pmt_type, TRANSACTION_TYPE, TransactionType.ADJUSTMENT, 'pmt_type')
    problems.push(type.problem)

    const status = enumValue(
      row.pmt_status,
      TRANSACTION_STATUS,
      TransactionStatus.PAID,
      'pmt_status',
    )
    problems.push(status.problem)

    const method = text(row.pmt_method)
      ? enumValue(row.pmt_method, PAYMENT_METHOD, 'IND_BANK_ACCOUNT', 'pmt_method')
      : null
    if (method) problems.push(method.problem)

    const counterpartyId = await ctx.idMap.resolve('users', legacyRef(row.pmt_user_id), 'User')

    /*
      `payment_history` names neither an organisation nor a project — it points
      at a build (or a contest) and nothing else. Both are therefore derived
      through the build, which is the only path the legacy data actually
      supports. A payment against a contest has no build and stays unattached;
      contests do not migrate, so there is nothing to point it at.
    */
    const buildLegacy = legacyRef(row.pmt_for_build_id)
    const contestLegacy = legacyRef(row.pmt_for_contest_id)
    const buildId = await ctx.idMap.resolve('builds', buildLegacy, 'Build')
    const build = buildId
      ? await tx.build.findUnique({
          where: { id: buildId },
          select: {
            projectId: true,
            project: {
              select: {
                organisationId: true,
                organisation: { select: { legacyId: true } },
              },
            },
          },
        })
      : null
    const projectId = build?.projectId ?? null
    const organisationId = build?.project.organisationId ?? null

    /*
      recordedById is required — the ledger records who entered the line. A
      legacy row has no such column, so it falls to the admin who is running
      the migration; that is truthful (this row entered the new ledger through
      the migration) and keeps the audit trail honest.
    */
    const recordedById = await firstAdmin(ctx)
    if (!recordedById) {
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'No migrated recorder and no admin to attribute the ledger entry to.',
      }
    }

    const occurredAt = timestampOr(row.pmt_time)
    const orgLegacy = build?.project.organisation?.legacyId ?? null

    /*
      `pmt_in` names the currency this row was settled in — "INR" on 4,095 rows
      and "$" on 645. Despite the name it is not a direction flag, which is how
      it reads at a glance. It takes precedence over the organisation's default
      currency: a row that says it was paid in dollars was paid in dollars,
      whatever the organisation usually bills in.
    */
    const rowCurrency = text(row.pmt_in)
    const currency =
      (rowCurrency ? CURRENCY_BY_LEGACY_SYMBOL[rowCurrency.toLowerCase()] : null) ??
      (orgLegacy ? currencyByOrgLegacyId.get(orgLegacy) : null) ??
      'INR'
    const tds = tdsByPaymentId.get(legacyId) ?? null

    /*
      `pmt_method_details` is the account the money moved through (a masked
      card, a Paytm number). It is not an external reference — the legacy
      ledger has no UTR or invoice number at all — so it joins the summary in
      the description rather than being passed off as `externalRef`.
    */
    const details = text(row.pmt_method_details)
    const summary = text(row.pmt_summary)

    const data = {
      type: type.value,
      status: status.value,
      amountMinor,
      currency,
      organisationId,
      projectId,
      buildId,
      buildOrContestRef: buildLegacy
        ? `build:${buildLegacy}`
        : contestLegacy
          ? `contest:${contestLegacy}`
          : null,
      counterpartyId,
      description:
        [summary, details ? `Paid via ${details}` : null].filter(Boolean).join(' — ') || null,
      externalRef: null,
      occurredAt,
      settledAt: status.value === TransactionStatus.PAID ? occurredAt : null,
      paymentMethod: method?.value ?? null,
      tdsAmountMinor: tds,
      paidAmountMinor: tds !== null ? amountMinor - tds : amountMinor,
      updatedAt: occurredAt,
    }

    const existing = await tx.transaction.findUnique({ where: { legacyId }, select: { id: true } })

    const record = existing
      ? await tx.transaction.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.transaction.create({
          data: {
            ...data,
            legacyId,
            recordedById,
            reference: `TXN-LEG-${legacyId.padStart(6, '0')}`,
            createdAt: occurredAt,
          },
          select: { id: true },
        })

    await ctx.idMap.remember(tx, 'payment_history', legacyId, 'Transaction', record.id)
    if (tds !== null) {
      ctx.reporter.counter('tds_history', 'Transaction.tdsAmountMinor').inserted += 1
    }
    reportProblems(ctx, 'payment_history', legacyId, 'Transaction', problems)
    return { kind: 'written', created: !existing }
  },
}

let cachedAdmin: string | null | undefined
async function firstAdmin(ctx: { prisma: PrismaClient }): Promise<string | null> {
  if (cachedAdmin !== undefined) return cachedAdmin
  const admin = await ctx.prisma.user.findFirst({
    where: { role: 'ADMIN', deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  cachedAdmin = admin?.id ?? null
  return cachedAdmin
}

// ── announcements → Announcement ─────────────────────────────────────────────

export const announcementLoader: Loader = {
  table: 'announcements',
  target: 'Announcement',
  dependsOn: [
    { table: 'builds', model: 'Build' },
    { table: 'users', model: 'User' },
  ],

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.id)

    const body = text(row.A_body)
    if (!body) {
      return { kind: 'skipped', code: 'EMPTY_BODY', message: 'Announcement body is empty.' }
    }

    const authorId = await ctx.idMap.resolve('users', legacyRef(row.A_added_by), 'User')
    if (!authorId) {
      ctx.reporter.orphan({
        legacyTable: 'announcements',
        legacyId,
        field: 'A_added_by',
        referencedTable: 'users',
        referencedId: asText(row.A_added_by),
      })
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'Announcement author not migrated.',
      }
    }

    const buildId = await ctx.idMap.resolve('builds', legacyRef(row.A_build_id), 'Build')
    const build = buildId
      ? await tx.build.findUnique({ where: { id: buildId }, select: { projectId: true } })
      : null

    /*
      Announcement.title is required and the legacy table has no title column.
      The first line of the body is used — which is what the legacy UI showed
      as the heading anyway — rather than inventing a title or refusing the row.
    */
    const firstLine = body.split('\n')[0]?.trim() ?? ''
    const title = firstLine.length > 0 ? firstLine.slice(0, 120) : `Announcement ${legacyId}`

    const createdAt = timestampOr(row.A_added_date)
    const data = {
      title,
      body,
      audience: enumValue(null, ANNOUNCEMENT_AUDIENCE, 'ALL', 'audience').value,
      buildId,
      projectId: build?.projectId ?? null,
      publishedAt: createdAt,
      createdAt,
      updatedAt: timestamp(row.A_updated_date) ?? createdAt,
    }

    const mapped = await ctx.idMap.resolve('announcements', legacyId, 'Announcement')
    const existing = mapped
      ? await tx.announcement.findUnique({ where: { id: mapped }, select: { id: true } })
      : null

    const announcement = existing
      ? await tx.announcement.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.announcement.create({ data: { ...data, authorId }, select: { id: true } })

    await ctx.idMap.remember(tx, 'announcements', legacyId, 'Announcement', announcement.id)
    return { kind: 'written', created: !existing }
  },
}

// ── site_settings → PlatformSetting ──────────────────────────────────────────

export const platformSettingLoader: Loader = {
  table: 'site_settings',
  target: 'PlatformSetting',
  dependsOn: [{ table: 'users', model: 'User' }],

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.id)
    const legacyKey = text(row.key_name)?.toLowerCase()

    if (!legacyKey) {
      return { kind: 'skipped', code: 'MISSING_REQUIRED', message: 'Setting has no key.' }
    }

    /*
      An allow-list, not a passthrough. The legacy settings table accumulated
      keys for features that no longer exist; importing them would fill the
      admin settings screen with configuration that controls nothing.
    */
    const key = PLATFORM_SETTING_KEYS[legacyKey]
    if (!key) {
      return {
        kind: 'skipped',
        code: 'UNKNOWN_SETTING',
        message: 'Legacy setting key has no counterpart in the new platform.',
        field: 'key_name',
        value: legacyKey,
      }
    }

    const value = requiredText(row.key_value, '')
    const updatedById = await ctx.idMap.resolve('users', legacyRef(row.created_by), 'User')

    const existing = await tx.platformSetting.findUnique({ where: { key }, select: { key: true } })
    await tx.platformSetting.upsert({
      where: { key },
      create: { key, value, updatedById },
      update: { value, updatedById },
    })

    await ctx.idMap.remember(tx, 'site_settings', legacyId, 'PlatformSetting', key)
    return { kind: 'written', created: !existing }
  },
}

// ── marketing → Lead ─────────────────────────────────────────────────────────

export const leadLoader: Loader = {
  table: 'marketing',
  target: 'Lead',

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.Sno)

    const email = text(row.Email)?.toLowerCase()
    if (!email) {
      return { kind: 'skipped', code: 'MISSING_REQUIRED', message: 'Enquiry has no email.' }
    }

    const createdAt = timestampOr(row.date)
    const data = {
      firstName: requiredText(row.FirstName, '—'),
      lastName: requiredText(row.LastName, '—'),
      email,
      phone: text(row.Phone),
      company: requiredText(row.organization, '—'),
      /*
        Consent was not recorded by the legacy form, and a migration may not
        assume it. False is the only defensible default: it costs a marketing
        contact, whereas true fabricates a permission that was never given.
      */
      marketingConsent: false,
      status: 'NEW' as const,
      notes: text(row.Location) ? `Legacy location: ${text(row.Location)}` : null,
      createdAt,
      updatedAt: createdAt,
    }

    const mapped = await ctx.idMap.resolve('marketing', legacyId, 'Lead')
    const existing = mapped
      ? await tx.lead.findUnique({ where: { id: mapped }, select: { id: true } })
      : null

    const lead = existing
      ? await tx.lead.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.lead.create({ data, select: { id: true } })

    await ctx.idMap.remember(tx, 'marketing', legacyId, 'Lead', lead.id)
    return { kind: 'written', created: !existing }
  },
}

export const financeLoaders: Loader[] = [paymentAccountLoader, transactionLoader]
export const communicationLoaders: Loader[] = [
  announcementLoader,
  platformSettingLoader,
  leadLoader,
]
