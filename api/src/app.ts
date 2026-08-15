import express, { type Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import { pinoHttp } from 'pino-http'
import type { IncomingMessage } from 'node:http'
import { env, isProduction } from './config/env.js'
import { logger } from './lib/logger.js'
import { prisma } from './lib/prisma.js'
import { buildJwks } from './lib/keys.js'
import { requestId } from './middleware/requestId.js'
import { globalLimiter } from './middleware/rateLimit.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { v1Router } from './routes/index.js'

export function createApp(): Express {
  const app = express()

  // Running behind an ALB or nginx on EC2: trust one proxy hop so req.ip and
  // the rate limiter see the real client address rather than the load balancer.
  app.set('trust proxy', 1)
  app.disable('x-powered-by')

  app.use(requestId)

  app.use(
    pinoHttp({
      logger,
      genReqId: (req: IncomingMessage) => (req as { requestId?: string }).requestId ?? 'unknown',
      autoLogging: {
        ignore: (req: IncomingMessage) => req.url === '/health' || req.url === '/health/ready',
      },
    }),
  )

  app.use(
    helmet({
      // This API serves JSON and signed-URL redirects only; it never renders
      // HTML, so the default CSP would only get in the way.
      contentSecurityPolicy: false,
      // `cross-origin` is needed when the web app is on a different domain
      // from the API (Vercel on one, Render on the other). `same-site`
      // would block fetches from the Vercel front end to the Render API.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  )

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and server-to-server calls arrive without an Origin header.
        if (!origin) return callback(null, true)
        if (env.CORS_ORIGINS.includes(origin)) return callback(null, true)
        return callback(new Error(`Origin ${origin} is not allowed`))
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 86_400,
    }),
  )

  app.use(compression())
  app.use(cookieParser())

  // The local-upload endpoint needs a raw body; it registers its own parser
  // before this JSON parser sees the request.
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true, limit: '1mb' }))

  // ─── Health ────────────────────────────────────────────────────────────────
  // Liveness: is the process up? Used by the EC2 target group.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), env: env.NODE_ENV })
  })

  // Readiness: can we actually serve traffic (i.e. is RDS reachable)?
  app.get('/health/ready', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`
      res.json({ status: 'ready', database: 'up' })
    } catch (error) {
      logger.error({ err: error }, 'Readiness check failed')
      res.status(503).json({ status: 'not-ready', database: 'down' })
    }
  })

  // ─── JWKS ──────────────────────────────────────────────────────────────────
  // Public verification key for RS256 access tokens. Lets the Next.js app (and
  // any other service) verify a token locally without holding anything that
  // could mint one. Public by design — it contains no secret material.
  app.get('/.well-known/jwks.json', (_req, res) => {
    res.setHeader('cache-control', 'public, max-age=3600, stale-while-revalidate=86400')
    res.json(buildJwks())
  })

  // ─── API ───────────────────────────────────────────────────────────────────
  app.use('/v1', globalLimiter, v1Router)

  // ─── Terminal handlers (must be last) ──────────────────────────────────────
  app.use(notFoundHandler)
  app.use(errorHandler)

  if (!isProduction) {
    logger.info({ corsOrigins: env.CORS_ORIGINS }, 'CORS origins configured')
  }

  return app
}
