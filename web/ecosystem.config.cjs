/**
 * PM2 process definition for the EC2 deployment — mirrors api/ecosystem.config.cjs.
 *
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 save && pm2 startup      # survive a reboot
 *   pm2 logs c4t-web
 *   pm2 reload c4t-web           # zero-downtime restart
 *
 * Runs through `npm start` (→ `next start`), matching how this box already
 * ran it before this file existed. Invoking the `next` binary directly was
 * tried first and broke: PM2 has no file extension to detect an interpreter
 * from, ran it through a bare shell, and lost the executable's own node
 * shebang — "next: not found", then once the args shifted, "start" saw a
 * bare positional "3000" and read it as `next start <directory>` instead of
 * a port. Port comes from PORT below rather than a `-p` flag for the same
 * reason: one less place for an argument to get mis-split.
 */
module.exports = {
  apps: [
    {
      name: 'c4t-web',
      script: 'npm',
      args: 'start',
      cwd: __dirname,

      // A single Next.js server process. Nginx sits in front of it; there is
      // no in-process state that would benefit from cluster mode at this
      // scale, unlike the API's stateless-by-design services.
      instances: 1,
      exec_mode: 'fork',

      env_production: {
        NODE_ENV: 'production',
        PORT: '3000',
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
