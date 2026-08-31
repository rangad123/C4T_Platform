#!/usr/bin/env bash
# Fetches and hard-resets the EC2 checkout to origin/main.
#
# Shared by both api/scripts/deploy.sh and web/scripts/deploy.sh (invoked
# once, from the repo root) rather than duplicated in each — there is one
# working directory on the box, and the two apps' deploy workflows are
# serialized onto the same concurrency group specifically so this can't run
# twice at once against it.
set -euo pipefail
cd "$(dirname "$0")/.."

# Generated files the box rewrites itself, restored before the check below.
#
# `next build` regenerates web/next-env.d.ts with different contents from the
# ones `next dev` writes, so the deploy's own build left the tree dirty and
# every SUBSEQUENT deploy was refused — the guard doing its job, on a change
# no human made. These are discarded rather than protected: Next owns the
# file and says so in its header, so there is nothing here to lose.
#
# Listed explicitly. A blanket `git checkout .` would defeat the guard.
for generated in web/next-env.d.ts; do
  git checkout -- "$generated" 2>/dev/null || true
done

# A `git reset --hard` below would silently discard anything not committed —
# most likely a hotfix edited directly on the box and never pushed. Fail
# loud instead of guessing which one of "this deploy" or "that edit" should
# win.
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree has uncommitted changes — refusing to reset. Commit, stash, or discard them on the box first." >&2
  git status --short >&2
  exit 1
fi

git fetch origin main
git reset --hard origin/main
