/**
 * PM2 process definition for the EC2 deployment — mirrors api/ecosystem.config.cjs.
 *
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 save && pm2 startup      # survive a reboot
 *   pm2 logs c4t-web
 *   pm2 reload c4t-web           # zero-downtime restart
 *
 * Runs the built `next start` server directly (not through `npm run start`)
 * so PM2 manages the actual Node process instead of an intermediate npm
 * shell — the same reasoning as most Next.js-under-PM2 setups.
 */
module.exports = {
  apps: [
    {
      name: 'c4t-web',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      cwd: __dirname,

      // A single Next.js server process. Nginx sits in front of it; there is
      // no in-process state that would benefit from cluster mode at this
      // scale, unlike the API's stateless-by-design services.
      instances: 1,
      exec_mode: 'fork',

      env_production: {
        NODE_ENV: 'production',
      },

      kill_timeout: 20000,
      listen_timeout: 10000,
      wait_ready: false,

      max_memory_restart: '512M',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '60s',
      restart_delay: 4000,

      output: '/var/log/c4t-web/out.log',
      error: '/var/log/c4t-web/error.log',
      merge_logs: true,
      time: false,
    },
  ],
}
