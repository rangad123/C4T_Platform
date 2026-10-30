import { z } from 'zod'

/**
 * Validated environment.
 *
 * Next inlines `NEXT_PUBLIC_*` at build time, so those must be referenced
 * literally — `process.env[key]` with a computed key does not get replaced.
 * That is why this reads each one by name rather than looping.
 */
const clientSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.string().url(),
  NEXT_PUBLIC_API_BASE: z.string().default('/api/v1'),
  NEXT_PUBLIC_ENVIRONMENT: z.enum(['development', 'preview', 'production']).default('development'),
})

const serverSchema = clientSchema.extend({
  /** Origin of the Express API, used by the rewrite proxy and server fetches. */
  API_ORIGIN: z.string().url().default('http://localhost:4000'),
  /**
   * Parent domain for the session cookies (".crowd4test.com"), so AI Studio on
   * aistudio.crowd4test.com shares the sign-in. Unset: host-only, as before.
   * See `lib/auth/shared-session.ts`.
   */
  AUTH_COOKIE_DOMAIN: z
    .string()
    .regex(/^\.?[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'a domain such as .crowd4test.com')
    .optional(),
  /** Where AI Studio is served (https://aistudio.crowd4test.com). Unset hides its sidebar entry. */
  AI_STUDIO_URL: z.string().url().optional(),
})

const isServer = typeof window === 'undefined'

/** An empty line in .env means "not set", not an invalid empty value. */
const emptyIsUnset = (value: string | undefined) => (value === '' ? undefined : value)

const raw = {
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000',
  NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE ?? '/api/v1',
  NEXT_PUBLIC_ENVIRONMENT: process.env.NEXT_PUBLIC_ENVIRONMENT ?? 'development',
  ...(isServer
    ? {
        API_ORIGIN: process.env.API_ORIGIN ?? 'http://localhost:4000',
        AUTH_COOKIE_DOMAIN: emptyIsUnset(process.env.AUTH_COOKIE_DOMAIN),
        AI_STUDIO_URL: emptyIsUnset(process.env.AI_STUDIO_URL),
      }
    : {}),
}

const parsed = isServer ? serverSchema.safeParse(raw) : clientSchema.safeParse(raw)

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
  throw new Error(`Invalid environment configuration:\n${issues}`)
}

export const env = parsed.data as z.infer<typeof serverSchema>

export const isProduction = env.NEXT_PUBLIC_ENVIRONMENT === 'production'
