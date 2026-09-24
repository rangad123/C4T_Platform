import { Router } from 'express'
import { hrAuthenticate, requireHrRole, HR_ADMIN_ROLES } from './hr-auth.middleware.js'
import { getAdminDashboardStats } from './hr-dashboard.service.js'

export const hrDashboardRouter = Router()

hrDashboardRouter.use(hrAuthenticate)

hrDashboardRouter.get('/admin/stats', requireHrRole(...HR_ADMIN_ROLES), async (_req, res) => {
  res.json({ data: await getAdminDashboardStats() })
})
