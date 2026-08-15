import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate.js'
import { authenticate } from '../../middleware/authenticate.js'
import { authLimiter, authIpLimiter } from '../../middleware/rateLimit.js'
import * as controller from './auth.controller.js'
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  changePasswordSchema,
} from './auth.schema.js'

export const authRouter = Router()

authRouter.post('/register', authIpLimiter, authLimiter, validate({ body: registerSchema }), controller.register)
authRouter.post('/login', authIpLimiter, authLimiter, validate({ body: loginSchema }), controller.login)
authRouter.post('/refresh', validate({ body: refreshSchema }), controller.refresh)
authRouter.post('/logout', controller.logout)

/**
 * Google OAuth. Both are unauthenticated top-level browser navigations, not
 * XHR, so neither carries `authenticate` and neither returns JSON.
 *
 * `authLimiter` is NOT applied. It counts per IP and these are redirects, so a
 * shared corporate NAT would exhaust the budget for everyone behind it during a
 * normal working morning. The flow's own protection is the signed `state` plus
 * its nonce cookie, which is a stronger control than a request count.
 */
authRouter.get('/google', controller.googleStart)
authRouter.get('/google/callback', controller.googleCallback)

authRouter.post(
  '/forgot-password',
  authIpLimiter,
  authLimiter,
  validate({ body: forgotPasswordSchema }),
  controller.forgotPassword,
)
authRouter.post(
  '/reset-password',
  authIpLimiter,
  authLimiter,
  validate({ body: resetPasswordSchema }),
  controller.resetPassword,
)
authRouter.post('/verify-email', validate({ body: verifyEmailSchema }), controller.verifyEmail)
authRouter.post(
  '/resend-verification',
  authIpLimiter,
  authLimiter,
  validate({ body: resendVerificationSchema }),
  controller.resendVerification,
)

// Authenticated
authRouter.get('/me', authenticate, controller.me)
authRouter.post('/logout-all', authenticate, controller.logoutAll)

// Session management — "where you're signed in"
authRouter.get('/sessions', authenticate, controller.listSessions)
authRouter.delete(
  '/sessions/:id',
  authenticate,
  validate({ params: z.object({ id: z.string().cuid() }) }),
  controller.revokeSession,
)

authRouter.post(
  '/change-password',
  authenticate,
  validate({ body: changePasswordSchema }),
  controller.changePassword,
)
