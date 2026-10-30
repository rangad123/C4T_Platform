import { Role } from '@prisma/client'
import { PERMISSIONS } from '../../config/permissions.js'
import { BadRequestError } from '../../lib/errors.js'

/**
 * Who may be GIVEN which permission code. Pure, so the rules are testable
 * without a database and the catalogue endpoint can filter by them.
 *
 *   SUB_ADMIN          — any code, as before AI Studio existed.
 *   CUSTOMER, TESTER   — AI Studio codes only, minus the never-lists below.
 *                        Every other group stays sub-admin only: those codes
 *                        gate this API's own admin routes, which a customer
 *                        or tester must never reach.
 *   ADMIN              — nothing; an administrator implicitly holds every code.
 *   USER               — nothing; the account has not finished signing up.
 *
 * The never-lists are product decisions (ACCESS_MODEL.md, D-24 and D-26), and
 * AI Studio enforces them again on its side whatever this table holds.
 */

export const AI_STUDIO_CODE_PREFIX = 'ai_studio.'

export const AI_STUDIO_NEVER_FOR_TESTER: readonly string[] = [
  PERMISSIONS.AI_STUDIO_PROJECT_CREATE,
  PERMISSIONS.AI_STUDIO_PROJECT_MEMBERS,
  PERMISSIONS.AI_STUDIO_AI_KEYS_MANAGE,
  PERMISSIONS.AI_STUDIO_USAGE_VIEW,
  PERMISSIONS.AI_STUDIO_PLATFORM_SETTINGS,
]

export const AI_STUDIO_NEVER_FOR_CUSTOMER: readonly string[] = [
  PERMISSIONS.AI_STUDIO_PLATFORM_SETTINGS,
]

/**
 * Which slice of a person's grants one save replaces. The admin panel edits
 * AI Studio access and back-office permissions in separate panels, and each
 * save is a full replacement, so without a scope saving one would wipe the
 * other.
 */
export type PermissionScope = 'all' | 'ai_studio' | 'back_office'

export function isAiStudioCode(code: string): boolean {
  return code.startsWith(AI_STUDIO_CODE_PREFIX)
}

export function inScope(scope: PermissionScope, code: string): boolean {
  if (scope === 'ai_studio') return isAiStudioCode(code)
  if (scope === 'back_office') return !isAiStudioCode(code)
  return true
}

/** `null` when the code may be given to this role, otherwise why not. */
export function permissionRefusal(role: Role, code: string): string | null {
  switch (role) {
    case Role.SUB_ADMIN:
      return null
    case Role.CUSTOMER:
      if (!isAiStudioCode(code)) return 'Only AI Studio features can be given to a customer.'
      if (AI_STUDIO_NEVER_FOR_CUSTOMER.includes(code)) {
        return 'This feature cannot be given to a customer.'
      }
      return null
    case Role.TESTER:
      if (!isAiStudioCode(code)) return 'Only AI Studio features can be given to a tester.'
      if (AI_STUDIO_NEVER_FOR_TESTER.includes(code)) {
        return 'This feature cannot be given to a tester.'
      }
      return null
    case Role.ADMIN:
      return 'An administrator already holds every permission.'
    default:
      return 'Permissions can only be given to a sub-admin, a customer or a tester.'
  }
}

export function isGrantable(role: Role, code: string): boolean {
  return permissionRefusal(role, code) === null
}

/** Throws the first refusal, naming every refused code in `details`. */
export function assertGrantable(role: Role, codes: readonly string[]): void {
  const refused = codes.filter((code) => !isGrantable(role, code))
  if (refused.length === 0) return
  throw new BadRequestError(permissionRefusal(role, refused[0]!)!, { refused })
}

/**
 * The grants a person may keep after a role change. Leaving SUB_ADMIN still
 * revokes everything, as it always has: demoting a member of staff is a
 * withdrawal of access, and carrying their AI Studio features into a customer
 * or tester account would be a surprise. Between CUSTOMER and TESTER, only the
 * codes the new role may not hold are dropped.
 */
export function codesKeptOnRoleChange(from: Role, to: Role, held: readonly string[]): string[] {
  if (from === Role.SUB_ADMIN && to !== Role.SUB_ADMIN) return []
  return held.filter((code) => isGrantable(to, code))
}
