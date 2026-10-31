#!/usr/bin/env bash
# Deploys AI Studio on the Crowd4Test server. Runs from the checkout, after
# scripts/deploy-pull.sh, through .github/workflows/ai-studio-deploy.yml.
# Safe to run again. See README.md in this folder.
#
# Rules this script keeps:
#   - Node 24 is on PATH only inside gentle(). pm2 always runs with the box's own
#     PATH, because `pm2 ... --update-env` copies this shell's PATH into the app
#     it restarts, and c4t-web runs through whatever `npm` it finds there.
#   - pm2 never sees the secrets, for the same reason. See pm2_clean().
#   - The data folder is never deleted or moved.
#   - No `set -x`, and no value of a secret in any message.
set -euo pipefail

SITE_NAME=aistudio.crowd4test.com
NODE_VERSION=24.22.2
NODE_DIST="https://nodejs.org/dist/v${NODE_VERSION}"
APP_PORT=4100
# Measured with npm 11 and Node 24: npm ci about 650 MB, the web build about 1 GB.
MIN_FREE_MB="${MIN_FREE_MB:-1500}"
# node_modules 325 MB, Chromium about 600 MB, the Node download, room to spare.
MIN_DISK_MB=2500

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ROOT_DIR="$(cd "$APP_DIR/.." && pwd)"

# The overrides exist so the script can be tried in a scratch folder.
export AI_STUDIO_HOME="${AI_STUDIO_HOME:-/home/ubuntu/.ai-studio}"
NGINX_DIR="${NGINX_DIR:-/etc/nginx}"
NODE_DIR="$AI_STUDIO_HOME/node"
DATA_DIR="$AI_STUDIO_HOME/data"
ENV_FILE="$AI_STUDIO_HOME/env"
BACKUP_DIR="$AI_STUDIO_HOME/backups"
LOCK_STAMP="$AI_STUDIO_HOME/installed-lock.sha256"
SITE_STAMP="$AI_STUDIO_HOME/installed-site.sha256"
SITE_FILE="$NGINX_DIR/sites-available/$SITE_NAME"
HEALTH_URL="http://127.0.0.1:$APP_PORT/api/health"
SECRET_NAMES=(AI_STUDIO_SECRET_KEY AI_STUDIO_API_KEY AI_STUDIO_SERVICE_TOKEN)

say() { printf '[ai-studio] %s\n' "$*"; }
die() {
  printf '[ai-studio] %s\n' "$*" >&2
  exit 1
}

# Commands that use Node 24. Low priority, first in line for the OOM killer, and
# without the secrets, so a heavy build gives way to the running apps and no
# package's install script can read them.
gentle() {
  (
    for name in "${SECRET_NAMES[@]}"; do unset "$name"; done
    export PATH="$NODE_DIR/bin:$PATH"
    echo 900 >/proc/self/oom_score_adj 2>/dev/null || true
    exec nice -n 15 "$@"
  )
}

pm2_clean() {
  env -u AI_STUDIO_SECRET_KEY -u AI_STUDIO_API_KEY -u AI_STUDIO_SERVICE_TOKEN \
    -u ENABLE_SHARED_SIGN_IN pm2 "$@"
}

check_secrets() {
  local name value
  for name in "${SECRET_NAMES[@]}"; do
    value="${!name:-}"
    # An empty SECRET_KEY written to the env file would make every stored
    # credential unreadable, so this stops before anything changes.
    [ -n "$value" ] || die "$name is not set. Add it to the repository's Actions secrets. Nothing was changed."
    # The env file is plain KEY=value, and the action quotes values in single quotes.
    [[ "$value" =~ ^[A-Za-z0-9_+/=.-]+$ ]] || die "$name has characters this script does not write. Use the output of openssl rand -hex 32."
  done
  [ "${#AI_STUDIO_SECRET_KEY}" -ge 32 ] || die "AI_STUDIO_SECRET_KEY must be at least 32 characters."
  # Shorter ones are ignored by the Crowd4Test API (api/src/config/env.ts).
  [ "${#AI_STUDIO_SERVICE_TOKEN}" -ge 32 ] || die "AI_STUDIO_SERVICE_TOKEN must be at least 32 characters."
  return 0
}

prepare_dirs() {
  umask 077
  mkdir -p "$AI_STUDIO_HOME" "$BACKUP_DIR" "$BACKUP_DIR/data" "$AI_STUDIO_HOME/logs"
  # Outside the checkout: deploy-pull.sh hard-resets that. Created once, never deleted.
  mkdir -p "$DATA_DIR"
  umask 022
}

