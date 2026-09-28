import { z } from 'zod'
import { passwordField as password } from '../../lib/password-policy.js'

export const hrLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(255),
  password: z.string().min(1, 'Password is required').max(200),
})

export const hrRefreshSchema = z.object({
  refreshToken: z.string().min(1).optional(),
})

export const hrChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: password,
})

export const hrForgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(255),
})

export const hrResetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  password,
})

export type HrLoginInput = z.infer<typeof hrLoginSchema>
