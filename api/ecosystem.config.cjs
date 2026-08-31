/**
 * PM2 process definition for the EC2 deployment (Agreement §2.7).
 *
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 save && pm2 startup      # survive a reboot
 *   pm2 logs c4t-api
 *   pm2 reload c4t-api           # zero-downtime restart
 *
 * `pm2 reload` works with the graceful shutdown in src/index.ts: PM2 sends
 * SIGINT, the process stops accepting connections, drains in-flight requests,
 * closes the Prisma pool, then exits.
 */
// An unset OR empty PM2_INSTANCES both mean "use every core", which is why
// this is an explicit truthiness check rather than `??`.
const configuredInstances = process.env.PM2_INSTANCES?.trim()

module.exports = {
  apps: [
    {
      name: 'c4t-api',
      script: 'dist/index.js',
      cwd: __dirname,

      /**
       * ONE INSTANCE BY DEFAULT, and that is load-bearing.
       *
       * This used to say `'max'`, on the reasoning that the API holds no
       * in-process state because sessions live in Postgres. That is true of
       * sessions and false of the Google OAuth handoff: `lib/oauth/handoff.ts`
       * keeps its one-time codes in a `Map`, and says so — "this API runs as a
       * single instance" is written into that file as an assumption.
       *
       * With two workers it stopped being true. Google's callback lands on one
       * worker and mints a code into that worker's memory; the web app's
       * exchange call is balanced to whichever worker is free, and finding no
       * such code, refuses it. Sign-in then failed about half the time, with
       * `google_failed` and nothing in the logs to say why.
       *
       * Raising this again means making that handoff shared first — a table,
       * or signing the payload into the code instead of storing it. Until
       * then `PM2_INSTANCES` is an override for someone who has done that
       * work, not a tuning knob.
       */
      instances: configuredInstances ? Number(configuredInstances) : 1,
      exec_mode: 'cluster',

      env_production: {
        NODE_ENV: 'production',
      },

      // Give in-flight requests time to finish before SIGKILL.
      kill_timeout: 20000,
      // Wait for the process to signal readiness rather than assuming it.
      listen_timeout: 10000,
      wait_ready: false,

      max_memory_restart: '512M',
      autorestart: true,
      // If it crashes 10 times inside a minute, stop trying — something is
      // genuinely broken and a restart loop only hides it.
      max_restarts: 10,
      min_uptime: '60s',
      restart_delay: 4000,

      // stdout/stderr are JSON from Pino; the CloudWatch agent ships these.
      output: '/var/log/c4t-api/out.log',
      error: '/var/log/c4t-api/error.log',
      merge_logs: true,
      time: false,
    },
  ],
}
