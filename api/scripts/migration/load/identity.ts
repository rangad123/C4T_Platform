import { OrgMemberRole, Role, TesterStatus, UserStatus } from '@prisma/client'
import { ISO_COUNTRY_CODES } from '../../../src/lib/iso-countries.js'
import { detectLegacyAlgo } from '../../../src/lib/legacy-password.js'
import type { LegacyRow } from '../legacy/client.js'
import { query } from '../legacy/client.js'
import {
  ORG_MEMBER_ROLE_BY_LEGACY_ID,
  ROLE_BY_LEGACY_ID,
  ROLE_BY_NAME,
  USER_STATUS,
} from '../mapping/lookups.js'
import {
  asText,
  bool,
  countryCode,
  email as parseEmail,
  enumValue,
  int,
  legacyRef,
  list,
  slugify,
  text,
  timestamp,
  timestampOr,
  url as parseUrl,
} from '../transform/values.js'
import type { Loader, LoadContext, RowOutcome } from './context.js'
import { reportProblems } from './context.js'

/**
 * Phase 2 — identity: organisations, users, membership, invitations.
 *
 * Everything downstream resolves through these, so they run before anything
 * else that references a person or a company.
 */

// ── Country resolution ───────────────────────────────────────────────────────

/**
 * `usr_country` is `varchar(50)` and holds names, codes and junk. The API's
 * own ISO set is the authority — a second list here would be exactly the
 * duplicate source the platform rules forbid.
 */
const COUNTRY_BY_NAME = new Map<string, string>()

function buildCountryIndex(): void {
  if (COUNTRY_BY_NAME.size > 0) return
  const display = new Intl.DisplayNames(['en'], { type: 'region' })
  for (const code of ISO_COUNTRY_CODES) {
    try {
      const name = display.of(code)
      if (name) COUNTRY_BY_NAME.set(name.toLowerCase(), code)
    } catch {
      // A code Intl does not know still stays valid as a code.
    }
  }
  // Spellings the legacy data uses that Intl does not return.
  const aliases: Record<string, string> = {
    usa: 'US',
    'united states of america': 'US',
    uk: 'GB',
    'great britain': 'GB',
    england: 'GB',
    uae: 'AE',
    'south korea': 'KR',
    russia: 'RU',
    vietnam: 'VN',
  }
  for (const [name, code] of Object.entries(aliases)) COUNTRY_BY_NAME.set(name, code)
}

function resolveCountry(value: unknown) {
  buildCountryIndex()
  return countryCode(
    value,
    (code) => ISO_COUNTRY_CODES.has(code),
    (name) => COUNTRY_BY_NAME.get(name.trim().toLowerCase()) ?? null,
  )
}

// ── organisation → Organisation ──────────────────────────────────────────────

export const organisationLoader: Loader = {
  table: 'organisation',
  target: 'Organisation',

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.org_id)
    const name = text(row.org_title)
    if (!name) {
      return { kind: 'skipped', code: 'MISSING_REQUIRED', message: 'org_title is empty' }
    }

    const problems = []
    /*
      The legacy `organisation` table records no country — it has an address
      blob and a currency, and that is all. Left null rather than inferred
      from `org_currency`, which would guess India for every INR account
      including the ones billed in INR from elsewhere.
    */
    const country = resolveCountry(null)
    problems.push(country.problem)

    const createdAt = timestampOr(row.org_created_date)
    /*
      `org_update_date` defaults to the zero date in the dump, which is not a
      legal instant. `timestamp()` maps it to null and we fall back to
      createdAt rather than to "now" — stamping every migrated org with the
      migration's own clock would destroy the update history.
    */
    const updatedAt = timestamp(row.org_update_date) ?? createdAt

    // Slug must be unique. Legacy titles collide, so disambiguate with the
    // legacy id rather than silently merging two different companies.
    const base = slugify(name) || `org-${legacyId}`
    const existingSlug = await tx.organisation.findFirst({
      // NULL-safe on purpose. `legacy_id <> '42'` is NULL — not true — for a
      // row whose legacyId is NULL, so a bare `not` matches no organisation
      // created on the new platform. The clash would then surface as a unique
      // constraint violation at insert time instead of a disambiguated slug.
      where: { slug: base, OR: [{ legacyId: null }, { legacyId: { not: legacyId } }] },
      select: { id: true },
    })
    const slug = existingSlug ? `${base}-${legacyId}` : base

    const data = {
      name,
      slug,
      addressLine1: text(row.org_address),
      notes: text(row.org_desc),
      countryCode: country.value,
      createdAt,
      updatedAt,
    }

    const existing = await tx.organisation.findUnique({
      where: { legacyId },
      select: { id: true },
    })

    const record = existing
      ? await tx.organisation.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.organisation.create({
          data: { ...data, legacyId, status: 'ACTIVE' },
          select: { id: true },
        })

    await ctx.idMap.remember(tx, 'organisation', legacyId, 'Organisation', record.id)
    reportProblems(ctx, 'organisation', legacyId, 'Organisation', problems)

    /*
      Money columns are deliberately not copied. org_wallet_balance,
      locked_amount, credit_rate and test_manager_fee have no destination —
      the new platform derives every balance from the Transaction ledger, and
      writing a second stored figure would create a source that disagrees with
      it the first time a transaction is recorded.
    */
    const balance = text(row.org_wallet_balance)
    if (balance && balance !== '0') {
      ctx.reporter.problem({
        legacyTable: 'organisation',
        legacyId,
        targetModel: 'Organisation',
        code: 'NO_DESTINATION',
        field: 'org_wallet_balance',
        value: balance,
        message:
          'Stored wallet balance not carried over; the new balance is computed from the transaction ledger.',
        action: 'REVIEW_REQUIRED',
      })
    }

    return { kind: 'written', created: !existing }
  },
}

