import { Router } from 'express'
import { prisma } from '../../lib/prisma.js'
import { hrAuthenticate } from './hr-auth.middleware.js'

/**
 * Read-only reference data for the four fixed HRMS lists — mirrors the
 * platform's own Catalog pattern (admin-writes/everyone-reads, `isActive`
 * soft-retire) but as its own tables, since an HR request has no platform
 * session to call `GET /v1/catalog` with.
 *
 * No write routes yet: rows are managed via `scripts/hrms/seed-catalog.ts`
 * for now. A future phase can add ADMIN-gated writes here without touching
 * these reads.
 */
export const hrCatalogRouter = Router()

hrCatalogRouter.use(hrAuthenticate)

hrCatalogRouter.get('/designations', async (_req, res) => {
  const rows = await prisma.hrDesignation.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
  res.json({ data: rows })
})

hrCatalogRouter.get('/leave-types', async (_req, res) => {
  const rows = await prisma.hrLeaveType.findMany({
    where: { isActive: true },
    select: { id: true, name: true, defaultAnnualDays: true },
    orderBy: { name: 'asc' },
  })
  res.json({ data: rows })
})

hrCatalogRouter.get('/incentive-types', async (_req, res) => {
  const rows = await prisma.hrIncentiveType.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
  res.json({ data: rows })
})

hrCatalogRouter.get('/investment-sections', async (_req, res) => {
  const rows = await prisma.hrInvestmentSection.findMany({
    where: { isActive: true },
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  })
  res.json({ data: rows })
})
