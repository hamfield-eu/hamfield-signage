#!/usr/bin/env bash
# Shared helpers for the Hamfield Signage backup scripts.
#
# Sourced by backup.sh and restore.sh. Contains no secrets: every credential is
# read at call time from files under $SECRETS_DIR, which lives outside the repo.

SECRETS_DIR="${SECRETS_DIR:-/root/.backup-secrets}"

# The backup bucket is DEDICATED. It is not the media bucket and holds nothing
# else. It is hard-coded here rather than passed in so that no caller, and no
# future edit to a call site, can aim a delete at the media bucket.
R2_BUCKET="hamfield-signage-backup"
R2_PREFIX="backups"
R2_REMOTE="r2backup"
R2_DIR="${R2_REMOTE}:${R2_BUCKET}/${R2_PREFIX}"

log()  { printf '%s %s\n'          "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
warn() { printf '%s WARN: %s\n'    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die()  { printf '%s ERROR: %s\n'   "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit 1; }

# Define the rclone remote through the environment instead of writing
# ~/.config/rclone/rclone.conf. Two reasons: the credentials then exist in
# exactly one place on disk ($SECRETS_DIR, mode 600), and they never appear in
# argv where any local `ps` could read them.
load_r2_env() {
  local id secret endpoint
  [ -s "$SECRETS_DIR/r2.access" ]   || die "missing or empty $SECRETS_DIR/r2.access"
  [ -s "$SECRETS_DIR/r2.secret" ]   || die "missing or empty $SECRETS_DIR/r2.secret"
  [ -s "$SECRETS_DIR/r2.endpoint" ] || die "missing or empty $SECRETS_DIR/r2.endpoint"

  id=$(tr -d '[:space:]'       < "$SECRETS_DIR/r2.access")
  secret=$(tr -d '[:space:]'   < "$SECRETS_DIR/r2.secret")
  endpoint=$(tr -d '[:space:]' < "$SECRETS_DIR/r2.endpoint")

  # Cloudflare's bucket page shows an "S3 API" URL with the bucket name appended
  # as a path. rclone wants the HOST only: if the path is left on, every object
  # key becomes <bucket>/<bucket>/backups/... Strip any path, and accept the
  # jurisdiction-specific hosts (<id>.eu.r2..., <id>.fedramp.r2...) as well as
  # the plain <id>.r2... form.
  local host
  endpoint="${endpoint%/}"
  host="${endpoint#https://}"
  host="${host%%/*}"
  case "$endpoint" in
    https://*) : ;;
    *) die "r2.endpoint must start with https:// (expected https://<ACCOUNT_ID>.r2.cloudflarestorage.com)" ;;
  esac
  case "$host" in
    *.r2.cloudflarestorage.com) : ;;
    *) die "r2.endpoint host does not look like R2 (expected <ACCOUNT_ID>[.<jurisdiction>].r2.cloudflarestorage.com)" ;;
  esac
  endpoint="https://$host"

  # There is no rclone.conf and there should not be one: silence the NOTICE it
  # logs about the missing file so the nightly journal contains only real news.
  export RCLONE_CONFIG=/dev/null
  export RCLONE_CONFIG_R2BACKUP_TYPE=s3
  export RCLONE_CONFIG_R2BACKUP_PROVIDER=Cloudflare
  export RCLONE_CONFIG_R2BACKUP_REGION=auto
  export RCLONE_CONFIG_R2BACKUP_ENDPOINT="$endpoint"
  export RCLONE_CONFIG_R2BACKUP_ACCESS_KEY_ID="$id"
  export RCLONE_CONFIG_R2BACKUP_SECRET_ACCESS_KEY="$secret"
  # The API token is scoped to this one bucket, so rclone's bucket-existence
  # probe (a ListBuckets call) is refused. Skip it.
  export RCLONE_CONFIG_R2BACKUP_NO_CHECK_BUCKET=true
  # R2 (against this rclone build) answers the post-upload HEAD that rclone
  # issues to confirm an upload with "501 Not Implemented". The object itself
  # lands correctly - rclone then retries and reports a spurious failure, which
  # would bury a real failure in the nightly log. Suppress rclone's own check:
  # backup.sh verifies the upload independently and more strictly afterwards, by
  # listing the object back and comparing its byte size against the local file.
  export RCLONE_CONFIG_R2BACKUP_NO_HEAD=true
  export RCLONE_CONFIG_R2BACKUP_ACL=private
  export RCLONE_CONFIG_R2BACKUP_STORAGE_CLASS=STANDARD
}

# Last line of defence before any delete. A path that is not inside the backup
# bucket's backups/ prefix is a bug in the caller: refuse rather than act.
assert_backup_path() {
  case "$1" in
    "${R2_DIR}/"?*) : ;;
    *) die "refusing to operate on '$1' - outside ${R2_DIR}/" ;;
  esac
  case "$1" in
    *..*) die "refusing to operate on '$1' - path traversal" ;;
  esac
}
