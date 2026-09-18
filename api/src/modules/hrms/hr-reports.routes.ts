import { Router } from 'express'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { hrAuthenticate, requireHrRole, HR_ADMIN_ROLES } from './hr-auth.middleware.js'
import { recordHrAudit } from '../../lib/hrms/hr-audit.js'
import * as service from './hr-reports.service.js'
import { generateReportQuery, type GenerateReportQuery } from './hr-reports.schema.js'

/**
 * Reports are generated on demand and streamed straight back — no
 * persistence, per the plan's own assumption ("Reports are generated on
 * demand, not persisted; no HrReport history table unless asked").
 */
export const hrReportsRouter = Router()

hrReportsRouter.use(hrAuthenticate, requireHrRole(...HR_ADMIN_ROLES))

hrReportsRouter.get('/', validate({ query: generateReportQuery }), async (req, res) => {
  const query = validatedQuery<GenerateReportQuery>(res)
  const pdf = await service.generateReport(query)

  await recordHrAudit({
    req,
    action: 'hr.report.generated',
    entityType: 'HrReport',
    after: {
      reportType: query.reportType,
      financialYear: query.financialYear,
      period: query.period,
    },
  })

  res.setHeader('content-type', 'application/pdf')
  res.setHeader(
    'content-disposition',
    `attachment; filename="${query.reportType.toLowerCase()}-${query.financialYear}.pdf"`,
  )
  res.send(pdf)
})
