import 'dotenv/config'
import { z } from 'zod'

/**
 * Fail fast on bad configuration. A missing secret should crash at boot, not
 * produce a 500 three days later on EC2.
 */
const bool = z.enum(['true', 'false']).transform((v) => v === 'true')

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  // 'silent' is a real Pino level and is what the test suite uses.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  API_PUBLIC_URL: z.string().url(),
  WEB_PUBLIC_URL: z.string().url(),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  /**
   * Pooled connection for runtime queries. On Neon, the `-pooler` endpoint.
   * Must include `?sslmode=require`.
   */
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (url) => !url.includes('neon.tech') || url.includes('sslmode='),
      'Neon connections require sslmode — append ?sslmode=require to DATABASE_URL',
    ),
  /**
   * Direct, unpooled connection. Used by Prisma Migrate only; the running app
   * never opens it. Read by Prisma straight from the environment rather than
   * through this config, but validated here so a missing value fails at boot
   * rather than during a deploy migration.
   */
  DIRECT_DATABASE_URL: z.string().min(1, 'DIRECT_DATABASE_URL is required (see .env.example)'),

  // RS256 key pair. Base64-encoded PEM is recommended; raw PEM with escaped
  // newlines also works. Generate with: npm run keys:generate
  JWT_PRIVATE_KEY: z.string().min(1, 'JWT_PRIVATE_KEY is required (run: npm run keys:generate)'),
  /// Optional — derived from the private key when omitted. Validated to match.
  JWT_PUBLIC_KEY: z.string().optional(),

  JWT_ACCESS_TTL: z.string().default('15m'),
  /// Hard ceiling on a session, regardless of activity.
  SESSION_ABSOLUTE_TTL: z.string().default('30d'),
  /// Sliding window — a session idle for longer than this lapses.
  SESSION_IDLE_TTL: z.string().default('7d'),

  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: bool.default('false'),
  /**
   * Path the refresh cookie is scoped to. Narrow by default so it is never sent
   * on ordinary API calls.
   *
   * MUST be changed when the Next.js app proxies this API through a rewrite:
   * the browser sees the response as coming from /api/v1/auth/..., so a cookie
   * scoped to /v1/auth is never sent back and refresh silently 401s forever.
   * In that setup, set REFRESH_COOKIE_PATH=/api/v1/auth.
   */
  REFRESH_COOKIE_PATH: z.string().startsWith('/').default('/v1/auth'),

  /**
   * Google OAuth. All three must be set together or Google sign-in stays off —
   * `/v1/auth/google` returns 503 rather than redirecting to a broken consent
   * screen. Credentials come from a Web application OAuth client in the Google
   * Cloud console.
   */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /**
   * Must match a redirect URI registered on the OAuth client EXACTLY, including
   * scheme, host, port and path. Google compares the string, not the resolved
   * address.
   *
   * Point it at the Next.js origin, not this API: the browser reaches the API
   * through the /api/v1 rewrite, so the callback has to land on the same origin
   * that will hold the session cookies. Locally:
   *   http://localhost:3000/api/v1/auth/google/callback
   */
  GOOGLE_REDIRECT_URI: z.string().url().optional(),

  /**
   * Optional site-wide salt for legacy MySQL password digests (§2.8), for the
   * CodeIgniter pattern md5($pepper . $password). Leave unset unless the
   * legacy PHP source shows one. See lib/legacy-password.ts.
   */
  LEGACY_PASSWORD_PEPPER: z.string().optional(),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./.uploads'),
  AWS_REGION: z.string().default('ap-south-1'),
  S3_BUCKET: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(52_428_800),
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  MAIL_DRIVER: z.enum(['console', 'smtp']).default('console'),
  MAIL_FROM: z.string().default('Crowd4Test <no-reply@crowd4test.com>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: bool.default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

  SEED_ADMIN_EMAIL: z.string().email().default('admin@crowd4test.com'),
  SEED_ADMIN_PASSWORD: z.string().min(8).default('ChangeMe!2026'),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  console.error('Invalid environment configuration:')
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}

export const env = parsed.data

export const isProduction = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'

/**
 * Whether Google sign-in is configured. Checked at the route rather than at
 * boot: a deployment without Google credentials is a valid deployment, it just
 * offers password sign-in only.
 */
export const googleOAuthEnabled = Boolean(
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI,
)

// Guard rails that only matter in production.
if (isProduction) {
  if (env.STORAGE_DRIVER === 's3' && !env.S3_BUCKET) {
    throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3')
  }
  if (env.STORAGE_DRIVER === 'local') {
    throw new Error('STORAGE_DRIVER=local is not supported in production; use s3')
  }
  if (!env.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE must be true in production')
  }
}