ensure_node() {
  if [ "$("$NODE_DIR/bin/node" -v 2>/dev/null || true)" = "v$NODE_VERSION" ]; then
    return 0
  fi
  [ "$(uname -m)" = x86_64 ] || die "This script installs Node for x64, and this box is $(uname -m)."
  say "installing Node $NODE_VERSION into $NODE_DIR"
  local tarball="node-v${NODE_VERSION}-linux-x64.tar.gz" work
  work="$(mktemp -d "$AI_STUDIO_HOME/node-install.XXXXXX")"
  curl -fsSL --retry 3 -o "$work/$tarball" "$NODE_DIST/$tarball"
  curl -fsSL --retry 3 -o "$work/SHASUMS256.txt" "$NODE_DIST/SHASUMS256.txt"
  (cd "$work" && grep -F "  $tarball" SHASUMS256.txt | sha256sum -c --quiet -) \
    || die "The Node download does not match its SHA256 from nodejs.org."
  mkdir "$work/unpacked"
  tar -xzf "$work/$tarball" -C "$work/unpacked" --strip-components=1
  rm -rf "$NODE_DIR.old"
  if [ -d "$NODE_DIR" ]; then mv "$NODE_DIR" "$NODE_DIR.old"; fi
  mv "$work/unpacked" "$NODE_DIR"
  rm -rf "$NODE_DIR.old" "$work"
}

write_env() {
  local tmp
  tmp="$(mktemp "$AI_STUDIO_HOME/env.XXXXXX")"
  {
    printf 'PORT=%s\n' "$APP_PORT"
    printf 'HOST=127.0.0.1\n'
    printf 'DATA_DIR=%s\n' "$DATA_DIR"
    printf 'API_KEY=%s\n' "$AI_STUDIO_API_KEY"
    printf 'SECRET_KEY=%s\n' "$AI_STUDIO_SECRET_KEY"
    printf 'C4T_API_ORIGIN=http://127.0.0.1:4000\n'
    printf 'C4T_SITE_URL=https://crowd4test.com\n'
    # AI Studio's name for the API's AI_STUDIO_SERVICE_TOKEN (src/config.ts).
    printf 'C4T_SERVICE_TOKEN=%s\n' "$AI_STUDIO_SERVICE_TOKEN"
    printf 'PUBLIC_URL=https://%s\n' "$SITE_NAME"
    printf 'COOKIE_SECURE=true\n'
    # This box also runs production. Tests may not aim at its own ports or the
    # EC2 metadata address, and one browser at a time keeps memory for the C4T
    # apps. env.local can raise CONCURRENCY.
    printf 'BLOCK_PRIVATE_TARGETS=true\n'
    printf 'CONCURRENCY=1\n'
    # Tests stay off here. Without a worker no queued job, schedule or security
    # assessment runs, because anything run on this box can read what the ubuntu
    # user can, the C4T env files included. See "Tests are off" in README.md
    # before changing this.
    printf 'WORKER_EMBEDDED=false\n'
    # The disk is shared with crowd4test.com: evidence is kept 14 days, and the
    # database is backed up daily (7 kept) beside the deploy's own backups.
    # Copying them off this disk needs BACKUP_UPLOAD_COMMAND in env.local.
    printf 'RETENTION_DEFAULT_DAYS=14\n'
    printf 'BACKUP_DIR=%s/data\n' "$BACKUP_DIR"
  } >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$ENV_FILE"
}

check_room() {
  local free_mb disk_mb
  free_mb="$(awk '/^(MemAvailable|SwapFree):/ { kb += $2 } END { print int(kb / 1024) }' /proc/meminfo)"
  [ "$free_mb" -ge "$MIN_FREE_MB" ] || die "Only $free_mb MB of memory and swap are free, and this deploy needs $MIN_FREE_MB MB. Stopped so it cannot push the running apps out."
  disk_mb="$(df -Pm "$AI_STUDIO_HOME" | awk 'NR == 2 { print $4 }')"
  [ "$disk_mb" -ge "$MIN_DISK_MB" ] || die "Only $disk_mb MB of disk are free, and this deploy needs $MIN_DISK_MB MB."
}

install_packages() {
  local want have=""
  want="$(sha256sum <"$APP_DIR/package-lock.json" | cut -d' ' -f1)-$NODE_VERSION"
  if [ -f "$LOCK_STAMP" ]; then have="$(cat "$LOCK_STAMP")"; fi
  cd "$APP_DIR"
  if [ "$want" = "$have" ] && [ -d node_modules ]; then
    say "packages unchanged, skipping npm ci"
    return 0
  fi
  # --include=dev: tsx runs the app and vite builds it (see the project's Dockerfile).
  gentle npm ci --include=dev --no-audit --no-fund
  printf '%s\n' "$want" >"$LOCK_STAMP"
}

