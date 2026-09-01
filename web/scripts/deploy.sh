#!/usr/bin/env bash
# Rebuilds and reloads the web app on EC2. Assumes the working tree is
# already at the commit to deploy — see ../../scripts/deploy-pull.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

npm ci

# ── Build beside the running build, never into it ────────────────────────────
#
# `next build` writes in place. A build killed partway — the OOM reaper on a
# small box is the usual cause — leaves the .next that is CURRENTLY BEING
# SERVED incomplete. Next reads it lazily, so the site does not fall over at
# deploy time; it fails minutes later with "client reference manifest does not
# exist" and needs a hand to recover. `set -e` stopping the reload does not
# help, because the damage is already on disk.
#
# Building into .next.new and renaming leaves the live build untouched until
# there is a complete replacement for it. A failure here — out of memory, out
# of disk, a bad commit — is then a failed deploy and nothing more.
rm -rf .next.new
NEXT_DIST_DIR=.next.new npm run build

# A build can exit 0 and still be short. BUILD_ID is written last, so its
# absence means the output is not finished, whatever the exit code said.
test -f .next.new/BUILD_ID

# Two renames, so the window where .next is not a complete build is
# milliseconds rather than the length of a build. The previous one is kept
# until the next deploy, which makes a rollback `mv .next.old .next`.
rm -rf .next.old
if [ -d .next ]; then mv .next .next.old; fi
mv .next.new .next

# `next build` rewrites tsconfig.json to register the generated types under
# whatever dist dir it just used — so building into .next.new adds
# ".next.new/types/**/*.ts" to `include` and leaves the tree dirty. That is
# harmless in itself (nothing type-checks on this box) but deploy-pull.sh
# refuses to reset a dirty tree, so it would block the NEXT deploy. Put the
# file back now, where the change was made, rather than leaving it for the
# next run to trip over.
git checkout -- tsconfig.json 2>/dev/null || true

pm2 startOrReload ecosystem.config.cjs --env production
pm2 save
