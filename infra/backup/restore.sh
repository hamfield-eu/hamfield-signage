#!/usr/bin/env bash
#
# Hamfield Signage - restore from a backup bundle (T011 step 6).
#
# ############################################################################
# # THIS SCRIPT IS DESTRUCTIVE. It runs `pg_restore --clean --if-exists`,     #
# # which DROPS AND RECREATES every object in the target database.           #
# # It is meant for a FRESH VPS or a throwaway host. Never point it at a      #
# # production database you still need.                                      #
# ############################################################################
#
# Decryption requires the age PRIVATE key, which deliberately does not exist on
# the production server. Supply it with --identity from your password manager.
#
# Usage:
#   restore.sh --bundle <file.age|object-name> --identity <age-key> [options]
#
#   --bundle       Local path to an encrypted bundle, OR the bare object name of
#                  one in the backup bucket (it is then downloaded).
#   --identity     age private key file.
#   --project-dir  Compose project directory (default: this repo checkout).
#   --force        Allow restoring over a database that already contains rows.
#   --skip-checkout  Do not `git checkout` the manifest's SHA.
#
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Step 6 runs `git checkout <the bundle's sha>`. Now that infra/backup/ is
# tracked, checking out a commit that predates it DELETES these scripts from the
# working tree - including the file bash is still reading, which is undefined
# behaviour, and verify-backup.sh, which step 2 has already used but step 8
# might not have. Re-exec from a copy outside the repo so the checkout cannot
# pull the floor out from under us.
#
# The copy is left behind on purpose: removing the script you are executing is
# the exact problem being avoided here. It holds no secrets.
if [ -z "${RESTORE_SAFE_COPY:-}" ]; then
  _safe="$(mktemp -d /tmp/.hamfield-restore-scripts.XXXXXX)"
  cp "$SCRIPT_DIR/common.sh" "$SCRIPT_DIR/verify-backup.sh" "$SCRIPT_DIR/restore.sh" "$_safe/"
  chmod +x "$_safe"/*.sh
  export RESTORE_SAFE_COPY="$_safe"
  printf 're-executing from %s so the git checkout cannot delete the running scripts\n' "$_safe" >&2
  exec "$_safe/restore.sh" "$@"
fi

# shellcheck source=./common.sh
. "$SCRIPT_DIR/common.sh"

DB_SERVICE="${DB_SERVICE:-postgres}"
DB_USER="${DB_USER:-signage}"
DB_NAME="${DB_NAME:-signage}"

BUNDLE=""; IDENTITY=""; PROJECT_DIR=""; FORCE=0; SKIP_CHECKOUT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --bundle)        BUNDLE="${2:?}";      shift 2 ;;
    --identity)      IDENTITY="${2:?}";    shift 2 ;;
    --project-dir)   PROJECT_DIR="${2:?}"; shift 2 ;;
    --force)         FORCE=1;              shift ;;
    --skip-checkout) SKIP_CHECKOUT=1;      shift ;;
    -h|--help)       sed -n '2,30p' "$0"; exit 0 ;;
    *)               die "unknown argument: $1" ;;
  esac
done

[ -n "$BUNDLE" ]   || die "--bundle is required"
[ -n "$IDENTITY" ] || die "--identity is required (the age private key is not on this server by design)"
[ -s "$IDENTITY" ] || die "no such age identity file: $IDENTITY"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
[ -d "$PROJECT_DIR" ] || die "no such project directory: $PROJECT_DIR"

COMPOSE=(docker compose -f docker-compose.yml -f infra/docker/docker-compose.prod.yml)

# Fall back to $TMPDIR when not running as root, so a restore can be driven from
# a workstation - which is where the age private key lives.
WORK="$(mktemp -d /root/.restore-work.XXXXXX 2>/dev/null || mktemp -d)"; chmod 700 "$WORK"
cleanup() {
  local rc=$?
  # The unpacked bundle holds the database password, JWT_SECRET and the R2
  # credentials in plaintext. Shred it however we exit.
  if [ -d "$WORK" ]; then
    find "$WORK" -type f -exec shred -u -n 1 {} + 2>/dev/null || true
    rm -rf "$WORK" 2>/dev/null || true
  fi
  return $rc
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Obtain and decrypt the bundle
# ---------------------------------------------------------------------------
if [ -f "$BUNDLE" ]; then
  LOCAL_BUNDLE="$BUNDLE"
else
  log "'$BUNDLE' is not a local file - trying the backup bucket"
  load_r2_env
  SRC="${R2_DIR}/${BUNDLE}"
  assert_backup_path "$SRC"
  rclone copyto "$SRC" "$WORK/$BUNDLE" || die "could not download $BUNDLE"
  LOCAL_BUNDLE="$WORK/$BUNDLE"
fi

log "decrypting bundle"
mkdir -p "$WORK/bundle"
age -d -i "$IDENTITY" "$LOCAL_BUNDLE" | tar -xzf - -C "$WORK/bundle" \
  || die "decrypt/unpack failed - wrong key, or the bundle is corrupt"

[ -f "$WORK/bundle/db.dump" ]     || die "bundle contains no db.dump"
[ -f "$WORK/bundle/manifest.txt" ] || die "bundle contains no manifest.txt"

echo
echo "================= MANIFEST ================="
cat "$WORK/bundle/manifest.txt"
echo "============================================"
echo

BUNDLE_SHA=$(awk -F': *'  '/^git_sha:/        {print $2; exit}' "$WORK/bundle/manifest.txt" | tr -d '[:space:]')
BUNDLE_HEAD=$(awk -F': *' '/^migration_head:/ {print $2; exit}' "$WORK/bundle/manifest.txt" | tr -d '[:space:]')

# ---------------------------------------------------------------------------
# 2. Verify the bundle BEFORE destroying anything
# ---------------------------------------------------------------------------
log "verifying the bundle before touching the target database"
"$SCRIPT_DIR/verify-backup.sh" --plain "$WORK/bundle" \
  || die "the bundle does not verify - refusing to restore from it"

# ---------------------------------------------------------------------------
# 3. Confirmations
# ---------------------------------------------------------------------------
THIS_HOST="$(hostname -f 2>/dev/null || hostname)"
cat <<WARN

  *** DESTRUCTIVE OPERATION ***

  About to restore into : $THIS_HOST
  Project directory     : $PROJECT_DIR
  Bundle git SHA        : $BUNDLE_SHA
  Bundle schema head    : $BUNDLE_HEAD

  This DROPS AND RECREATES every object in the '$DB_NAME' database, and
  OVERWRITES the config files in the project directory.

WARN
printf '  Type the hostname of this machine (%s) to proceed: ' "$THIS_HOST"
read -r TYPED
[ "$TYPED" = "$THIS_HOST" ] || die "confirmation did not match - nothing was changed"

cd "$PROJECT_DIR" || die "cannot cd to $PROJECT_DIR"

# ---------------------------------------------------------------------------
# 4. Refuse to overwrite a database that already holds data
# ---------------------------------------------------------------------------
EXISTING=""
if "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx "$DB_SERVICE"; then
  EXISTING=$("${COMPOSE[@]}" exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -Atc \
    "select coalesce(sum(c),0) from (select count(*) c from users union all select count(*) from organizations union all select count(*) from devices) t;" 2>/dev/null | tr -d '\r' | head -1 || true)
fi
if [ -n "$EXISTING" ] && [ "$EXISTING" != "0" ]; then
  if [ "$FORCE" -eq 1 ]; then
    warn "target database already contains $EXISTING rows in users/organizations/devices - proceeding because --force was given"
  else
    die "target database already contains $EXISTING rows in users/organizations/devices. Refusing. Re-run with --force if this is really what you want."
  fi
fi

# ---------------------------------------------------------------------------
# 5. Config files first - they carry the DB password the new stack needs
# ---------------------------------------------------------------------------
log "restoring config files"
if [ -d "$WORK/bundle/config" ]; then
  ( cd "$WORK/bundle/config" && find . -type f -print0 ) | while IFS= read -r -d '' rel; do
    dest="$PROJECT_DIR/${rel#./}"
    if [ -f "$dest" ]; then
      cp -a "$dest" "${dest}.pre-restore.$(date -u +%Y%m%dT%H%M%SZ)"
    fi
    install -m 600 -D "$WORK/bundle/config/${rel#./}" "$dest"
    log "  restored ${rel#./}"
  done
else
  die "bundle contains no config/ directory"
fi

# ---------------------------------------------------------------------------
# 6. Match the code to the schema
# ---------------------------------------------------------------------------
if [ "$SKIP_CHECKOUT" -eq 0 ] && [ -n "$BUNDLE_SHA" ] && [ "$BUNDLE_SHA" != "unknown" ]; then
  log "checking out $BUNDLE_SHA so the code matches the schema in the dump"
  git -C "$PROJECT_DIR" checkout --quiet "$BUNDLE_SHA" || die "could not check out $BUNDLE_SHA"
else
  warn "skipping git checkout - the running code may not match the restored schema"
fi

# ---------------------------------------------------------------------------
# 7. Bring up postgres alone and restore into it
# ---------------------------------------------------------------------------
log "starting $DB_SERVICE"
"${COMPOSE[@]}" up -d "$DB_SERVICE" || die "could not start $DB_SERVICE"

log "waiting for $DB_SERVICE to become healthy"
ready=0
for _ in $(seq 1 120); do
  if "${COMPOSE[@]}" exec -T "$DB_SERVICE" pg_isready -U "$DB_USER" -d "$DB_NAME" -q 2>/dev/null; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || die "$DB_SERVICE never became ready"

log "restoring the dump (pg_restore --clean --if-exists)"
"${COMPOSE[@]}" exec -T "$DB_SERVICE" \
  pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error \
  -U "$DB_USER" -d "$DB_NAME" < "$WORK/bundle/db.dump" \
  || die "pg_restore failed - the database is in an indeterminate state"

# ---------------------------------------------------------------------------
# 8. Schema/code agreement
# ---------------------------------------------------------------------------
# Do NOT run `migrate deploy` here. The dump already carries _prisma_migrations
# at the right version. If migrations are reported as pending, the checked-out
# SHA does not match the dump, and running them would corrupt the restore.
RESTORED_HEAD=$("${COMPOSE[@]}" exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -Atc \
  "select migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null order by finished_at desc limit 1;" | tr -d '\r' | head -1)
if [ "$RESTORED_HEAD" = "$BUNDLE_HEAD" ]; then
  log "schema head matches the manifest ($RESTORED_HEAD)"
else
  die "schema head is '$RESTORED_HEAD' but the manifest says '$BUNDLE_HEAD'"
fi

ON_DISK_LATEST=$(ls -1 "$PROJECT_DIR/packages/database/prisma/migrations" 2>/dev/null | grep -v migration_lock | sort | tail -1)
if [ -n "$ON_DISK_LATEST" ] && [ "$ON_DISK_LATEST" != "$RESTORED_HEAD" ]; then
  warn "latest migration on disk ($ON_DISK_LATEST) is not the restored head ($RESTORED_HEAD)."
  warn "The checked-out code is NEWER than the dump. Run 'docker compose run --rm migrate' deliberately, only after you have decided that is correct."
fi

# ---------------------------------------------------------------------------
# 9. Bring the rest of the stack up
# ---------------------------------------------------------------------------
log "starting the remaining services"
"${COMPOSE[@]}" up -d || die "the stack did not come up"

cat <<DONE

  === RESTORE COMPLETE ===

  Still to do BY HAND - the script deliberately does not decide these for you:

   1. Smoke test: superadmin login, orgs/users/devices/playlists/schedules present,
      audit log intact.
   2. Confirm a previously paired device reconnects WITHOUT re-pairing
      (device tokens are hashed in the DB, so this must work).
   3. DB <-> object storage reconciliation (T011 step 7): the database and R2
      were captured at different instants, so the restore may be skewed. Run:

          ./infra/backup/reconcile-media.sh

      It exits non-zero if a live row references an object that is not in the
      media bucket - those assets show as 'ready' and 404 on download. Orphaned
      objects are reported but are harmless. It is left as a separate command
      rather than run automatically here, because a restore that succeeded with
      known skew should not be reported as a failed restore.
   4. If there is any suspicion the bundle was exposed, rotate JWT_SECRET.
      That logs every dashboard user out but does NOT affect devices.

DONE
log "restore finished on $THIS_HOST from ${BUNDLE##*/}"