// ── users → User + TesterProfile ─────────────────────────────────────────────

/** Legacy role id → new Role, falling back to the role name, then USER. */
function resolveRole(row: LegacyRow, roleNames: Map<string, string>) {
  const roleId = legacyRef(row.usr_role_id)
  if (roleId) {
    const byId = ROLE_BY_LEGACY_ID[roleId]
    if (byId) return { value: byId, problem: null }
    const name = roleNames.get(roleId)
    if (name) return enumValue(name, ROLE_BY_NAME, Role.USER, 'usr_role_id')
  }
  return {
    value: Role.USER,
    problem: {
      field: 'usr_role_id',
      value: asText(row.usr_role_id),
      problem: 'unknown legacy role; defaulted to USER',
    },
  }
}

const roleNames = new Map<string, string>()

export const userLoader: Loader = {
  table: 'users',
  target: 'User',
  dependsOn: [{ table: 'organisation', model: 'Organisation' }],

  async prepare() {
    roleNames.clear()
    try {
      const rows = await query<{ rol_id: string; rol_name: string }>(
        'SELECT rol_id, rol_name FROM `roles`',
      )
      for (const r of rows) roleNames.set(String(r.rol_id), String(r.rol_name))
    } catch {
      // Falls back to ROLE_BY_LEGACY_ID; reported per row if that misses too.
    }
  },

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.usr_id)
    const problems = []

    const email = parseEmail(row.usr_email)
    if (!email.value) {
      return {
        kind: 'skipped',
        code: 'INVALID_EMAIL',
        message: 'Cannot migrate a user without a usable email — it is the login identity.',
        field: 'usr_email',
        value: asText(row.usr_email),
      }
    }

    /*
      Email is unique in the new schema and was NOT unique in the legacy one.
      A second row with an address already taken by a different legacy user is
      a genuine duplicate account; merging them would silently give one person
      another's history, so the later row is skipped and reported for a human
      to reconcile.
    */
    const clash = await tx.user.findFirst({
      // NULL-safe on purpose — see the slug guard above. A native account
      // (legacyId NULL) holding this address is the commonest clash of all:
      // the seeded admin owns admin@crowd4test.com, which legacy usr_id=11
      // also claims. A bare `not` misses it and the row dies on the unique
      // index instead of being skipped and reported.
      where: { email: email.value, OR: [{ legacyId: null }, { legacyId: { not: legacyId } }] },
      select: { legacyId: true },
    })
    if (clash) {
      return {
        kind: 'skipped',
        code: 'DUPLICATE_EMAIL',
        message: `Email already migrated from users.usr_id=${clash.legacyId ?? '(non-legacy row)'}`,
        field: 'usr_email',
        value: email.value,
      }
    }

    const role = resolveRole(row, roleNames)
    problems.push(role.problem)

    const status = enumValue(row.usr_active, USER_STATUS, UserStatus.DEACTIVATED, 'usr_active')
    problems.push(status.problem)

    const country = resolveCountry(row.usr_country)
    problems.push(country.problem)

    const createdAt = timestampOr(row.usr_add_date)
    const updatedAt = timestamp(row.usr_upd_date) ?? createdAt

    /*
      Password: carried across, never reset.

      `usr_password` is varchar(50) — too narrow for bcrypt (60) or Argon2id
      (~95), so it is an unsalted MD5 or SHA-1 hex digest. `detectLegacyAlgo`
      decides which by length; anything that is not clean hex is not a digest
      we can verify, so the account migrates with no password and must use the
      reset flow rather than being locked out with a hash nothing can check.
    */
    const rawHash = text(row.usr_password)
    const algo = rawHash ? detectLegacyAlgo(rawHash) : null
    if (rawHash && !algo) {
      problems.push({
        field: 'usr_password',
        // Never the hash itself.
        value: `(${rawHash.length} chars)`,
        problem: 'unrecognised password format; account migrated without a password',
      })
    }

    const userData = {
      email: email.value,
      firstName: text(row.usr_firstname),
      lastName: text(row.usr_lastname),
      phone: text(row.usr_phone),
      countryCode: country.value,
      role: role.value,
      status: status.value,
      passwordHash: algo ? rawHash : null,
      passwordAlgo: algo ?? undefined,
      lastLoginAt: timestamp(row.usr_last_login),
      emailVerifiedAt: status.value === UserStatus.ACTIVE ? createdAt : null,
      createdAt,
      updatedAt,
    }

    const existing = await tx.user.findUnique({ where: { legacyId }, select: { id: true } })
    const user = existing
      ? await tx.user.update({ where: { id: existing.id }, data: userData, select: { id: true } })
      : await tx.user.create({ data: { ...userData, legacyId }, select: { id: true } })

    await ctx.idMap.remember(tx, 'users', legacyId, 'User', user.id)

    // ── TesterProfile ───────────────────────────────────────────────────────
    // Created for testers, and for anyone carrying tester-shaped data — the
    // legacy role is not always set correctly on older accounts.
    const hasTesterData =
      role.value === Role.TESTER ||
      Boolean(text(row.usr_skill_set)) ||
      Boolean(text(row.usr_exp_years)) ||
      Boolean(text(row.usr_agreement_file))

    if (hasTesterData) {
      const linkedin = parseUrl(row.usr_linkedin, 'usr_linkedin')
      problems.push(linkedin.problem)

      const profileData = {
        status:
          bool(row.usr_agreement_verification, false) || status.value === UserStatus.ACTIVE
            ? TesterStatus.VERIFIED
            : TesterStatus.APPLIED,
        bio: null,
        experienceYears: int(row.usr_exp_years),
        city: text(row.usr_city),
        countryCode: country.value,
        gender: text(row.usr_gender),
        ageGroup: text(row.usr_age),
        lookingFor: text(row.usr_looking_for),
        skype: text(row.usr_skype),
        linkedinUrl: linkedin.value,
        profession: text(row.usr_desig),
        ndaAcceptedAt: text(row.usr_agreement_verification) === 'verified' ? createdAt : null,
        createdAt,
        updatedAt,
      }

      const profile = await tx.testerProfile.upsert({
        where: { userId: user.id },
        create: { ...profileData, userId: user.id, legacyId },
        update: profileData,
        select: { id: true },
      })
      await ctx.idMap.remember(tx, 'users', legacyId, 'TesterProfile', profile.id)

      // usr_skill_set is a comma-separated list of legacy skill ids.
      const skillIds = list(row.usr_skill_set)
      for (const skillLegacyId of skillIds) {
        const skillId = await ctx.idMap.resolve('skills', skillLegacyId, 'Skill')
        if (!skillId) {
          ctx.reporter.orphan({
            legacyTable: 'users',
            legacyId,
            field: 'usr_skill_set',
            referencedTable: 'skills',
            referencedId: skillLegacyId,
          })
          continue
        }
        await tx.testerSkill.upsert({
          where: { testerProfileId_skillId: { testerProfileId: profile.id, skillId } },
          create: { testerProfileId: profile.id, skillId },
          update: {},
        })
      }

      // usr_lang is a comma-separated list of language names or codes.
      for (const code of list(row.usr_lang)) {
        const normalised = code.slice(0, 8).toLowerCase()
        await tx.testerLanguage.upsert({
          where: {
            testerProfileId_code: { testerProfileId: profile.id, code: normalised },
          },
          create: { testerProfileId: profile.id, code: normalised, proficiency: 'PROFESSIONAL' },
          update: {},
        })
      }
    }

    // Columns with nowhere to go — recorded once per affected row.
    for (const field of ['jira_username', 'jira_url', 'usr_apple', 'export'] as const) {
      if (text(row[field])) {
        ctx.reporter.problem({
          legacyTable: 'users',
          legacyId,
          targetModel: 'User',
          code: 'NO_DESTINATION',
          field,
          // jira_password is never read at all, let alone reported.
          value: field === 'jira_username' ? '(present)' : String(row[field]),
          message: 'No equivalent field in the new schema.',
          action: 'REVIEW_REQUIRED',
        })
      }
    }
    if (text(row.usr_account_balance) && text(row.usr_account_balance) !== '0') {
      ctx.reporter.problem({
        legacyTable: 'users',
        legacyId,
        targetModel: 'User',
        code: 'NO_DESTINATION',
        field: 'usr_account_balance',
        value: String(row.usr_account_balance),
        message:
          'Not copied: the tester balance is derived from the transaction ledger. Verify the ledger reproduces this figure.',
        action: 'REVIEW_REQUIRED',
      })
    }

    reportProblems(ctx, 'users', legacyId, 'User', problems)
    return { kind: 'written', created: !existing }
  },
}

