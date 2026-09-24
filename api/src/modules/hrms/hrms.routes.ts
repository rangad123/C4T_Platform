import { Router } from 'express'
import { hrAuthRouter } from './hr-auth.routes.js'
import { hrCatalogRouter } from './hr-catalog.routes.js'
import { hrEmployeesRouter } from './hr-employees.routes.js'
import { hrUploadsRouter } from './hr-uploads.routes.js'
import { hrSalaryRouter } from './hr-salary.routes.js'
import { hrTaxRouter, hrEmployeeTaxRouter } from './hr-tax.routes.js'
import { hrInvestmentsRouter } from './hr-investments.routes.js'
import { hrPayslipRouter, hrPayslipRunRouter } from './hr-payslip.routes.js'
import { hrTemplatesRouter } from './hr-templates.routes.js'
import { hrReportsRouter } from './hr-reports.routes.js'
import { hrHolidaysRouter } from './hr-holidays.routes.js'
import { hrLeavesRouter } from './hr-leaves.routes.js'
import { hrEmployeeLeavesRouter } from './hr-employee-leaves.routes.js'
import { hrTimesheetRouter } from './hr-timesheet.routes.js'
import { hrEmployeeTimesheetRouter } from './hr-employee-timesheet.routes.js'
import { hrSelfRouter } from './hr-self.routes.js'
import { hrDocumentsRouter } from './hr-documents.routes.js'
import { hrCrmLeadsRouter } from './hr-crm-leads.routes.js'
import { hrDashboardRouter } from './hr-dashboard.routes.js'

/**
 * Every HRMS route lives under this one prefix, `/v1/hrms/*` — a single
 * mount point for a deliberately separate identity domain (see the schema's
 * HRMS section). Sub-routers are added here phase by phase; none of them
 * import `authenticate`/`requireRole` from the platform's own middleware —
 * only `hrAuthenticate`/`requireHrRole`.
 *
 * Several routers share the `/employees` prefix (hrEmployeesRouter,
 * hrSalaryRouter, hrEmployeeTaxRouter, hrInvestmentsRouter) — Express tries
 * each in registration order and falls through on a non-match, so this is
 * the same pattern as one router with more route declarations, just split
 * by module for the reasons each file's own header comment gives.
 */
export const hrmsRouter = Router()

hrmsRouter.use('/auth', hrAuthRouter)
hrmsRouter.use('/catalog', hrCatalogRouter)
// Everything under /me acts on the caller and never takes an employee id.
hrmsRouter.use('/me', hrSelfRouter)
hrmsRouter.use('/employees', hrEmployeesRouter)
hrmsRouter.use('/employees', hrSalaryRouter)
hrmsRouter.use('/employees', hrEmployeeTaxRouter)
hrmsRouter.use('/employees', hrInvestmentsRouter)
hrmsRouter.use('/employees', hrPayslipRouter)
hrmsRouter.use('/employees', hrEmployeeLeavesRouter)
hrmsRouter.use('/employees', hrEmployeeTimesheetRouter)
hrmsRouter.use('/employees', hrDocumentsRouter)
hrmsRouter.use('/payslips', hrPayslipRunRouter)
hrmsRouter.use('/tax-slabs', hrTaxRouter)
hrmsRouter.use('/templates', hrTemplatesRouter)
hrmsRouter.use('/reports', hrReportsRouter)
hrmsRouter.use('/holidays', hrHolidaysRouter)
hrmsRouter.use('/leaves', hrLeavesRouter)
hrmsRouter.use('/timesheet', hrTimesheetRouter)
hrmsRouter.use('/uploads', hrUploadsRouter)
hrmsRouter.use('/crm/leads', hrCrmLeadsRouter)
hrmsRouter.use('/dashboard', hrDashboardRouter)