build_app() {
  cd "$APP_DIR"
  gentle npm run build:web
  # Chromium only, and no --with-deps: its libraries came with Puppeteer's Chrome.
  gentle npx playwright install chromium
}

start_app() {
  cd "$SCRIPT_DIR"
  pm2_clean startOrReload ecosystem.config.cjs --update-env
  pm2_clean save
  say "waiting for $HEALTH_URL"
  local attempt
  for attempt in $(seq 1 60); do
    if curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null | grep -q '"status":"ok"'; then
      say "healthy"
      return 0
    fi
    sleep 2
  done
  # There is often no shell on the box to look from, so the reason goes in the run's log.
  tail -n 20 "$AI_STUDIO_HOME/logs/error.log" >&2 2>/dev/null || true
  die "AI Studio did not answer on $HEALTH_URL. The last lines of its error log are above."
}

# deploy-pull.sh refuses a dirty tree, so anything left here blocks the next deploy of every app.
check_tree() {
  local dirty
  dirty="$(git -C "$ROOT_DIR" status --porcelain -- AI_Studio)"
  if [ -n "$dirty" ]; then
    printf '%s\n' "$dirty" >&2
    die "The deploy left AI_Studio changed in the checkout, which would block the next deploy."
  fi
}

# ── Going live ───────────────────────────────────────────────────────────────

dns_points_here() {
  local resolved box_ip
  resolved="$(getent ahostsv4 "$SITE_NAME" 2>/dev/null | awk '{ print $1 }' | sort -u || true)"
  [ -n "$resolved" ] || return 1
  box_ip="$(curl -fsS --max-time 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
  [ -n "$box_ip" ] && printf '%s\n' "$resolved" | grep -Fxq "$box_ip"
}

# A site that fails `nginx -t` would also stop every later reload for
# crowd4test.com, so a bad one is taken out again before this script stops.
# Sets SITE_CHANGED rather than returning it: as an `if` condition this function
# would run with `set -e` off, and a failed sudo would pass unnoticed.
install_site() {
  local template="$SCRIPT_DIR/nginx-site.conf" want have="" saved=""
  SITE_CHANGED=false
  sudo test -d "$NGINX_DIR/sites-enabled" || die "$NGINX_DIR/sites-enabled does not exist, so this box lays out nginx differently. Nothing was changed."
  want="$(sha256sum <"$template" | cut -d' ' -f1)"
  if [ -f "$SITE_STAMP" ]; then have="$(cat "$SITE_STAMP")"; fi
  if [ "$want" = "$have" ] && sudo test -f "$SITE_FILE"; then
    return 0
  fi
  if sudo test -f "$SITE_FILE"; then
    saved="$BACKUP_DIR/nginx-site.$(date +%Y%m%d-%H%M%S)"
    sudo cat "$SITE_FILE" >"$saved"
  fi
  sudo cp "$template" "$SITE_FILE"
  sudo chmod 644 "$SITE_FILE"
  sudo ln -sf "$SITE_FILE" "$NGINX_DIR/sites-enabled/$SITE_NAME"
  if ! sudo nginx -t; then
    if [ -n "$saved" ]; then
      sudo cp "$saved" "$SITE_FILE"
    else
      sudo rm -f "$NGINX_DIR/sites-enabled/$SITE_NAME" "$SITE_FILE"
    fi
    die "nginx rejected the site, so it was taken out again. The other sites are untouched."
  fi
  sudo systemctl reload nginx
  printf '%s\n' "$want" >"$SITE_STAMP"
  SITE_CHANGED=true
}

ensure_certbot() {
  if command -v certbot >/dev/null 2>&1 && dpkg -s python3-certbot-nginx >/dev/null 2>&1; then
    return 0
  fi
  say "installing certbot and its nginx plugin"
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-nginx
}

go_live() {
  install_site
  # Rewriting the site drops the lines certbot added, so it runs again then.
  # --keep-until-expiring puts the existing certificate back without a new order.
  if [ "$SITE_CHANGED" = true ] || ! sudo grep -q ssl_certificate "$SITE_FILE"; then
    ensure_certbot
    sudo certbot --nginx -d "$SITE_NAME" --non-interactive --agree-tos \
      --register-unsafely-without-email --keep-until-expiring --redirect
  fi
  say "$SITE_NAME is served by nginx"
}

answers_over_https() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if curl -fsS --max-time 10 "https://$SITE_NAME/api/health" 2>/dev/null | grep -q '"status":"ok"'; then
      return 0
    fi
    sleep 3
  done
  return 1
}

