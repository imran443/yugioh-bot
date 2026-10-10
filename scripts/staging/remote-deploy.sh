#!/bin/sh
# Runs ON THE VM. The workflow .github/workflows/deploy-staging.yml sends it over ssh:
#
#   ssh user@vm "env STAGING_REF='...' STAGING_ACTION='deploy' ... sh -s" < scripts/staging/remote-deploy.sh
#
# Input (environment):
#   STAGING_ACTION       deploy (default) or stop
#   STAGING_REF          the git ref or SHA to run (required for deploy)
#   STAGING_COMMIT       exact checked-out CI commit (required for deploy)
#   STAGING_REFRESH_DB   "true" copies the production database again (default false)
#   STAGING_IGNORE_PROD_ACTIVITY  "true" skips only the activity guard (manual dispatch only, default false)
#   STAGING_HOST         public address of the VM, used only when .env.staging does not exist yet
#   STAGING_DOMAIN       host name for the staging address, used only when .env.staging does not exist yet (optional)
#   STAGING_HTTP_PORT    host port of staging (optional, default 8080, never below 1024)
#   STAGING_CLERK_ENV    separate staging Clerk source on the VM (default /etc/yugidraft/staging-clerk.env)
#   STAGING_BUNDLE       the engine bundle sent to a mktemp path by the workflow (required for deploy)
#   STAGING_GUARD        the activity guard from the main workflow revision (required for deploy)
#
# It works in /opt/yugioh-bot-staging. Community config comes from production .env; Clerk keys
# come only from STAGING_CLERK_ENV. It also reads data/bot.sqlite (read-only, through the activity guard
# and copy-staging-db.sh) and the git remote URL (only for the first clone). It never runs docker compose in
# /opt/yugioh-bot and never writes there.
set -eu

action=${STAGING_ACTION:-deploy}
refresh_db=${STAGING_REFRESH_DB:-false}
staging_dir=${STAGING_DIR:-/opt/yugioh-bot-staging}
prod_dir=/opt/yugioh-bot
bundle=${STAGING_BUNDLE:-}
guard=${STAGING_GUARD:-}

skip_staging() {
  echo "::warning title=Staging skipped::skipping staging; $*"
  exit 0
}

if [ "$staging_dir" = "$prod_dir" ]; then
  echo "remote-deploy: the staging directory is the production directory. Stopping." >&2
  exit 1
fi

# Take the shared lock before changing the checkout, env or build context, including for stop.
# Production has priority: staging deploys do not wait. Stops wait or fail.
lock=${STAGING_BUILD_LOCK:-/var/lock/yugidraft-build.lock}
if [ "$action" = "deploy" ]; then
  [ -n "$bundle" ] || { echo "remote-deploy: STAGING_BUNDLE is required" >&2; exit 1; }
  trap 'rm -f "$bundle" "$guard"' EXIT
fi
if ! command -v flock >/dev/null 2>&1; then
  echo "remote-deploy: flock is required. Install util-linux." >&2
  exit 1
fi
exec 9>"$lock"
if [ "$action" = "stop" ]; then
  if ! flock -w "${STAGING_LOCK_WAIT_S:-900}" 9; then
    echo "remote-deploy: staging stop failed; another build holds $lock. Run Stop again." >&2
    exit 1
  fi
elif ! flock -n 9; then
  skip_staging "another build holds $lock. Production has priority."
fi

# Context cleanup is safe only after this process holds the lock.
if [ "$action" = "deploy" ]; then
  trap 'rm -f "$bundle" "$guard"; rm -rf "$staging_dir/.deploy-duel-engine"' EXIT
  # Read production activity before cloning, fetching, resetting or changing the env.
  # Staging counts only live duels, openings and active drafts. Guard failures also skip.
  if [ "${STAGING_IGNORE_PROD_ACTIVITY:-false}" = "true" ]; then
    echo "remote-deploy: ignore_prod_activity=true; skipping only the production activity guard."
  elif [ -z "$guard" ] || ! python3 "$guard" "$prod_dir/data/bot.sqlite" --target staging; then
    skip_staging "production gameplay is active or the activity guard failed. Existing staging containers keep running."
  fi
