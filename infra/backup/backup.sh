#!/usr/bin/env bash
#
# Hamfield Signage - nightly backup (T011 step 2).
#
# Dumps PostgreSQL, bundles it with the git-ignored config files and a manifest,
# VERIFIES the bundle by restoring it into a throwaway container, encrypts it to
# an age public key, uploads it to a dedicated Cloudflare R2 bucket, and only
# then prunes old bundles.
#
# The bundle contains JWT_SECRET, the database password and the R2 credentials.
# It is encrypted before it leaves this host, and the private key deliberately
# does not exist on this host.
#
# Usage:
#   backup.sh                          nightly run: dump, verify, encrypt, upload, prune
#   backup.sh --tag pre-upgrade-<sha>  tag the bundle; tagged bundles are kept 30 days
#   backup.sh --no-prune               back up but do not prune
#   backup.sh --prune-dry-run          do NOT back up; print what prune would delete
#   backup.sh --simulate-prune FILE    print retention decisions for names in FILE (no network)
#
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
. "$SCRIPT_DIR/common.sh"

REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
WORK_ROOT="${WORK_ROOT:-/root/.backup-work}"   # never inside the repo
DB_SERVICE="${DB_SERVICE:-postgres}"
DB_USER="${DB_USER:-signage}"
DB_NAME="${DB_NAME:-signage}"
DUMP_MIN_BYTES="${DUMP_MIN_BYTES:-51200}"      # 50 KB floor; a real dump is ~6 MB
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"     # throwaway containers only

KEEP_DAILY="${KEEP_DAILY:-14}"
KEEP_WEEKLY="${KEEP_WEEKLY:-8}"                # Sundays
KEEP_MONTHLY="${KEEP_MONTHLY:-12}"             # 1st of month
KEEP_TAGGED_DAYS="${KEEP_TAGGED_DAYS:-30}"     # pre-upgrade-*

COMPOSE=(docker compose -f docker-compose.yml -f infra/docker/docker-compose.prod.yml)

# The three git-ignored config files. .env.prod is included only if it exists;
# this deployment keeps its secrets in the compose files instead.
CONFIG_FILES=(
  "docker-compose.yml"
  "infra/docker/docker-compose.prod.yml"
  "infra/docker/Caddyfile"
  ".env.prod"
)

TAG=""
DO_PRUNE=1
MODE="backup"
SIM_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)            TAG="${2:?--tag needs a value}"; shift 2 ;;
    --no-prune)       DO_PRUNE=0; shift ;;
    --prune-dry-run)  MODE="prune-dry-run"; shift ;;
    --simulate-prune) MODE="simulate-prune"; SIM_FILE="${2:?--simulate-prune needs a file}"; shift 2 ;;
    -h|--help)        sed -n '2,25p' "$0"; exit 0 ;;
    *)                die "unknown argument: $1" ;;
  esac
done

# A glob of the form [A-Za-z0-9._-]* matches "one allowed character followed by
# ANYTHING", so it validates only the first character. Use a regex anchored at
# both ends: the tag becomes part of the object key, and assert_backup_path is
# the only thing standing between a malformed tag and a stray remote path.
[[ "$TAG" =~ ^[A-Za-z0-9._-]*$ ]] \
  || die "invalid --tag (allowed: letters, digits, dot, underscore, hyphen)"

