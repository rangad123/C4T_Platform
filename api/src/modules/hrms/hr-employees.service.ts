import { randomBytes } from 'node:crypto'
import { type Prisma, HrEmployeeStatus, HrRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { searchTerms } from '../../lib/search.js'
import { hashPassword, verifyPassword } from '../../lib/password.js'
import {
  NotFoundError,
  ConflictError,
  UnauthorizedError,
  BadRequestError,
} from '../../lib/errors.js'
import { buildMeta, buildOrderBy, toSkipTake } from '../../lib/pagination.js'
import {
  encryptHrFinancialDetails,
  decryptHrFinancialDetails,
  maskPan,
  maskAccountNumber,
  type HrFinancialDetailsPlain,
} from '../../lib/hrms/hr-encryption.js'
import {
  EMPLOYEE_SORT_FIELDS,
  type ListEmployeesQuery,
  type ListInvitationsQuery,
  type CreateEmployeeInput,
  type UpdateEmployeeInput,
} from './hr-employees.schema.js'

const listSelect = {
  id: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  email: true,
  role: true,
  status: true,
  phone: true,
  joiningDate: true,
  profilePictureFileId: true,
  designation: { select: { id: true, name: true } },
} satisfies Prisma.HrEmployeeSelect

const detailSelect = {
  ...listSelect,
  dateOfBirth: true,
  gender: true,
  address: true,
  accountType: true,
  relievingDate: true,
  timesheetRequired: true,
  taxRegime: true,
  bankName: true,
  branchName: true,
  secureFinancialDetails: true,
  reportsTo: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.HrEmployeeSelect

/** Never returns the ciphertext — only masked hints of what's on file. */
function toDetail(employee: Prisma.HrEmployeeGetPayload<{ select: typeof detailSelect }>) {
  const { secureFinancialDetails, ...rest } = employee
  let plain: HrFinancialDetailsPlain = {}
  if (secureFinancialDetails) {
    try {
      plain = decryptHrFinancialDetails(Buffer.from(secureFinancialDetails), employee.id)
    } catch {
      // A corrupted/foreign-keyed envelope must not take the whole page down —
      // the reveal endpoint will surface the real error if someone tries it.
      plain = {}
    }
  }
  return {
    ...rest,
    financialDetails: {
      hasPan: Boolean(plain.panNumber),
      hasBankDetails: Boolean(plain.accountNumber),
      panMasked: maskPan(plain.panNumber),
      accountNumberMasked: maskAccountNumber(plain.accountNumber),
    },
  }
}

export async function listEmployees(query: ListEmployeesQuery) {
  const where: Prisma.HrEmployeeWhereInput = {
    deletedAt: null,
    ...(query.role ? { role: query.role } : {}),
    ...(query.status
      ? { status: query.status }
      : query.former
        ? { status: { in: [HrEmployeeStatus.RESIGNED, HrEmployeeStatus.TERMINATED] } }
        : { status: HrEmployeeStatus.ACTIVE }),
    ...(searchTerms(query.search).length > 0
      ? {
          AND: searchTerms(query.search).map((term) => ({
            OR: [
              { email: { contains: term, mode: 'insensitive' as const } },
              { firstName: { contains: term, mode: 'insensitive' as const } },
              { lastName: { contains: term, mode: 'insensitive' as const } },
              { employeeCode: { contains: term, mode: 'insensitive' as const } },
            ],
          })),
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    prisma.hrEmployee.findMany({
      where,
      select: listSelect,
      orderBy: buildOrderBy(query.sort, query.order, EMPLOYEE_SORT_FIELDS, 'createdAt'),
      ...toSkipTake(query),
    }),
    prisma.hrEmployee.count({ where }),
  ])

  return { items, meta: buildMeta(query, total) }
}

/**
 * Active staff for the Invitations page, with whether each has ever signed in.
 *
 * "Signed in" means a session row exists. That is the honest test: an account
 * an admin created with a typed password, or one migrated from the old system,
 * has a password but has never been used, and is exactly who an invitation is
 * for. `notSignedIn` counts everyone in that state whatever the search, so the
 * tab's number does not move while someone is filtering.
 *
 * `lastLinkSentAt` is the newest password link of any kind — an invitation or
 * a reset. They share a table, so the two cannot be told apart, and the
 * column is worded to say only what is true: a link went out.
 */
export async function listInvitations(query: ListInvitationsQuery) {
  const terms = searchTerms(query.search)
  const active = { deletedAt: null, status: HrEmployeeStatus.ACTIVE } as const
  const where: Prisma.HrEmployeeWhereInput = {
    ...active,
    ...(query.filter === 'not-signed-in' ? { sessions: { none: {} } } : {}),
    ...(terms.length > 0
      ? {
          AND: terms.map((term) => ({
            OR: [
              { email: { contains: term, mode: 'insensitive' as const } },
              { firstName: { contains: term, mode: 'insensitive' as const } },
              { lastName: { contains: term, mode: 'insensitive' as const } },
              { employeeCode: { contains: term, mode: 'insensitive' as const } },
            ],
          })),
        }
      : {}),
  }

  const [rows, total, notSignedIn] = await Promise.all([
    prisma.hrEmployee.findMany({
      where,
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        email: true,
        designation: { select: { name: true } },
        _count: { select: { sessions: true } },
        passwordResetTokens: {
          select: { createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      ...toSkipTake(query),
    }),
    prisma.hrEmployee.count({ where }),
    prisma.hrEmployee.count({ where: { ...active, sessions: { none: {} } } }),
  ])

  return {
    items: rows.map((row) => ({
      id: row.id,
      employeeCode: row.employeeCode,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      designation: row.designation,
      signedIn: row._count.sessions > 0,
      lastLinkSentAt: row.passwordResetTokens[0]?.createdAt ?? null,
    })),
    meta: { ...buildMeta(query, total), notSignedIn },
  }
}

/** Active ADMIN/ACCOUNT_MANAGER employees, for the "Account Manager" picker. */
export async function listManagers() {
  return prisma.hrEmployee.findMany({
    where: {
      deletedAt: null,
      status: HrEmployeeStatus.ACTIVE,
      role: { in: [HrRole.ADMIN, HrRole.ACCOUNT_MANAGER] },
    },
    select: { id: true, firstName: true, lastName: true, employeeCode: true },
    orderBy: { firstName: 'asc' },
  })
}

export async function getEmployee(id: string) {
  const employee = await prisma.hrEmployee.findFirst({
    where: { id, deletedAt: null },
    select: detailSelect,
  })
  if (!employee) throw new NotFoundError('Employee')
  return toDetail(employee)
}

/**
 * The running number inside an existing employee code.
 *
 * Codes carried over from the old HR system use two shapes, because whoever
 * maintained them changed their mind partway through: `yyyymm` + a 4-digit
 * sequence (2021040016) for the first 18, then `yyyymmdd` + a 3-digit one
 * (20220401021) for the 23 after that. Both carry the SAME running number —
 * it continues across months rather than restarting — so both are read here,
 * otherwise the sequence would jump backwards the first time someone is hired
 * after a code of the newer shape.
 */
function sequenceIn(code: string): number | null {
  if (!/^\d{10,11}$/.test(code)) return null
  const rest = code.slice(6)
  // 4 digits: the sequence itself. 5 digits: a day, then the sequence.
  const digits = rest.length === 4 ? rest : rest.slice(2)
  const value = Number(digits)
  return Number.isFinite(value) ? value : null
}

/**
 * `yyyymm` of the joining date, then the next number in one running sequence —
 * the format the old HR system used and the one the business asked to keep.
 *
 * Deliberately NOT derived from `count()`: soft-deleted rows still count, and a
 * count says nothing about the highest number actually issued, so two people
 * hired either side of a deletion could collide. This reads the real maximum.
 * Codes that predate the scheme (a handful are 8 characters) simply do not
 * parse and are ignored rather than dragging the sequence down.
 */
async function nextEmployeeCode(joiningDate: Date): Promise<string> {
  const existing = await prisma.hrEmployee.findMany({ select: { employeeCode: true } })
  const highest = existing.reduce((max, row) => {
    const seq = sequenceIn(row.employeeCode)
    return seq !== null && seq > max ? seq : max
  }, 0)

  const year = joiningDate.getUTCFullYear()
  const month = String(joiningDate.getUTCMonth() + 1).padStart(2, '0')
  return `${year}${month}${String(highest + 1).padStart(4, '0')}`
}

function financialEnvelope(
  employeeId: string,
  input: Pick<CreateEmployeeInput, 'panNumber' | 'accountNumber' | 'accountName' | 'ifscCode'>,
): Buffer | null {
  if (!input.panNumber && !input.accountNumber && !input.accountName && !input.ifscCode) return null
  return encryptHrFinancialDetails(
    {
      panNumber: input.panNumber,
      accountNumber: input.accountNumber,
      accountName: input.accountName,
      ifscCode: input.ifscCode,
    },
    employeeId,
  )
}

export async function createEmployee(input: CreateEmployeeInput) {
  const existing = await prisma.hrEmployee.findUnique({
    where: { email: input.email },
    select: { id: true },
  })
  if (existing) throw new ConflictError('An employee with this email already exists')

  /**
   * No password means the employee is being invited to choose one. Store a
   * hash of random bytes rather than a placeholder: the row's NOT NULL is
   * satisfied, every sign-in attempt fails until the invitation is used, and
   * there is no sentinel value that a later change could accidentally treat
   * as "no password set" and wave through.
   */
  const passwordHash = await hashPassword(input.password ?? randomBytes(32).toString('hex'))

  // employeeCode is retried once on a unique-constraint race — see the
  // schema's own note that a count-based scheme accepts this trade-off for a
  // single admin adding one employee at a time.
  for (let attempt = 0; attempt < 2; attempt++) {
    const employeeCode = await nextEmployeeCode(input.joiningDate)
    try {
      const created = await prisma.hrEmployee.create({
        data: {
          employeeCode,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          passwordHash,
          dateOfBirth: input.dateOfBirth ?? null,
          gender: input.gender ?? null,
          phone: input.phone ?? null,
          address: input.address ?? null,
          designationId: input.designationId ?? null,
          role: input.role,
          accountType: input.accountType ?? null,
          reportsToId: input.reportsToId ?? null,
          joiningDate: input.joiningDate,
          timesheetRequired: input.timesheetRequired,
          taxRegime: input.taxRegime,
          bankName: input.bankName ?? null,
          branchName: input.branchName ?? null,
        },
        select: { id: true },
      })

      const envelope = financialEnvelope(created.id, input)
      if (envelope) {
        await prisma.hrEmployee.update({
          where: { id: created.id },
          data: { secureFinancialDetails: new Uint8Array(envelope) },
        })
      }

      return await getEmployee(created.id)
    } catch (error) {
      const isUniqueCodeClash =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002' &&
        attempt === 0
      if (!isUniqueCodeClash) throw error
    }
  }
  throw new ConflictError('Could not allocate an employee code — try again')
}

export async function updateEmployee(id: string, input: UpdateEmployeeInput) {
  const existing = await prisma.hrEmployee.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, secureFinancialDetails: true, email: true, joiningDate: true },
  })
  if (!existing) throw new NotFoundError('Employee')

  // Email is the sign-in identity and unique, so a clash has to be reported
  // rather than left to surface as a raw constraint violation.
  if (input.email !== undefined && input.email !== existing.email) {
    const clash = await prisma.hrEmployee.findUnique({
      where: { email: input.email },
      select: { id: true },
    })
    if (clash) throw new ConflictError('An employee with this email already exists')
  }

  // Checked against whichever joining date will be in force after this save,
  // so moving both dates in one edit is judged on the pair rather than on a
  // stale stored value.
  if (input.relievingDate) {
    const joining = input.joiningDate ?? existing.joiningDate
    if (input.relievingDate < joining) {
      throw new BadRequestError('The relieving date cannot be before the joining date')
    }
  }

  const touchesFinancial =
    input.panNumber !== undefined ||
    input.accountNumber !== undefined ||
    input.accountName !== undefined ||
    input.ifscCode !== undefined

  let secureFinancialDetails: Buffer | null | undefined
  if (touchesFinancial) {
    const previous = existing.secureFinancialDetails
      ? decryptHrFinancialDetails(Buffer.from(existing.secureFinancialDetails), id)
      : {}
    secureFinancialDetails = financialEnvelope(id, {
      panNumber: input.panNumber ?? previous.panNumber,
      accountNumber: input.accountNumber ?? previous.accountNumber,
      accountName: input.accountName ?? previous.accountName,
      ifscCode: input.ifscCode ?? previous.ifscCode,
    })
  }

  const data: Prisma.HrEmployeeUncheckedUpdateInput = {
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
    ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
    ...(input.dateOfBirth !== undefined ? { dateOfBirth: input.dateOfBirth } : {}),
    ...(input.gender !== undefined ? { gender: input.gender } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.address !== undefined ? { address: input.address } : {}),
    ...(input.designationId !== undefined ? { designationId: input.designationId } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.accountType !== undefined ? { accountType: input.accountType } : {}),
    ...(input.reportsToId !== undefined ? { reportsToId: input.reportsToId } : {}),
    ...(input.joiningDate !== undefined ? { joiningDate: input.joiningDate } : {}),
    ...(input.relievingDate !== undefined ? { relievingDate: input.relievingDate } : {}),
    ...(input.timesheetRequired !== undefined
      ? { timesheetRequired: input.timesheetRequired }
      : {}),
    ...(input.taxRegime !== undefined ? { taxRegime: input.taxRegime } : {}),
    ...(input.bankName !== undefined ? { bankName: input.bankName } : {}),
    ...(input.branchName !== undefined ? { branchName: input.branchName } : {}),
    ...(input.profilePictureFileId !== undefined
      ? { profilePictureFileId: input.profilePictureFileId }
      : {}),
    ...(secureFinancialDetails !== undefined
      ? {
          secureFinancialDetails: secureFinancialDetails
            ? new Uint8Array(secureFinancialDetails)
            : null,
        }
      : {}),
  }

  await prisma.hrEmployee.update({ where: { id }, data })

  return getEmployee(id)
}

export async function changeEmployeeStatus(
  id: string,
  status: HrEmployeeStatus,
  relievingDate?: Date,
) {
  const existing = await prisma.hrEmployee.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  })
  if (!existing) throw new NotFoundError('Employee')

  const isOffboarding = status !== HrEmployeeStatus.ACTIVE

  await prisma.$transaction([
    prisma.hrEmployee.update({
      where: { id },
      data: {
        status,
        relievingDate: isOffboarding ? (relievingDate ?? new Date()) : null,
      },
    }),
    // Offboarding revokes every session immediately — the same reasoning the
    // platform applies to a suspended User: a status change must take effect
    // right away, not at the access token's next 15-minute expiry.
    ...(isOffboarding
      ? [
          prisma.hrSession.updateMany({
            where: { employeeId: id, revokedAt: null },
            data: { revokedAt: new Date(), revokedReason: 'admin' },
          }),
        ]
      : []),
  ])

  return getEmployee(id)
}

/**
 * Step-up reveal of PAN/bank details — mirrors payment-accounts.reveal.ts:
 * the ADMIN's OWN password gates it, the decrypted value is returned once and
 * never logged, and the audit entry names which fields were revealed, never
 * their values.
 */
export async function revealFinancialDetails(
  adminId: string,
  employeeId: string,
  password: string,
) {
  const admin = await prisma.hrEmployee.findUnique({
    where: { id: adminId },
    select: { passwordHash: true },
  })
  if (!admin || !(await verifyPassword(admin.passwordHash, password))) {
    throw new UnauthorizedError('Incorrect password')
  }

  const employee = await prisma.hrEmployee.findFirst({
    where: { id: employeeId, deletedAt: null },
    select: { id: true, secureFinancialDetails: true },
  })
  if (!employee) throw new NotFoundError('Employee')

  const plain = employee.secureFinancialDetails
    ? decryptHrFinancialDetails(Buffer.from(employee.secureFinancialDetails), employee.id)
    : {}

  return {
    plain,
    fieldsRevealed: Object.keys(plain).filter((key) => plain[key as keyof typeof plain]),
  }
}
