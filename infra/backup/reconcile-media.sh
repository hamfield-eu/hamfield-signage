#!/usr/bin/env bash
#
# Hamfield Signage - database <-> object storage reconciliation (T011 step 7).
#
# The database and the media bucket are captured at different instants, so a
# restore can land in one of two skewed states:
#
#   DB newer than storage  - rows reference objects that do not exist. The asset
#                            shows as 'ready' in the dashboard and 404s on
#                            download. This is the state that hurts, and this
#                            script's non-zero exit is reserved for it.
#   Storage newer than DB  - objects nothing references. Harmless; reclaimed by
#                            the retention job specified in T013.
#
# The skew is accepted by design - making the two atomic is not worth the
# complexity here. KNOWING about it is the requirement.
#
# ############################################################################
# # THIS SCRIPT IS STRICTLY READ-ONLY AGAINST THE MEDIA BUCKET.              #
# # The only rclone subcommand it ever issues is `lsf`. It never deletes,    #
# # never uploads, never modifies. The media bucket holds all customer       #
# # content and is NOT covered by the backups in this directory.             #
# ############################################################################
#
# Usage:
#   reconcile-media.sh                 query the live stack and the media bucket
#   reconcile-media.sh --from-dir DIR  compare pre-computed sets (no network);
#                                      DIR holds live_required.txt,
#                                      live_screenshots.txt, all_keys.txt,
#                                      bucket.txt - one key per line
#
# Exit status:
#   0  every object a live row depends on is present
#   1  at least one is missing, or a sanity assertion failed
#
set -euo pipefail
umask 077

# Every conclusion here rests on `comm` over `sort -u` output. Under a UTF-8
# locale, collation can rank two DISTINCT strings as equal (punctuation is
# weighted weakly), and `comm` would then pair a missing key with a similarly
# named present one - a false clean, which is the one result this script must
# never produce. Byte-order comparison removes the possibility. Storage keys are
# ASCII today (sanitizeFilename collapses anything else), so this changes no
# current output; it stops a future key format from quietly breaking the check.
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
DB_SERVICE="${DB_SERVICE:-postgres}"
API_SERVICE="${API_SERVICE:-api}"
DB_USER="${DB_USER:-signage}"
DB_NAME="${DB_NAME:-signage}"

COMPOSE=(docker compose -f docker-compose.yml -f infra/docker/docker-compose.prod.yml)

log()  { printf '%s %s\n'        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die()  { printf '%s ERROR: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit 1; }
pass() { printf '  [PASS] %s\n' "$*"; }
warn() { printf '  [WARN] %s\n' "$*"; }
fail() { printf '  [FAIL] %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }

FROM_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from-dir) FROM_DIR="${2:?--from-dir needs a directory}"; shift 2 ;;
    -h|--help)  sed -n '2,32p' "$0"; exit 0 ;;
    *)          die "unknown argument: $1" ;;
  esac
done

