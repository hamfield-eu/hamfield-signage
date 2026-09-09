#!/usr/bin/env bash
#
# Hamfield Signage - backup verification (T011 step 9).
#
# Restores a backup bundle's database dump into a THROWAWAY postgres:16-alpine
# container, asserts the data is really there, tears the container down and
# reports pass/fail. It never touches the live stack or the live database: it
# uses `docker run`, never `docker compose`, and the container is created with
# no volumes and no network.
#
# Two modes, because decryption needs the age PRIVATE key and that key
# deliberately does not exist on the production server:
#
#   --plain <dir|tar.gz>          Runs UNATTENDED on this server, on the bundle
#                                 as it exists BEFORE encryption. This is what
#                                 backup.sh calls nightly.
#
#   --encrypted <file.age> --identity <key>
#                                 Runs MANUALLY, on a machine that holds the age
#                                 private key. This is the only mode that proves
#                                 an object actually stored in R2 is restorable.
#
# Both modes run the identical assertion core (verify_dump below).
#
set -euo pipefail
umask 077

PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
DB_USER="${DB_USER:-signage}"
DB_NAME="${DB_NAME:-signage}"
READY_TIMEOUT="${READY_TIMEOUT:-60}"

# Tables that must contain at least one row for a restore to be meaningful.
ASSERT_TABLES=(users organizations devices media_assets playlists schedules audit_logs)

log()  { printf '%s   %s\n'        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die()  { printf '%s   ERROR: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit 1; }
pass() { printf '  [PASS] %s\n' "$*"; }
fail() { printf '  [FAIL] %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }

MODE=""
BUNDLE=""
IDENTITY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --plain)     MODE="plain";     BUNDLE="${2:?--plain needs a path}";        shift 2 ;;
    --encrypted) MODE="encrypted"; BUNDLE="${2:?--encrypted needs a path}";    shift 2 ;;
    --identity)  IDENTITY="${2:?--identity needs a path}";                     shift 2 ;;
    -h|--help)   sed -n '2,30p' "$0"; exit 0 ;;
    *)           die "unknown argument: $1" ;;
  esac
done

[ -n "$MODE" ] || die "usage: $0 --plain <dir|tar.gz> | --encrypted <file.age> --identity <key>"
[ -e "$BUNDLE" ] || die "no such bundle: $BUNDLE"
if [ "$MODE" = "encrypted" ]; then
  [ -n "$IDENTITY" ] || die "--encrypted requires --identity <age private key file>"
  [ -s "$IDENTITY" ] || die "no such age identity file: $IDENTITY"
  command -v age >/dev/null || die "age is not installed"
fi
command -v docker >/dev/null || die "docker is not installed"

FAILURES=0
TMPDIR_SELF=""
CONTAINER=""
RESTORE_LOG=""

cleanup() {
  local rc=$?
  if [ -n "$CONTAINER" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -n "$TMPDIR_SELF" ] && [ -d "$TMPDIR_SELF" ]; then
    find "$TMPDIR_SELF" -type f -exec shred -u -n 1 {} + 2>/dev/null || true
    rm -rf "$TMPDIR_SELF" 2>/dev/null || true
  fi
  [ -n "$RESTORE_LOG" ] && rm -f "$RESTORE_LOG" 2>/dev/null || true
  return $rc
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Materialise the bundle into a directory holding db.dump and manifest.txt
# ---------------------------------------------------------------------------
if [ "$MODE" = "plain" ] && [ -d "$BUNDLE" ]; then
  WORKDIR="$BUNDLE"
  log "verifying unencrypted bundle directory: $WORKDIR"
else
  TMPDIR_SELF="$(mktemp -d /root/.backup-verify.XXXXXX 2>/dev/null || mktemp -d)"
  chmod 700 "$TMPDIR_SELF"
  WORKDIR="$TMPDIR_SELF"
  if [ "$MODE" = "encrypted" ]; then
    log "decrypting $BUNDLE with the supplied age identity"
    age -d -i "$IDENTITY" "$BUNDLE" | tar -xzf - -C "$WORKDIR" \
      || die "decrypt/unpack failed - wrong key, or the bundle is corrupt"
  else
    log "unpacking $BUNDLE"
    tar -xzf "$BUNDLE" -C "$WORKDIR" || die "unpack failed - the bundle is corrupt"
  fi
fi

DUMP="$WORKDIR/db.dump"
MANIFEST="$WORKDIR/manifest.txt"
[ -f "$DUMP" ]     || die "bundle contains no db.dump"
[ -f "$MANIFEST" ] || die "bundle contains no manifest.txt"

EXPECTED_HEAD=$(awk -F': *' '/^migration_head:/ {print $2; exit}' "$MANIFEST" | tr -d '[:space:]')
EXPECTED_SHA=$(awk -F': *'  '/^dump_sha256:/    {print $2; exit}' "$MANIFEST" | tr -d '[:space:]')
DUMP_BYTES=$(stat -c%s "$DUMP")

echo
log "=== verifying backup bundle ==="
log "dump:            $DUMP (${DUMP_BYTES} bytes)"
log "expected head:   ${EXPECTED_HEAD:-<absent from manifest>}"

# ---------------------------------------------------------------------------
# Integrity of the dump file against the manifest
# ---------------------------------------------------------------------------
if [ -n "$EXPECTED_SHA" ]; then
  ACTUAL_SHA=$(sha256sum "$DUMP" | cut -d' ' -f1)
  if [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ]; then
    pass "db.dump sha256 matches the manifest"
  else
    fail "db.dump sha256 does NOT match the manifest (dump is truncated or altered)"
  fi
else
  fail "manifest has no dump_sha256 line"
fi

# ---------------------------------------------------------------------------
# Config files
# ---------------------------------------------------------------------------
# The dump on its own is NOT a recoverable backup. The Postgres password is
# baked into the data volume when it is first created, so a bundle whose
# config/ is missing restores into a database nobody can authenticate against.
# Verification has to cover that, or it certifies a backup that cannot be used.
MANIFEST_CONFIGS=$(awk -F': *' '/^config_files:/ {print $2; exit}' "$MANIFEST")
if [ -z "$MANIFEST_CONFIGS" ]; then
  fail "manifest has no config_files line"
else
  # Deliberately unquoted: the manifest stores a space-separated list.
  # shellcheck disable=SC2086
  for cf in $MANIFEST_CONFIGS; do
    if [ -s "$WORKDIR/config/$cf" ]; then
      pass "config/$cf present"
    else
      fail "config/$cf is listed in the manifest but missing or empty in the bundle"
    fi
  done
fi

# ---------------------------------------------------------------------------
# Throwaway container
# ---------------------------------------------------------------------------
CONTAINER="hamfield-backup-verify-$$-${RANDOM}"
case "$CONTAINER" in
  signage-platform*) die "refusing to use a container name that could collide with the live stack" ;;