// ── user_organisation_map → OrganisationMember ───────────────────────────────

export const orgMemberLoader: Loader = {
  table: 'user_organisation_map',
  target: 'OrganisationMember',
  dependsOn: [
    { table: 'users', model: 'User' },
    { table: 'organisation', model: 'Organisation' },
  ],

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.uom_id)

    /*
      An inactive membership has no representation: OrganisationMember records
      that someone IS a member, with no status column. Writing the row anyway
      would re-admit people who were removed from a company years ago, which is
      an access-control regression, not a data-fidelity one.
    */
    if (!bool(row.uom_status, false)) {
      return {
        kind: 'skipped',
        code: 'INACTIVE_MEMBERSHIP',
        message: 'uom_status=inactive and OrganisationMember has no inactive state.',
        field: 'uom_status',
        value: asText(row.uom_status),
      }
    }

    const userId = await ctx.idMap.resolve('users', legacyRef(row.uom_user_id), 'User')
    const organisationId = await ctx.idMap.resolve(
      'organisation',
      legacyRef(row.uom_org_id),
      'Organisation',
    )

    if (!userId || !organisationId) {
      ctx.reporter.orphan({
        legacyTable: 'user_organisation_map',
        legacyId,
        field: userId ? 'uom_org_id' : 'uom_user_id',
        referencedTable: userId ? 'organisation' : 'users',
        referencedId: String(userId ? row.uom_org_id : row.uom_user_id),
      })
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'Referenced user or organisation was not migrated.',
      }
    }

    const roleId = legacyRef(row.uom_role_id)
    // `??` alone would not catch the empty string `roleId &&` can produce, and
    // an empty orgRole is not a legal enum member.
    const orgRole = roleId
      ? (ORG_MEMBER_ROLE_BY_LEGACY_ID[roleId] ?? OrgMemberRole.MEMBER)
      : OrgMemberRole.MEMBER
    const joinedAt = timestampOr(row.uom_creation_date)

    const data = { orgRole, invitedAt: joinedAt, joinedAt }

    const existing = await tx.organisationMember.findUnique({
      where: { organisationId_userId: { organisationId, userId } },
      select: { id: true },
    })

    const member = existing
      ? await tx.organisationMember.update({
          where: { id: existing.id },
          data,
          select: { id: true },
        })
      : await tx.organisationMember.create({
          data: { ...data, organisationId, userId, createdAt: joinedAt },
          select: { id: true },
        })

    await ctx.idMap.remember(tx, 'user_organisation_map', legacyId, 'OrganisationMember', member.id)
    return { kind: 'written', created: !existing }
  },
}