FAILURES=0
WORK="$(mktemp -d /root/.reconcile.XXXXXX 2>/dev/null || mktemp -d)"
chmod 700 "$WORK"
cleanup() { rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Gather the four sets
# ---------------------------------------------------------------------------
if [ -n "$FROM_DIR" ]; then
  for f in live_required live_screenshots all_keys bucket; do
    [ -f "$FROM_DIR/$f.txt" ] || die "missing $FROM_DIR/$f.txt"
    sed '/^$/d' "$FROM_DIR/$f.txt" | sort -u > "$WORK/$f.txt"
  done
  log "comparing pre-computed sets from $FROM_DIR (no network)"
else
  cd "$REPO_DIR" || die "cannot cd to $REPO_DIR"

  # psql failing inside a pipeline can still leave an empty file behind and a
  # clean exit. Run it into a temp file and check the status explicitly - an
  # empty key set would otherwise report "0 missing", which is precisely the
  # false-clean this check exists to prevent.
  q() {
    local out="$1" sql="$2"
    "${COMPOSE[@]}" exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -Atc "$sql" \
      > "$WORK/.raw" 2>"$WORK/.err" || { sed -n '1,3p' "$WORK/.err" >&2; die "query failed for $out"; }
    tr -d '\r' < "$WORK/.raw" | sed '/^$/d' | sort -u > "$WORK/$out.txt"
  }

  log "reading storage keys from the database"
  # Keys a LIVE row depends on. Soft-deleted media assets and soft-deleted
  # organizations are excluded: their objects may legitimately have been purged.
  q live_required "
    select \"originalStorageKey\" from media_assets where \"deletedAt\" is null
    union select \"processedStorageKey\" from media_assets where \"deletedAt\" is null and \"processedStorageKey\" is not null
    union select \"thumbnailStorageKey\" from media_assets where \"deletedAt\" is null and \"thumbnailStorageKey\" is not null
    union select v.\"storageKey\" from media_variants v join media_assets m on m.id = v.\"mediaAssetId\" where m.\"deletedAt\" is null
    union select \"logoStorageKey\" from organizations where \"deletedAt\" is null and \"logoStorageKey\" is not null"

  # Screenshots are diagnostics with their own retention (T013). Their objects
  # are expected to disappear while rows persist, so they are reported but must
  # never fail the run - otherwise the first retention pass makes this check
  # permanently red and everyone stops reading it.
  q live_screenshots "select \"storageKey\" from device_screenshots"

  # Every key referenced by ANY row, soft-deleted included. Anything in the
  # bucket outside this set is a true orphan.
  q all_keys "
    select \"originalStorageKey\" from media_assets
    union select \"processedStorageKey\" from media_assets where \"processedStorageKey\" is not null
    union select \"thumbnailStorageKey\" from media_assets where \"thumbnailStorageKey\" is not null
    union select \"storageKey\" from media_variants
    union select \"logoStorageKey\" from organizations where \"logoStorageKey\" is not null
    union select \"storageKey\" from device_screenshots"

  # ---- media bucket: read-only listing -----------------------------------
  # Credentials come from the running api container, so this script introduces
  # no new secret on the host. They are captured into variables and never
  # printed or passed on a command line.
  log "listing the media bucket (read-only)"
  g() { "${COMPOSE[@]}" exec -T "$API_SERVICE" printenv "$1" 2>/dev/null | tr -d '\r\n'; }
  S3_BUCKET=$(g S3_BUCKET);  [ -n "$S3_BUCKET" ] || die "could not read S3_BUCKET from the $API_SERVICE container (is the stack up?)"
  S3_ENDPOINT=$(g S3_ENDPOINT)
  S3_AK=$(g S3_ACCESS_KEY); S3_SK=$(g S3_SECRET_KEY)
  [ -n "$S3_ENDPOINT" ] && [ -n "$S3_AK" ] && [ -n "$S3_SK" ] || die "incomplete S3 configuration in the $API_SERVICE container"

  # Do not assume the scheme. Stripping a hard-coded "https://" turns a model-B
  # endpoint (http://minio:9000) into "https://http://minio:9000", which fails
  # with a confusing DNS error rather than a clear one. common.sh validates the
  # backup endpoint the same way.
  case "$S3_ENDPOINT" in
    https://*) _scheme=https; _host="${S3_ENDPOINT#https://}" ;;
    http://*)  _scheme=http;  _host="${S3_ENDPOINT#http://}"  ;;
    *) die "S3_ENDPOINT in the $API_SERVICE container has no http(s) scheme: '$S3_ENDPOINT'" ;;
  esac
  _host="${_host%%/*}"
  export RCLONE_CONFIG=/dev/null
  export RCLONE_CONFIG_MEDIA_TYPE=s3
  export RCLONE_CONFIG_MEDIA_PROVIDER=Cloudflare
  export RCLONE_CONFIG_MEDIA_REGION="$(g S3_REGION)"
  export RCLONE_CONFIG_MEDIA_ENDPOINT="$_scheme://$_host"
  export RCLONE_CONFIG_MEDIA_ACCESS_KEY_ID="$S3_AK"
  export RCLONE_CONFIG_MEDIA_SECRET_ACCESS_KEY="$S3_SK"
  export RCLONE_CONFIG_MEDIA_NO_CHECK_BUCKET=true
  export RCLONE_CONFIG_MEDIA_NO_HEAD=true

  # `lsf` and nothing else. See the banner at the top of this file.
  rclone lsf "media:${S3_BUCKET}" -R --files-only > "$WORK/bucket.raw" 2>"$WORK/.lserr" \
    || { sed -E 's/[A-Za-z0-9]{20,}/<redacted>/g' "$WORK/.lserr" | head -3 >&2; die "could not list the media bucket"; }
  sed '/^$/d' "$WORK/bucket.raw" | sort -u > "$WORK/bucket.txt"
fi