# ── Shared sign-in ───────────────────────────────────────────────────────────

# Next reads these in this order for `next start`, and the first file to set a
# variable wins, so the first one that exists is the one to change.
web_env_file() {
  local name
  for name in .env.production.local .env.local .env.production .env; do
    if [ -f "$ROOT_DIR/web/$name" ]; then
      printf '%s\n' "$ROOT_DIR/web/$name"
      return 0
    fi
  done
  return 1
}

# awk reads the line from its environment, so a token never shows in `ps`.
env_has() {
  ENV_LINE="$2=$3" awk 'BEGIN { line = ENVIRON["ENV_LINE"] } $0 == line { found = 1 } END { exit !found }' "$1"
}

# Sets KEY=value in place, keeps the file's owner and mode, leaves one line for
# the key. awk reads the value from its environment, not from the command line.
env_set() {
  local file="$1" tmp
  tmp="$(mktemp "$AI_STUDIO_HOME/envset.XXXXXX")"
  ENV_KEY="$2" ENV_VALUE="$3" awk '
    BEGIN { line = ENVIRON["ENV_KEY"] "=" ENVIRON["ENV_VALUE"]; prefix = ENVIRON["ENV_KEY"] "=" }
    index($0, prefix) == 1 { if (!done) { print line; done = 1 } next }
    { print }
    END { if (!done) print line }
  ' "$file" >"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

restart_c4t() {
  # NOTE: the API must stay one instance: the Google sign-in handoff is held in
  # its memory (api/ecosystem.config.cjs). `pm2 restart` keeps the count.
  pm2_clean restart c4t-api --update-env
  pm2_clean restart c4t-web --update-env
}

c4t_answers() {
  local attempt
  for attempt in $(seq 1 20); do
    if curl -fsS --max-time 5 http://127.0.0.1:4000/health >/dev/null 2>&1 \
      && curl -fsS --max-time 5 http://127.0.0.1:3000/ >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

# Only with enable_shared_sign_in=true. The new values are read when the apps
# start, so a restart is enough and no rebuild is needed: only NEXT_PUBLIC_*
# variables are fixed at build time, and neither of these is one.
enable_shared_sign_in() {
  local web_env api_env="$ROOT_DIR/api/.env" stamp web_saved api_saved
  web_env="$(web_env_file)" || die "No env file found in $ROOT_DIR/web. Nothing was changed."
  [ -f "$api_env" ] || die "$api_env does not exist. Nothing was changed."

  if env_has "$web_env" AUTH_COOKIE_DOMAIN .crowd4test.com \
    && env_has "$web_env" AI_STUDIO_URL "https://$SITE_NAME" \
    && env_has "$api_env" COOKIE_DOMAIN .crowd4test.com \
    && env_has "$api_env" AI_STUDIO_SERVICE_TOKEN "$AI_STUDIO_SERVICE_TOKEN"; then
    say "shared sign-in is already on"
    return 0
  fi

  stamp="$(date +%Y%m%d-%H%M%S)"
  web_saved="$BACKUP_DIR/web-env.$stamp"
  api_saved="$BACKUP_DIR/api-env.$stamp"
  (umask 077 && cp "$web_env" "$web_saved" && cp "$api_env" "$api_saved")

  env_set "$web_env" AUTH_COOKIE_DOMAIN .crowd4test.com
  env_set "$web_env" AI_STUDIO_URL "https://$SITE_NAME"
  env_set "$api_env" COOKIE_DOMAIN .crowd4test.com
  env_set "$api_env" AI_STUDIO_SERVICE_TOKEN "$AI_STUDIO_SERVICE_TOKEN"
  restart_c4t

  if ! c4t_answers; then
    cat "$web_saved" >"$web_env"
    cat "$api_saved" >"$api_env"
    restart_c4t
    die "crowd4test.com did not come back after the change, so both env files were restored and the apps restarted."
  fi
  pm2_clean save
  say "shared sign-in is on (backups in $BACKUP_DIR)"
}

main() {
  check_secrets
  prepare_dirs
  check_room
  ensure_node
  write_env
  install_packages
  build_app
  start_app
  check_tree

  if ! dns_points_here; then
    say "$SITE_NAME does not resolve to this box yet: skipping nginx, TLS and shared sign-in. The deploy still succeeds."
    return 0
  fi
  go_live
  if [ "${ENABLE_SHARED_SIGN_IN:-false}" != true ]; then
    return 0
  fi
  answers_over_https || die "https://$SITE_NAME does not answer, so the shared sign-in was not changed."
  enable_shared_sign_in
}

main