fi

# First run: the clone. The owner makes the folder once (docs/deployment/staging.md).
if [ ! -d "$staging_dir/.git" ]; then
  if [ "$action" = "stop" ]; then
    echo "remote-deploy: $staging_dir does not exist. Nothing to stop."
    exit 0
  fi
  if [ ! -d "$staging_dir" ]; then
    mkdir -p "$staging_dir" 2>/dev/null || {
      echo "remote-deploy: cannot create $staging_dir. Owner step: sudo mkdir $staging_dir && sudo chown $(id -un): $staging_dir" >&2
      exit 1
    }
  fi
  origin=$(git -C "$prod_dir" config --get remote.origin.url)
  [ -n "$origin" ] || { echo "remote-deploy: cannot read the git remote of $prod_dir" >&2; exit 1; }
  echo "remote-deploy: first run, cloning into $staging_dir"
  git clone "$origin" "$staging_dir"
fi

cd "$staging_dir"

if [ "$action" = "deploy" ]; then
  [ -n "${STAGING_REF:-}" ] || { echo "remote-deploy: STAGING_REF is required" >&2; exit 1; }
  printf '%s' "${STAGING_COMMIT:-}" | grep -Eq '^[0-9a-f]{40}$' || {
    echo "remote-deploy: STAGING_COMMIT must be the exact CI commit" >&2; exit 1;
  }
  git fetch origin "$STAGING_COMMIT"
  git reset --hard "$STAGING_COMMIT"
  echo "remote-deploy: staging code is now $(git rev-parse --short HEAD) from $STAGING_REF"
fi

compose() { sh scripts/staging/compose.sh "$@"; }

if [ "$action" = "stop" ]; then
  if [ -f .env.staging ]; then
    # --rmi local removes the four images that staging built (not the public caddy image).
    compose down --rmi local --remove-orphans
    echo "remote-deploy: staging is stopped and its built images are removed. Its data stays in $staging_dir/data-staging."
  else
    echo "remote-deploy: no .env.staging, nothing to stop."
  fi
  free -m || true
  exit 0
fi

[ "$action" = "deploy" ] || { echo "remote-deploy: unknown action $action" >&2; exit 1; }
[ -f "$bundle" ] || { echo "remote-deploy: engine bundle $bundle not found" >&2; exit 1; }

# 1. The env file, only when it is missing. Secrets stay on the VM.
if [ ! -f .env.staging ]; then
  [ -f "$prod_dir/.env" ] || { echo "remote-deploy: $prod_dir/.env not found" >&2; exit 1; }
  STAGING_CLERK_ENV=${STAGING_CLERK_ENV:-/etc/yugidraft/staging-clerk.env} \
  STAGING_HOST=${STAGING_HOST:-} STAGING_DOMAIN=${STAGING_DOMAIN:-} STAGING_HTTP_PORT=${STAGING_HTTP_PORT:-8080} \
    sh scripts/staging/make-staging-env.sh "$prod_dir/.env" .env.staging
fi

# 2. The shared build lock is held until this script exits.
# Free the memory of the old staging stack, then check the build resources.
compose stop || true
if pgrep -f 'turbo run build|next build' >/dev/null 2>&1; then
  skip_staging "another build is running on this VM."
fi
# The disk is shared with the production database. Each staging image holds a full node_modules.
if ! sh scripts/staging/check-resources.sh "before build" "${STAGING_MIN_BUILD_MB:-1100}" "${STAGING_MIN_DISK_MB:-6000}" /opt; then
  skip_staging "the build resource check did not pass. Staging stays down."
fi

# Worker startup and IMAGE_CLEANUP_CRON evict the oldest cached images to the configured byte limit.

