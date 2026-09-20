import { randomBytes } from 'node:crypto'
import { type Prisma, HrEmployeeStatus, HrRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { todayInIndia } from '../../lib/hrms/hr-calendar.js'
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
  type CreateEmployeeInput,
  type UpdateEmployeeInput,
  type UpdateOwnDetailsInput,
  OWN_FINANCIAL_KEYS,
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
  input: Pick<UpdateEmployeeInput, 'panNumber' | 'accountNumber' | 'accountName' | 'ifscCode'>,
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

/**
 * Adds someone from the four details HR types (name, email, role).
 *
 * The new starter cannot sign in yet: their password is a hash of random bytes
 * that nobody knows, so every attempt fails until they use the invitation the
 * caller sends next. A random hash rather than a placeholder because the
 * column is NOT NULL and there is then no sentinel value a later change could
 * mistake for "no password set" and wave through.
 *
 * The joining date starts as today, in India. It is a NOT NULL column and the
 * employee code is built from it, and adding someone is, in practice, the day
 * they join; HR corrects it from Edit employment if it is not.
 */
export async function createEmployee(input: CreateEmployeeInput) {
  const existing = await prisma.hrEmployee.findUnique({
    where: { email: input.email },
    select: { id: true },
  })
  if (existing) throw new ConflictError('An employee with this email already exists')

  const passwordHash = await hashPassword(randomBytes(32).toString('hex'))
  const joiningDate = todayInIndia()

  // employeeCode is retried once on a unique-constraint race — see the
  // schema's own note that a count-based scheme accepts this trade-off for a
  // single admin adding one employee at a time.
  for (let attempt = 0; attempt < 2; attempt++) {
    const employeeCode = await nextEmployeeCode(joiningDate)
    try {
      const created = await prisma.hrEmployee.create({
        data: {
          employeeCode,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          passwordHash,
          role: input.role,
          joiningDate,
        },
        select: { id: true },
      })
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

/**
 * An employee filling in their own details after accepting their invitation.
 *
 * Goes through `updateEmployee`, so the partial merge of encrypted financial
 * fields behaves exactly as it does for HR. The schema has already limited the
 * fields to personal and bank/PAN details; the one rule enforced here is the
 * password step-up for the bank/PAN group, because changing where someone is
 * paid is the change a stolen session would try first.
 */
export async function updateOwnDetails(employeeId: string, input: UpdateOwnDetailsInput) {
  const { currentPassword, ...fields } = input

  if (OWN_FINANCIAL_KEYS.some((key) => fields[key] !== undefined)) {
    const me = await prisma.hrEmployee.findFirst({
      where: { id: employeeId, deletedAt: null },
      select: { passwordHash: true },
    })
    if (!me || !currentPassword || !(await verifyPassword(me.passwordHash, currentPassword))) {
      throw new UnauthorizedError('Incorrect password')
    }
  }

  return updateEmployee(employeeId, fields)
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
