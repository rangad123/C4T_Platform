import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import { hrAuthLimiter, hrAuthIpLimiter } from '../../middleware/rateLimit.js'
import { hrAuthenticate } from './hr-auth.middleware.js'
import * as controller from './hr-auth.controller.js'
import { hrLoginSchema, hrRefreshSchema, hrChangePasswordSchema } from './hr-auth.schema.js'

export const hrAuthRouter = Router()

hrAuthRouter.post(
  '/login',
  hrAuthIpLimiter,
  hrAuthLimiter,
  validate({ body: hrLoginSchema }),
  controller.login,
)
hrAuthRouter.post('/refresh', validate({ body: hrRefreshSchema }), controller.refresh)
hrAuthRouter.post('/logout', controller.logout)
hrAuthRouter.get('/me', hrAuthenticate, controller.me)
hrAuthRouter.post(
  '/change-password',
  hrAuthenticate,
  validate({ body: hrChangePasswordSchema }),
  controller.changePassword,
)