// ── user_invitation → OrganisationInvitation ─────────────────────────────────

export const invitationLoader: Loader = {
  table: 'user_invitation',
  target: 'OrganisationInvitation',
  dependsOn: [
    { table: 'users', model: 'User' },
    { table: 'organisation', model: 'Organisation' },
  ],

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.invite_id)

    const email = parseEmail(row.invite_email)
    if (!email.value) {
      return {
        kind: 'skipped',
        code: 'INVALID_EMAIL',
        message: 'Invitation has no usable email.',
        field: 'invite_email',
      }
    }

    const organisationId = await ctx.idMap.resolve(
      'organisation',
      legacyRef(row.invite_org_id),
      'Organisation',
    )
    const invitedById = await ctx.idMap.resolve('users', legacyRef(row.invite_created_by), 'User')

    if (!organisationId || !invitedById) {
      ctx.reporter.orphan({
        legacyTable: 'user_invitation',
        legacyId,
        field: organisationId ? 'invite_created_by' : 'invite_org_id',
        referencedTable: organisationId ? 'users' : 'organisation',
        referencedId: String(organisationId ? row.invite_created_by : row.invite_org_id),
      })
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'Inviting user or organisation was not migrated.',
      }
    }

    const createdAt = timestampOr(row.invite_datetime)
    const accepted = bool(row.invite_accepted, false)

    /*
      `invite_passcode` is NOT carried into `tokenHash`.

      The new flow stores the hash of a single-use, expiring token. A legacy
      passcode is a short shared secret with neither property, and copying it
      across would leave a live, redeemable invitation for every pending row in
      a decade-old table. Migrated invitations are therefore history: accepted
      ones keep their acceptance, pending ones arrive already expired.
    */
    const tokenHash = `legacy:${legacyId}`
    const expiresAt = accepted ? createdAt : createdAt

    const data = {
      email: email.value,
      orgRole: OrgMemberRole.MEMBER,
      tokenHash,
      expiresAt,
      acceptedAt: accepted ? createdAt : null,
      revokedAt: accepted ? null : createdAt,
      createdAt,
      updatedAt: createdAt,
    }

    const mapped = await ctx.idMap.resolve('user_invitation', legacyId, 'OrganisationInvitation')
    const existing = mapped
      ? await tx.organisationInvitation.findUnique({ where: { id: mapped }, select: { id: true } })
      : null

    const invitation = existing
      ? await tx.organisationInvitation.update({
          where: { id: existing.id },
          data,
          select: { id: true },
        })
      : await tx.organisationInvitation.create({
          data: { ...data, organisationId, invitedById },
          select: { id: true },
        })

    await ctx.idMap.remember(
      tx,
      'user_invitation',
      legacyId,
      'OrganisationInvitation',
      invitation.id,
    )

    if (!accepted) {
      ctx.reporter.problem({
        legacyTable: 'user_invitation',
        legacyId,
        targetModel: 'OrganisationInvitation',
        code: 'REVOKED_ON_MIGRATION',
        field: 'invite_passcode',
        value: null,
        message:
          'Pending invitation migrated as revoked — a legacy passcode is not a single-use token and must not stay redeemable.',
        action: 'REVIEW_REQUIRED',
      })
    }

    return { kind: 'written', created: !existing }
  },
}