# 3. Build the four images. Remember the ids of the old ones, to remove them after a healthy start.
# CI already compiled both multi cores; bake this exact bundle into the duel image.
rm -rf .deploy-duel-engine
mkdir .deploy-duel-engine
tar -C .deploy-duel-engine -xzf "$bundle"
DUEL_PREFLIGHT=1 DUEL_BUNDLE_SRC="$staging_dir/.deploy-duel-engine" \
  DUEL_DATA_DIR="$staging_dir/.deploy-duel-engine" \
  sh packages/duel-server/scripts/install-engine-bundle.sh
old_images=$(compose images -q 2>/dev/null | sort -u | tr '\n' ' ' || true)
compose build
if ! sh scripts/staging/check-resources.sh "after build" 0 "${STAGING_MIN_DISK_AFTER_BUILD_MB:-2500}" /opt; then
  skip_staging "the disk check did not pass. Staging stays down."
fi

# 4. The database: first run, or when asked.
mkdir -p data-staging
clerk_scrub_marker=data-staging/.clerk-ids-needs-scrub
if [ ! -f data-staging/bot.sqlite ] || [ "$refresh_db" = "true" ]; then
  # Persist the scrub requirement across an interrupted deploy.
  touch "$clerk_scrub_marker"
  sh scripts/staging/copy-staging-db.sh "$prod_dir/data/bot.sqlite" "$staging_dir/data-staging"
else
  echo "remote-deploy: keeping the staging database (set refresh_db to copy production again)"
fi

# 5. The engine bundle, with the multi core. The install refuses a changed bundle while a duel is "active", and
#    no duel can end while staging is stopped, so set the active staging duels to interrupted first.
sh scripts/staging/interrupt-active-duels.sh "$staging_dir/data-staging"
sh scripts/staging/install-staging-bundle.sh "$bundle" "$staging_dir/data-staging"
for core in ocgcore.multi ocgcore.multi-domain; do
  cat "data-staging/duel-engine/$core.SOURCE"
done

# Migrate the isolated, stopped staging database once before any consumers start.
copied_db=0
[ ! -f "$clerk_scrub_marker" ] || copied_db=1
compose run --rm --no-deps -e STAGING_COPIED_DB="$copied_db" worker node --input-type=module -e '
  import {openDatabase} from "@yugidraft/shared/db";
  const db=openDatabase(process.env.DATABASE_PATH);
  try {
    // Production Clerk IDs must never reach the staging instance.
    if(process.env.STAGING_COPIED_DB === "1") db.prepare("UPDATE users SET clerk_user_id = NULL, synced_at = NULL").run();
    if(db.pragma("foreign_key_check").length)throw new Error("Foreign key check failed");
    if(db.pragma("integrity_check",{simple:true})!=="ok")throw new Error("Integrity check failed");
    console.log("staging identity migration verified");
  } finally {db.close();}
'
rm -f "$clerk_scrub_marker"

# 6. Start, only when the VM has the memory for the limits of the stack.
if ! sh scripts/staging/check-resources.sh "before start" "${STAGING_MIN_START_MB:-1900}"; then
  skip_staging "the start resource check did not pass. Staging stays down."
fi
compose up -d
compose ps

# 7. Health check, logs and memory use.
if ! sh scripts/staging/health-check.sh 180; then
  compose logs --tail=60 || true
  free -m || true
  # Do not leave an unhealthy stack running: it keeps using memory that production may need.
  compose stop || true
  echo "remote-deploy: staging did not become healthy. It is stopped now." >&2
  exit 1
fi
compose logs --tail=20
ids=$(compose ps -q)
# shellcheck disable=SC2086
docker stats --no-stream $ids || true
free -m || true

# 8. Remove the old staging images. Only the ids from before the build, and only when nothing uses them.
new_images=$(compose images -q 2>/dev/null | sort -u | tr '\n' ' ' || true)
sh scripts/staging/remove-old-images.sh "$old_images" "$new_images"
df -Pm /opt | awk 'NR == 2 { print "remote-deploy: disk free " $4 " MB" }'
echo "remote-deploy: staging is running."