# ---------------------------------------------------------------------------
# Retention classifier
# ---------------------------------------------------------------------------
# Reads bundle object names on stdin, one per line. Writes one decision per
# line: KEEP|<reason>|<name> or DELETE|<reason>|<name>.
#
# Anything that cannot be parsed, and any tag this policy does not know about,
# is KEPT and flagged. Deleting an object we do not understand is the one
# mistake a retention pass must never make.
classify_retention() {
  local now_epoch name sorted
  now_epoch=$(date -u +%s)
  local -a parsed=()

  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if [[ "$name" =~ ^backup-([0-9]{8})T([0-9]{6})Z(-([A-Za-z0-9._-]+))?\.tar\.gz\.age$ ]]; then
      parsed+=("${BASH_REMATCH[1]}|${BASH_REMATCH[2]}|${BASH_REMATCH[4]:-}|$name")
    else
      printf 'KEEP|unrecognised-name|%s\n' "$name"
    fi
  done

  [ "${#parsed[@]}" -gt 0 ] || return 0
  sorted=$(printf '%s\n' "${parsed[@]}" | sort -r)   # newest first

  local d t tag nm dow dom keep age_days daily=0 weekly=0 monthly=0
  while IFS='|' read -r d t tag nm; do
    [ -n "$nm" ] || continue

    if [ -n "$tag" ]; then
      case "$tag" in
        pre-upgrade-*)
          age_days=$(( ( now_epoch - $(date -u -d "${d:0:4}-${d:4:2}-${d:6:2}" +%s) ) / 86400 ))
          if [ "$age_days" -le "$KEEP_TAGGED_DAYS" ]; then
            printf 'KEEP|pre-upgrade-%sd-of-%sd|%s\n' "$age_days" "$KEEP_TAGGED_DAYS" "$nm"
          else
            printf 'DELETE|pre-upgrade-expired-%sd|%s\n' "$age_days" "$nm"
          fi
          ;;
        *) printf 'KEEP|unknown-tag:%s|%s\n' "$tag" "$nm" ;;
      esac
      continue
    fi

    dow=$(date -u -d "${d:0:4}-${d:4:2}-${d:6:2}" +%u)   # 7 = Sunday
    dom="${d:6:2}"
    keep=""
    if [ "$daily" -lt "$KEEP_DAILY" ]; then
      daily=$((daily + 1)); keep="daily-${daily}/${KEEP_DAILY}"
    fi
    if [ "$dow" = "7" ] && [ "$weekly" -lt "$KEEP_WEEKLY" ]; then
      weekly=$((weekly + 1)); keep="${keep:+$keep,}weekly-${weekly}/${KEEP_WEEKLY}"
    fi
    if [ "$dom" = "01" ] && [ "$monthly" -lt "$KEEP_MONTHLY" ]; then
      monthly=$((monthly + 1)); keep="${keep:+$keep,}monthly-${monthly}/${KEEP_MONTHLY}"
    fi

    if [ -n "$keep" ]; then
      printf 'KEEP|%s|%s\n' "$keep" "$nm"
    else
      printf 'DELETE|outside-retention|%s\n' "$nm"
    fi
  done <<< "$sorted"
}

remote_names() {
  rclone lsf "${R2_DIR}/" --files-only 2>/dev/null || die "cannot list ${R2_DIR}/ - check the R2 credentials"
}

# Prints the decisions. Deletes only when $1 is "apply".
run_prune() {
  local apply="$1" decisions deletes=0 kept=0 verdict reason name path
  decisions=$(remote_names | classify_retention)

  if [ -z "$decisions" ]; then
    log "prune: no objects under ${R2_DIR}/ - nothing to consider"
    return 0
  fi

  printf '%s\n' "$decisions" | sort
  while IFS='|' read -r verdict reason name; do
    [ -n "$name" ] || continue
    if [ "$verdict" = "DELETE" ]; then
      deletes=$((deletes + 1))
      path="${R2_DIR}/${name}"
      assert_backup_path "$path"
      if [ "$apply" = "apply" ]; then
        log "prune: deleting $name ($reason)"
        rclone deletefile "$path" || die "failed to delete $name"
      fi
    else
      kept=$((kept + 1))
    fi
  done <<< "$decisions"

  if [ "$apply" = "apply" ]; then
    log "prune: kept $kept, deleted $deletes"
  else
    log "prune (DRY RUN): would keep $kept, would delete $deletes - nothing was deleted"
  fi
}

# ---------------------------------------------------------------------------
# Modes that do not take a backup
# ---------------------------------------------------------------------------
if [ "$MODE" = "simulate-prune" ]; then
  [ -r "$SIM_FILE" ] || die "cannot read $SIM_FILE"
  log "retention simulation over $SIM_FILE (no network, nothing deleted)"
  log "policy: keep ${KEEP_DAILY} daily, ${KEEP_WEEKLY} weekly (Sun), ${KEEP_MONTHLY} monthly (1st), tagged ${KEEP_TAGGED_DAYS}d"
  classify_retention < "$SIM_FILE" | sort
  exit 0
fi

if [ "$MODE" = "prune-dry-run" ]; then
  load_r2_env
  log "prune dry run against ${R2_DIR}/"
  log "policy: keep ${KEEP_DAILY} daily, ${KEEP_WEEKLY} weekly (Sun), ${KEEP_MONTHLY} monthly (1st), tagged ${KEEP_TAGGED_DAYS}d"
  run_prune "dry-run"
  exit 0
fi

# ---------------------------------------------------------------------------
# Preconditions - fail in the first second, not after writing a 90 MB dump
# ---------------------------------------------------------------------------
cd "$REPO_DIR" || die "cannot cd to $REPO_DIR"
[ -d "$SECRETS_DIR" ] || die "missing $SECRETS_DIR"
[ -s "$SECRETS_DIR/age.pub" ] || die "missing or empty $SECRETS_DIR/age.pub"

AGE_RECIPIENT=$(tr -d '[:space:]' < "$SECRETS_DIR/age.pub")
[[ "$AGE_RECIPIENT" =~ ^age1[0-9a-z]{20,}$ ]] || die "$SECRETS_DIR/age.pub is not an age public key (expected age1...)"

for bin in docker rclone age tar shred; do
  command -v "$bin" >/dev/null || die "missing required binary: $bin"
