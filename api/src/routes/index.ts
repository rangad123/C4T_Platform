import { Router } from 'express'
import { authRouter } from '../modules/auth/auth.routes.js'
import { usersRouter } from '../modules/users/users.routes.js'
import { organisationsRouter } from '../modules/organisations/organisations.routes.js'
import { testersRouter } from '../modules/testers/testers.routes.js'
import { projectsRouter } from '../modules/projects/projects.routes.js'
import { bugsRouter } from '../modules/bugs/bugs.routes.js'
import { managersRouter } from '../modules/managers/managers.routes.js'
import { communicationRouter } from '../modules/communication/communication.routes.js'
import { ratingsRouter } from '../modules/ratings/ratings.routes.js'
import { transactionsRouter } from '../modules/transactions/transactions.routes.js'
import { notificationsRouter } from '../modules/notifications/notifications.routes.js'
import { uploadsRouter } from '../modules/uploads/uploads.routes.js'
import { statsRouter } from '../modules/stats/stats.routes.js'
import { leadsRouter } from '../modules/leads/leads.routes.js'
import { catalogRouter } from '../modules/catalog/catalog.routes.js'
import { paymentAccountsRouter } from '../modules/payment-accounts/payment-accounts.routes.js'
import { testingRouter } from '../modules/testing/testing.routes.js'
import { reportsRouter } from '../modules/reports/reports.routes.js'

/**
 * API v1. Every route is mounted under /v1 so a future breaking change can ship
 * as /v2 alongside it rather than through a flag day.
 */
export const v1Router = Router()

v1Router.use('/auth', authRouter)
v1Router.use('/users', usersRouter)
v1Router.use('/organisations', organisationsRouter)
v1Router.use('/testers', testersRouter)
v1Router.use('/catalog', catalogRouter)
v1Router.use('/projects', projectsRouter)
v1Router.use('/bugs', bugsRouter)
v1Router.use('/managers', managersRouter)
v1Router.use('/communication', communicationRouter)
v1Router.use('/ratings', ratingsRouter)
v1Router.use('/transactions', transactionsRouter)
v1Router.use('/payment-accounts', paymentAccountsRouter)
v1Router.use('/notifications', notificationsRouter)
v1Router.use('/uploads', uploadsRouter)
v1Router.use('/stats', statsRouter)
/**
 * Mounted at the v1 root, not a prefix — the router's own routes already
 * spell out `/test-cases/*` and `/builds/:buildId/*` (a test case is not
 * "owned" by one single collection path the way projects/bugs are, and
 * `builds` already lives nested under `/projects/:id/builds` for create/
 * list/rename — this covers the reads a build id alone is enough for).
 */
v1Router.use('/', testingRouter)
v1Router.use('/reports', reportsRouter)
/**
 * ⚠ `/leads` is the only router here whose POST is UNAUTHENTICATED — the
 * marketing site's contact form has no session to present. It applies its own
 * rate limit and applies `authenticate` per-route on the admin endpoints. See
 * the note at the top of leads.routes.ts before adding anything to it.
 */
v1Router.use('/leads', leadsRouter)
