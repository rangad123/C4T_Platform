/**
 * The PM2 process for AI Studio on the Crowd4Test server. deploy.sh runs it.
 *
 * Node 24 is PM2's "script", with interpreter none, so PM2 starts that binary
 * directly. PM2's usual wrapper is skipped because it depends on the PM2
 * version: an older one require()s the entry file, and src/main.ts uses
 * top-level await.
 *
 * PATH is set here and only here, so the tools AI Studio starts get Node 24.
 * The C4T apps keep theirs.
 *
 * Secrets stay out of this file on purpose. Node reads them from the env file,
 * so they never land in PM2's dump file or in `pm2 env`. env.local is optional
 * and deploy.sh never rewrites it.
 *
 * NOTE: Node gives a variable already in the process environment priority over
 * --env-file, so PORT and HOST are repeated in `env` below. A stray value in the
 * shell that ran PM2 cannot move the app.
 */
const path = require('node:path')

const home = process.env.AI_STUDIO_HOME || '/home/ubuntu/.ai-studio'
const nodeBin = path.join(home, 'node', 'bin')

module.exports = {
  apps: [
    {
      name: 'ai-studio',
      cwd: path.resolve(__dirname, '..', '..'),
      script: path.join(nodeBin, 'node'),
      interpreter: 'none',
      args: [
        `--env-file=${path.join(home, 'env')}`,
        `--env-file-if-exists=${path.join(home, 'env.local')}`,
        '--import',
        'tsx',
        'src/main.ts',
      ],

      // One process: the job queue and SQLite live inside it.
      instances: 1,
      exec_mode: 'fork',

      env: {
        NODE_ENV: 'production',
        PORT: '4100',
        HOST: '127.0.0.1',
        PATH: `${nodeBin}:${process.env.PATH}`,
      },

      // Covers this process only. The browsers it starts are not counted.
      max_memory_restart: '1200M',
      // Shutdown takes up to 60 s of grace for a running job, 20 s to stop it and
      // 5 s to flush; a kill before that re-runs the job on the next start.
      kill_timeout: 100000,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '60s',
      restart_delay: 4000,

      output: path.join(home, 'logs', 'out.log'),
      error: path.join(home, 'logs', 'error.log'),
      merge_logs: true,
      time: true,
    },
  ],
}