done
[ -x "$SCRIPT_DIR/verify-backup.sh" ] || die "missing or non-executable $SCRIPT_DIR/verify-backup.sh"

load_r2_env

TS="$(date -u +%Y%m%dT%H%M%SZ)"
BUNDLE_NAME="backup-${TS}${TAG:+-$TAG}.tar.gz.age"
WORK="$(mktemp -d "${WORK_ROOT}/${TS}.XXXXXX" 2>/dev/null || { mkdir -p "$WORK_ROOT" && chmod 700 "$WORK_ROOT" && mktemp -d "${WORK_ROOT}/${TS}.XXXXXX"; })"
chmod 700 "$WORK"
# The bundle contents live in a SUBdirectory. The encrypted output is written to
# $WORK, its parent: if the .age file were created inside the directory tar is
# walking, tar exits 1 with "file changed as we read it".
BUNDLE_DIR="$WORK/bundle"
mkdir -p "$BUNDLE_DIR"

# The bundle staging area holds the plaintext dump AND plaintext copies of the
# config files (database password, JWT_SECRET, R2 credentials). Shred every file
# on every exit path, success or failure.
cleanup() {
  local rc=$?
  if [ -n "${WORK:-}" ] && [ -d "$WORK" ]; then
    find "$WORK" -type f -exec shred -u -n 1 {} + 2>/dev/null || true
    rm -rf "$WORK" 2>/dev/null || true
  fi
  if [ "$rc" -ne 0 ]; then
    printf '%s BACKUP FAILED (exit %s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rc" >&2
  fi
  return $rc
}
trap cleanup EXIT

log "=== Hamfield Signage backup ${TS}${TAG:+ (tag: $TAG)} ==="
mkdir -p "$BUNDLE_DIR/config"

# ---------------------------------------------------------------------------
# 1. Dump PostgreSQL
# ---------------------------------------------------------------------------
log "dumping database '${DB_NAME}' (pg_dump -Fc)"
"${COMPOSE[@]}" exec -T "$DB_SERVICE" pg_dump -U "$DB_USER" -Fc "$DB_NAME" > "$BUNDLE_DIR/db.dump" \
  || die "pg_dump failed - no backup was produced and nothing was pruned"

DUMP_BYTES=$(stat -c%s "$BUNDLE_DIR/db.dump")
log "dump size: ${DUMP_BYTES} bytes"

# A silently-empty or truncated dump rotated into the retention window is the
# classic backup failure. Three independent gates: a size floor, a TOC read,
# and - the only one that actually catches truncation - the real pg_restore
# performed by verify-backup.sh below.
[ "$DUMP_BYTES" -ge "$DUMP_MIN_BYTES" ] \
  || die "dump is only ${DUMP_BYTES} bytes (floor ${DUMP_MIN_BYTES}) - refusing to continue"

# pg_restore cannot read a custom-format archive from a pipe ("did not find
# magic string in file header"), so the table of contents is read from the real
# file in a throwaway container. This never touches the live stack.
pg_restore_list_ok=0
docker run --rm --network none -v "$BUNDLE_DIR:/w:ro" "$PG_IMAGE" \
  pg_restore --list /w/db.dump > "$WORK/toc.txt" 2>"$WORK/toc.err" \
  && pg_restore_list_ok=1
[ "$pg_restore_list_ok" -eq 1 ] || { sed -n '1,5p' "$WORK/toc.err" >&2; die "pg_restore --list rejected the dump - refusing to continue"; }
grep -q 'TABLE DATA public users' "$WORK/toc.txt" \
  || die "dump table-of-contents has no 'users' table data - refusing to continue"
log "dump passes size floor and pg_restore --list"

# ---------------------------------------------------------------------------
# 2. Config files
# ---------------------------------------------------------------------------
CONFIG_PRESENT=()
for f in "${CONFIG_FILES[@]}"; do
  if [ -f "$REPO_DIR/$f" ]; then
    install -m 600 -D "$REPO_DIR/$f" "$BUNDLE_DIR/config/$f"
    CONFIG_PRESENT+=("$f")
    log "bundled config: $f"
  elif [ "$f" = ".env.prod" ]; then
    log "config .env.prod absent (this deployment keeps secrets in the compose files) - skipping"
  else
    die "required config file missing: $f"
  fi
done

# ---------------------------------------------------------------------------
# 3. Manifest
# ---------------------------------------------------------------------------
log "writing manifest"
GIT_SHA=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")
GIT_DIRTY=$(git -C "$REPO_DIR" status --porcelain 2>/dev/null | wc -l)
MIGRATION_HEAD=$("${COMPOSE[@]}" exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -Atc \
  "select migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null order by finished_at desc limit 1;" \
  | tr -d '\r' | head -1)
[ -n "$MIGRATION_HEAD" ] || die "could not read the _prisma_migrations head"

