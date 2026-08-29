#!/usr/bin/env bash
# Rebuilds and reloads the API on EC2. Assumes the working tree is already
# at the commit to deploy — see ../../scripts/deploy-pull.sh.
#
# Deliberately does NOT touch the database. A schema change is a deliberate,
# reviewed step run by hand (`npx prisma db push` — never `migrate deploy`,
# the migration history predates most of the current models), not something
# an unattended push-to-deploy pipeline should risk running against
# production data on every commit.
set -euo pipefail
cd "$(dirname "$0")/.."

npm ci --omit=dev
npx prisma generate
npm run build
pm2 startOrReload ecosystem.config.cjs --env production
pm2 save
