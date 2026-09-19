import { type Prisma, HrEmployeeStatus, HrRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { searchTerms } from '../../lib/search.js'
import { hashPassword, verifyPassword } from '../../lib/password.js'
import { NotFoundError, ConflictError, UnauthorizedError } from '../../lib/errors.js'
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

async function nextEmployeeCode(): Promise<string> {
  const count = await prisma.hrEmployee.count()
  return `EMP-${String(count + 1).padStart(4, '0')}`
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

  const passwordHash = await hashPassword(input.password)

  // employeeCode is retried once on a unique-constraint race — see the
  // schema's own note that a count-based scheme accepts this trade-off for a
  // single admin adding one employee at a time.
  for (let attempt = 0; attempt < 2; attempt++) {
    const employeeCode = await nextEmployeeCode()
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
    select: { id: true, secureFinancialDetails: true, email: true },
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
