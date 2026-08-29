#!/usr/bin/env bash
# Rebuilds and reloads the web app on EC2. Assumes the working tree is
# already at the commit to deploy — see ../../scripts/deploy-pull.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

npm ci
npm run build
pm2 startOrReload ecosystem.config.cjs --env production
pm2 save