export const identityLoaders: Loader[] = [
  organisationLoader,
  userLoader,
  orgMemberLoader,
  invitationLoader,
]

/**
 * Gives every migrated organisation its owner.
 *
 * `organisation.org_created_by` names the person who created it, and it
 * resolves to a real user for 265 of the 276 organisations. Nothing was
 * reading it: organisations load in phase 2 and users in phase 3, so at the
 * moment an organisation is written its creator does not exist yet, and the
 * reference points forward exactly like `test_report.trep_defect_id` does.
 * Hence a post-pass, run once both sides exist.
 *
 * Without it every organisation arrived ownerless — which is what the
 * "organisations with no members" integrity check was reporting — and an
 * organisation with no OWNER has nobody who can administer it.
 *
 * An existing membership is promoted rather than duplicated, and a member row
 * is only created where the creator actually migrated.
 */
export async function assignOrganisationOwners(ctx: LoadContext): Promise<number> {
  const rows = await query<Record<string, unknown>>(
    'SELECT org_id, org_created_by, org_created_date FROM `organisation`',
  )

  let assigned = 0
  for (const row of rows) {
    const orgLegacyId = legacyRef(row.org_id)
    const creatorLegacyId = legacyRef(row.org_created_by)
    if (!orgLegacyId || !creatorLegacyId) continue

    const organisationId = await ctx.idMap.resolve('organisation', orgLegacyId, 'Organisation')
    const userId = await ctx.idMap.resolve('users', creatorLegacyId, 'User')
    if (!organisationId || !userId) {
      if (organisationId) {
        ctx.reporter.orphan({
          legacyTable: 'organisation',
          legacyId: orgLegacyId,
          field: 'org_created_by',
          referencedTable: 'users',
          referencedId: asText(row.org_created_by),
        })
      }
      continue
    }

    const existing = await ctx.prisma.organisationMember.findFirst({
      where: { organisationId, userId },
      select: { id: true, orgRole: true },
    })

    if (existing) {
      if (existing.orgRole !== OrgMemberRole.OWNER) {
        await ctx.prisma.organisationMember.update({
          where: { id: existing.id },
          data: { orgRole: OrgMemberRole.OWNER },
        })
        assigned += 1
      }
      continue
    }

    await ctx.prisma.organisationMember.create({
      data: {
        organisationId,
        userId,
        orgRole: OrgMemberRole.OWNER,
        createdAt: timestampOr(row.org_created_date),
      },
    })
    assigned += 1
  }

  return assigned
}
