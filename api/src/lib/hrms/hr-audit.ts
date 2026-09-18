import type { Request } from 'express'
import { prisma } from '../prisma.js'
import { logger } from '../logger.js'

/**
 * HRMS's own append-only audit trail — mirrors lib/audit.ts exactly, keyed
 * on `req.hrEmployee` instead of `req.user`. Not reused directly: an HR
 * request never carries `req.user`, and recordAudit() would silently write
 * `actorId: null` for every HR action, losing WHO touched a salary or PAN
 * field on the one system where that matters most.
 */
export async function recordHrAudit(params: {
  req: Request
  action: string
  entityType: string
  entityId?: string
  before?: unknown
  after?: unknown
}): Promise<void> {
  try {
    await prisma.hrAuditLog.create({
      data: {
        actorId: params.req.hrEmployee?.id ?? null,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId ?? null,
        before: (params.before ?? null) as never,
        after: (params.after ?? null) as never,
        ipAddress: params.req.ip ?? null,
        userAgent: params.req.header('user-agent')?.slice(0, 512) ?? null,
      },
    })
  } catch (error) {
    logger.error(
      {
        err: error,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
      },
      'Failed to write HR audit log entry',
    )
  }
}