{
  echo "bundle:            $BUNDLE_NAME"
  echo "created_utc:       $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "hostname:          $(hostname -f 2>/dev/null || hostname)"
  echo "tag:               ${TAG:-<none>}"
  echo "git_sha:           $GIT_SHA"
  echo "git_dirty_files:   $GIT_DIRTY"
  echo "db_name:           $DB_NAME"
  echo "dump_bytes:        $DUMP_BYTES"
  echo "dump_sha256:       $(sha256sum "$BUNDLE_DIR/db.dump" | cut -d' ' -f1)"
  echo "migration_head:    $MIGRATION_HEAD"
  echo "config_files:      ${CONFIG_PRESENT[*]}"
  echo
  echo "--- applied migrations (_prisma_migrations) ---"
  "${COMPOSE[@]}" exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -Atc \
    "select migration_name || '  finished=' || (finished_at is not null) || ' rolled_back=' || (rolled_back_at is not null) from _prisma_migrations order by started_at;" | tr -d '\r'
  echo
  echo "--- row counts at backup time ---"
  "${COMPOSE[@]}" exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -Atc \
    "select 'users='||(select count(*) from users)||' organizations='||(select count(*) from organizations)||' devices='||(select count(*) from devices)||' media_assets='||(select count(*) from media_assets)||' playlists='||(select count(*) from playlists)||' schedules='||(select count(*) from schedules)||' audit_logs='||(select count(*) from audit_logs);" | tr -d '\r'
  echo
  echo "--- compose images ---"
  "${COMPOSE[@]}" images 2>/dev/null || echo "(unavailable)"
} > "$BUNDLE_DIR/manifest.txt"

rm -f "$WORK/toc.txt" "$WORK/toc.err"

# ---------------------------------------------------------------------------
# 4. Verify BEFORE encrypting and uploading
# ---------------------------------------------------------------------------
# This is the check that runs unattended. It restores the dump into a throwaway
# postgres container and asserts the data is really there. It runs here, on the
# plaintext bundle, because decryption needs the age private key and that key
# deliberately does not exist on this host.
log "verifying bundle before encryption"
"$SCRIPT_DIR/verify-backup.sh" --plain "$BUNDLE_DIR" \
  || die "verification FAILED - refusing to encrypt, upload or prune"

# ---------------------------------------------------------------------------
# 5. Encrypt
# ---------------------------------------------------------------------------
# tar is piped straight into age: the plaintext tar never touches the disk.
log "encrypting to $AGE_RECIPIENT"
ENC="$WORK/$BUNDLE_NAME"
tar -czf - -C "$BUNDLE_DIR" . | age -R "$SECRETS_DIR/age.pub" -o "$ENC" \
  || die "encryption failed"
ENC_BYTES=$(stat -c%s "$ENC")
[ "$ENC_BYTES" -ge "$DUMP_MIN_BYTES" ] || die "encrypted bundle is implausibly small (${ENC_BYTES} bytes)"
log "encrypted bundle: ${ENC_BYTES} bytes"

# ---------------------------------------------------------------------------
# 6. Upload - never overwrite
# ---------------------------------------------------------------------------
DEST="${R2_DIR}/${BUNDLE_NAME}"
assert_backup_path "$DEST"

if [ -n "$(rclone lsf "${R2_DIR}/" --files-only --include "$BUNDLE_NAME" 2>/dev/null || true)" ]; then
  die "an object named $BUNDLE_NAME already exists - refusing to overwrite"
fi

log "uploading to $DEST"
rclone copyto "$ENC" "$DEST" --s3-no-check-bucket || die "upload failed - nothing was pruned"

REMOTE_BYTES=$(rclone lsf "${R2_DIR}/" --files-only --include "$BUNDLE_NAME" --format s 2>/dev/null | head -1)
[ -n "$REMOTE_BYTES" ] || die "uploaded object is not listable afterwards - treating as a failed upload"
[ "$REMOTE_BYTES" = "$ENC_BYTES" ] \
  || die "remote size ${REMOTE_BYTES} != local size ${ENC_BYTES} - upload is corrupt, nothing was pruned"
log "upload confirmed: remote size ${REMOTE_BYTES} bytes matches local"

# ---------------------------------------------------------------------------
# 7. Prune - only now, after a confirmed successful upload
# ---------------------------------------------------------------------------
if [ "$DO_PRUNE" -eq 1 ]; then
  log "pruning (keep ${KEEP_DAILY} daily, ${KEEP_WEEKLY} weekly, ${KEEP_MONTHLY} monthly, tagged ${KEEP_TAGGED_DAYS}d)"
  run_prune "apply"
else
  log "pruning skipped (--no-prune)"
fi

log "=== BACKUP OK: ${BUNDLE_NAME} (${ENC_BYTES} bytes) ==="