esac

# No volumes, no network, removed on exit: this container cannot reach or affect
# the production database.
log "starting throwaway container $CONTAINER ($PG_IMAGE)"
docker run -d --name "$CONTAINER" \
  --network none \
  -e POSTGRES_USER="$DB_USER" \
  -e POSTGRES_DB="$DB_NAME" \
  -e POSTGRES_PASSWORD="verify-$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')" \
  "$PG_IMAGE" >/dev/null || die "could not start the throwaway container"

# The official postgres entrypoint runs a TEMPORARY server on the unix socket
# while it initialises the cluster, then shuts it down and starts the real one.
# pg_isready succeeds against that temporary server, so waiting on pg_isready
# alone will sometimes hand back a connection that dies mid-restore with
# "FATAL: the database system is shutting down". Wait for the entrypoint to
# announce that initialisation is finished, and only then wait for readiness.
log "waiting for cluster initialisation to complete (timeout ${READY_TIMEOUT}s)"
init_done=0
for _ in $(seq 1 "$READY_TIMEOUT"); do
  if docker logs "$CONTAINER" 2>&1 | grep -q 'PostgreSQL init process complete'; then init_done=1; break; fi
  sleep 1
done
[ "$init_done" -eq 1 ] || die "throwaway postgres never finished initialising"

log "waiting for postgres to accept connections (timeout ${READY_TIMEOUT}s)"
ready=0
for _ in $(seq 1 "$READY_TIMEOUT"); do
  if docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" -q 2>/dev/null; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || die "throwaway postgres never became ready"

# ---------------------------------------------------------------------------
# The restore. This - not the size floor, and not pg_restore --list - is the
# check that actually catches a truncated custom-format dump, because the
# table of contents sits at the front of the file and reads fine on a
# half-written one.
# ---------------------------------------------------------------------------
docker cp "$DUMP" "$CONTAINER:/tmp/db.dump" >/dev/null || die "could not copy the dump into the container"

# Deliberately NOT inside the bundle directory: in --plain mode that directory
# is the bundle backup.sh is about to tar, and a stray log file would be
# shipped inside it.
RESTORE_LOG="$(mktemp /root/.backup-verify-restore.XXXXXX.log 2>/dev/null || mktemp)"
restore_log="$RESTORE_LOG"
if docker exec "$CONTAINER" pg_restore \
      --no-owner --no-privileges --exit-on-error \
      -U "$DB_USER" -d "$DB_NAME" /tmp/db.dump > "$restore_log" 2>&1; then
  pass "pg_restore completed without errors"
else
  fail "pg_restore FAILED - the dump is not restorable"
  sed -n '1,15p' "$restore_log" >&2
fi

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------
q() { docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -Atc "$1" 2>/dev/null | tr -d '\r'; }

for t in "${ASSERT_TABLES[@]}"; do
  n=$(q "select count(*) from \"$t\";" || true)
  if [ -n "$n" ] && [ "$n" -gt 0 ] 2>/dev/null; then
    pass "$t has $n rows"
  else
    fail "$t has ${n:-no} rows (expected at least 1)"
  fi
done

RESTORED_HEAD=$(q "select migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null order by finished_at desc limit 1;" | head -1)
if [ -z "$EXPECTED_HEAD" ]; then
  fail "cannot compare migration head: manifest has no migration_head line"
elif [ "$RESTORED_HEAD" = "$EXPECTED_HEAD" ]; then
  pass "_prisma_migrations head matches the manifest ($RESTORED_HEAD)"
else
  fail "_prisma_migrations head is '${RESTORED_HEAD:-<none>}' but the manifest says '$EXPECTED_HEAD'"
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
echo
if [ "$FAILURES" -eq 0 ]; then
  log "=== VERIFY PASS ==="
  exit 0
else
  log "=== VERIFY FAIL ($FAILURES failed check(s)) ==="
  exit 1
fi
