import { z } from 'zod'
import { Role } from '@prisma/client'

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(255)

/**
 * Minimum 12 characters. Length beats composition rules for real-world
 * resistance, so we require length and check nothing else beyond a blocklist.
 */
const password = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200, 'Password must be at most 200 characters')
  .refine(
    (v) => !['password', '123456789012', 'qwertyuiop12'].includes(v.toLowerCase()),
    'That password is too common',
  )

export const registerSchema = z
  .object({
    email,
    password,
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80).optional(),
    phone: z.string().trim().max(32).optional(),
    countryCode: z.string().trim().length(2).toUpperCase().optional(),
    /**
     * SELF-REGISTRATION IS CUSTOMER OR TESTER ONLY, and the choice is required.
     *
     * Those are the two things a stranger can be to this platform: someone who
     * wants testing done, and someone who wants to do it. They lead to entirely
     * different onboarding — a CUSTOMER gets an organisation, a TESTER gets a
     * profile queued for Admin review (§2.2) — so there is no sensible default
     * and the caller must say which.
     *
     * `USER` was previously accepted and defaulted to. It is the "registered but
     * not yet onboarded" state (§2.1), which is a state the platform can put
     * someone IN, not a thing anyone signs up as: it grants access to nothing
     * and leaves the account in limbo with no route out.
     *
     * ADMIN and SUB_ADMIN are created by an Admin, never by signup.
     */
    intendedRole: z.enum([Role.CUSTOMER, Role.TESTER], {
      errorMap: () => ({ message: 'Choose whether you are signing up as a customer or a tester' }),
    }),
    /** Required when intendedRole is CUSTOMER — creates the organisation. */
    organisationName: z.string().trim().min(2).max(160).optional(),
    acceptedTerms: z.literal(true, {
      errorMap: () => ({ message: 'You must accept the Terms of Use to register' }),
    }),
  })
  .refine((data) => data.intendedRole !== Role.CUSTOMER || !!data.organisationName, {
    message: 'Organisation name is required for a customer account',
    path: ['organisationName'],
  })

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Password is required').max(200),
})

export const refreshSchema = z.object({
  /** Optional: the token normally arrives in an httpOnly cookie. */
  refreshToken: z.string().min(1).optional(),
})

/** Body of `POST /v1/auth/google/exchange` — see auth.controller.ts's `googleExchange`. */
export const googleExchangeSchema = z.object({
  code: z.string().min(1, 'code is required'),
})

export const forgotPasswordSchema = z.object({ email })

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  password,
})

export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'Verification token is required'),
})

export const resendVerificationSchema = z.object({ email })

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: password,
})

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>
