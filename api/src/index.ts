import { createApp } from './app.js'
import { env } from './config/env.js'
import { logger } from './lib/logger.js'
import { prisma, disconnectPrisma } from './lib/prisma.js'
import { syncPermissionCatalogue } from './lib/permission-catalogue.js'

async function main(): Promise<void> {
  // Fail to boot rather than serve 500s if RDS is unreachable.
  await prisma.$connect()
  logger.info('Database connection established')

  // New permission codes reach the database without a manual seed. A failure
  // is logged, not fatal: every other feature works on the rows already there.
  try {
    const synced = await syncPermissionCatalogue(prisma)
    if (synced.created > 0 || synced.updated > 0) {
      logger.info(synced, 'Permission catalogue synced')
    }
  } catch (error) {
    logger.error({ err: error }, 'Permission catalogue sync failed')
  }

  const app = createApp()
  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, storage: env.STORAGE_DRIVER, mail: env.MAIL_DRIVER },
      `Crowd4Test API listening on port ${env.PORT}`,
    )
  })

  // Graceful shutdown: stop accepting connections, drain in-flight requests,
  // then close the pool. Matters on EC2 during a deploy or scale-in.
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received, draining connections')

    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out after 15s, forcing exit')
      process.exit(1)
    }, 15_000)
    forceExit.unref()

    server.close(async (error) => {
      if (error) logger.error({ err: error }, 'Error while closing HTTP server')
      try {
        await disconnectPrisma()
        logger.info('Database pool closed. Exiting.')
        process.exit(error ? 1 : 0)
      } catch (disconnectError) {
        logger.error({ err: disconnectError }, 'Failed to close database pool')
        process.exit(1)
      }
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection')
    shutdown('unhandledRejection')
  })

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception')
    process.exit(1)
  })
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Failed to start the API')
  process.exit(1)
})
