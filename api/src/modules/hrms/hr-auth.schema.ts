import { z } from 'zod'

/** Same length-over-composition rule as the platform's own password schema. */
const password = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200, 'Password must be at most 200 characters')

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

export type HrLoginInput = z.infer<typeof hrLoginSchema>