N_REQ=$(wc -l < "$WORK/live_required.txt")
N_SCR=$(wc -l < "$WORK/live_screenshots.txt")
N_ALL=$(wc -l < "$WORK/all_keys.txt")
N_BKT=$(wc -l < "$WORK/bucket.txt")

echo
log "=== database <-> media storage reconciliation ==="
printf '  live keys that must exist : %s\n  screenshot keys           : %s\n  all referenced keys       : %s\n  objects in bucket         : %s\n' \
  "$N_REQ" "$N_SCR" "$N_ALL" "$N_BKT"
echo

# ---------------------------------------------------------------------------
# Sanity assertions.
# Two empty sets compare equal, so "0 missing" from an empty query looks
# identical to a healthy result. Assert the inputs are real before believing
# the comparison.
# ---------------------------------------------------------------------------
[ "$N_BKT" -gt 0 ] || fail "the bucket listing is empty - refusing to interpret this as 'no orphans'"
[ "$N_ALL" -gt 0 ] || fail "no storage keys found in the database - refusing to interpret this as 'no missing objects'"
[ "$N_REQ" -gt 0 ] || fail "no live storage keys found - refusing to interpret this as a clean result"

if [ "$N_ALL" -ge "$N_REQ" ]; then
  pass "referenced-key set is a superset of the live set ($N_ALL >= $N_REQ)"
else
  fail "all_keys ($N_ALL) is smaller than live_required ($N_REQ) - the key sets are built wrong"
fi

# Key namespaces must line up. rclone lsf returns keys relative to the bucket
# root with no leading slash; if the DB ever stores them differently, EVERY
# object reads as both missing and orphaned, and "130 missing" looks like a
# catastrophe rather than a bug in this comparison.
if [ "$N_REQ" -gt 0 ] && [ "$N_BKT" -gt 0 ]; then
  OVERLAP=$(comm -12 "$WORK/live_required.txt" "$WORK/bucket.txt" | wc -l)
  if [ "$OVERLAP" -gt 0 ]; then
    pass "key namespaces align ($OVERLAP live keys found in the bucket)"
  else
    fail "NO live key matches any object name - this is a key-format mismatch, not $N_REQ missing objects"
  fi
fi

# ---------------------------------------------------------------------------
# The comparison
# ---------------------------------------------------------------------------
comm -23 "$WORK/live_required.txt"    "$WORK/bucket.txt" > "$WORK/missing.txt"
comm -23 "$WORK/live_screenshots.txt" "$WORK/bucket.txt" > "$WORK/missing_screens.txt"
comm -13 "$WORK/all_keys.txt"         "$WORK/bucket.txt" > "$WORK/orphans.txt"

N_MISS=$(wc -l < "$WORK/missing.txt")
N_MSCR=$(wc -l < "$WORK/missing_screens.txt")
N_ORPH=$(wc -l < "$WORK/orphans.txt")

if [ "$N_MISS" -eq 0 ]; then
  pass "every object referenced by a live row is present"
else
  fail "$N_MISS object(s) referenced by a live row are MISSING from storage"
  echo "        these assets show as 'ready' but will 404 on download:" >&2
  head -20 "$WORK/missing.txt" | sed 's/^/          /' >&2
  [ "$N_MISS" -gt 20 ] && echo "          ... and $((N_MISS - 20)) more" >&2
fi

if [ "$N_MSCR" -eq 0 ]; then
  pass "every referenced device screenshot is present"
else
  warn "$N_MSCR device screenshot(s) missing from storage - expected if T013 retention has run; not a failure"
  head -5 "$WORK/missing_screens.txt" | sed 's/^/          /'
fi

if [ "$N_ORPH" -eq 0 ]; then
  pass "no orphaned objects"
else
  warn "$N_ORPH orphaned object(s) in storage referenced by no row - harmless, reclaimed by the T013 retention job"
  head -10 "$WORK/orphans.txt" | sed 's/^/          /'
  [ "$N_ORPH" -gt 10 ] && echo "          ... and $((N_ORPH - 10)) more"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  log "=== RECONCILE PASS ==="
  exit 0
else
  log "=== RECONCILE FAIL ($FAILURES failed check(s)) ==="
  echo
  echo "  Remedies are deliberately NOT automated - they mutate production data." >&2
  echo "  For each missing object: re-upload it, or mark the asset 'failed' so the" >&2
  echo "  dashboard stops offering a download that cannot succeed." >&2
  exit 1
fi
