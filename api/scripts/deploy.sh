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

# Full install, not --omit=dev: the @types/* packages tsc needs to compile
# are dev dependencies. They're erased from the compiled dist/ output anyway,
# so leaving them installed at runtime costs disk, not correctness.
npm ci
npx prisma generate
npm run build
# `--update-env` is precautionary, not a fix for anything observed.
#
# The API reads its configuration with `dotenv`, which does NOT overwrite a
# variable already present in the process environment. PM2 keeps its own copy
# of whatever env a process was first started with, and `pm2 save` below
# persists it, so a stale value in that dump would silently outrank .env and
# survive every deploy — a failure that looks exactly like "the config change
# did not take" and is very hard to see from the outside.
#
# It has not happened here: `pm2 env` was checked during one of these hunts
# and held none of these keys. This keeps it from starting to.
pm2 startOrReload ecosystem.config.cjs --env production --update-env
pm2 save
