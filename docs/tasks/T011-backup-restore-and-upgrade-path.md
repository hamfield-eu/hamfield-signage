# T011 — Backup, restore and the upgrade path

| | |
|---|---|
| **Estimate** | M |
| **Risk** | **High** — this is the task that decides whether a disk failure is an inconvenience or the end of the product |
| **Depends on** | T010 (needs a real deployment to back up) |
| **Blocks** | Every future upgrade. Nothing should be deployed to a customer before this is done and **drilled**. |
| **Status** | **Phase one complete and deployed** — nightly encrypted verified backups are running. The **restore drill is not done**, so this task is NOT finished. |

> Self-contained by design: a fresh Claude Code session has no memory of the
> review that produced this file.

---

## Objective

Make the production server **recoverable** and **upgradeable**.

Two independent guarantees:

1. **Recoverable** — if the VPS disk dies tonight, a new VPS can be restored from
   off-box backups to a working state with acceptable data loss (target: ≤ 24 h).
   This must be *proven by drill*, not asserted.
2. **Upgradeable** — a new release can be deployed through a controlled sequence
   (backup → migrate → verify → rollback-if-needed) without rebuilding from
   scratch and without ad-hoc surgery.

---

## Context from the review report

The review flagged backup/restore as **A12: Critical before real customer use**.

What exists today:

- `docs/deployment.md:§10` contains exactly two shell lines: a `pg_dump` piped to
  gzip, and a `psql` restore. No script, no schedule, no off-box destination, no
  retention, no drill, no verification.
- `docs/deployment.md:§9` documents updates as `git pull && docker compose up -d --build`,
  with a note that migrations run automatically via the one-shot `migrate`
  service. There is **no backup step before that**, and no rollback path once a
  migration has run.
- The three real config files are git-ignored by design
  (`.gitignore`: `/docker-compose.yml`, `/infra/docker/docker-compose.prod.yml`,
  `/infra/docker/Caddyfile`). They hold the DB password, `JWT_SECRET` and the S3
  credentials. **Losing them is equivalent to losing the database**, because the
  Postgres password is baked into the `postgres-data` volume on first creation.
- Migrations: `packages/database/prisma/migrations/` currently holds 6 forward
  migrations (`0_init` through `20260624000000_per_device_encoding_tiers`).
  Prisma `migrate deploy` is forward-only — **there are no down migrations**.
  This is the single most important constraint on the rollback design.
- Media objects: if T010 chose model A (Cloudflare R2), object durability is the
  provider's. If model B (self-hosted MinIO), the `minio-data` volume is
  backup-critical and much larger than the database.
- Soft deletes mean the database is the source of truth for *what exists*, while
  S3 holds the bytes. A restored database referencing objects that were purged
  from storage produces media stuck at `ready` with dead storage keys. Backups of
  the two must therefore be **coordinated in time**, or the restore must tolerate
  the skew (see "Consistency" below).

---

## Files likely involved

**Create:**
- `infra/backup/backup.sh` — dump Postgres, bundle config, ship off-box, prune
- `infra/backup/restore.sh` — restore into a fresh stack, with confirmations
- `infra/backup/verify-backup.sh` — prove a dump is restorable, not just present
- `infra/backup/README.md` — what is backed up, what is not, and why
- `docs/tasks/` sibling: the runbook narrative lives in **T014**

**Optionally create:**
- A `backup` service in `infra/docker/docker-compose.prod.example.yml` (a small
  cron-driven container), *or* a host-level systemd timer. Prefer the host timer:
  fewer moving parts, and it still works when the stack is down.

**Edit:**
- `docs/deployment.md` — replace `§10` with a pointer to the scripts and the drill
- `.gitignore` — ensure backup output directories and any credentials file are excluded

**Read-only reference:**
- `packages/database/prisma/migrations/` (migration history and lock file)
- `packages/database/prisma/schema.prisma` (what is in the DB)
- `infra/docker/docker-compose.prod.example.yml` (volume + anchor layout)

---

## Non-goals

- Point-in-time recovery (WAL archiving / `pg_basebackup` / Barman). Nightly
  logical dumps are the right complexity for a single-VPS deployment.
- Streaming replication or a hot standby.
- Backing up Redis. Queue state is rebuildable; a lost in-flight transcode is
  recovered by re-running the reprocess CLI
  (`apps/api/src/cli/reprocess-media.ts`).
- Backing up Docker images. They rebuild from the pinned git SHA.
- Automated rollback of database migrations (Prisma has no down migrations —
  rollback is restore-from-backup, by design).

---

## Implementation plan

### 1. Define exactly what must be backed up

| Item | Where | Method | Frequency | Loss if missing |
|---|---|---|---|---|
| PostgreSQL | `postgres-data` volume | `pg_dump -Fc` (custom format) | Nightly + pre-upgrade | **Total.** All orgs, users, devices, playlists, schedules, media metadata, audit log |
| `docker-compose.yml` | host, git-ignored | file copy into the bundle | On change + nightly | DB password, service topology |
| `infra/docker/docker-compose.prod.yml` | host, git-ignored | file copy | On change + nightly | **`JWT_SECRET`, DB password, S3 credentials** |
| `infra/docker/Caddyfile` | host, git-ignored | file copy | On change + nightly | Domain/TLS config (cheap to recreate) |
| `.env.prod` (if T010 used one) | host, git-ignored | file copy | On change + nightly | All secrets |
| Deployed git SHA | host | `git rev-parse HEAD` into the bundle | Every backup | Cannot reproduce the exact running version |
| Media objects | R2 (model A) *or* `minio-data` (model B) | provider durability *or* `mc mirror` / volume tar | Model B: nightly | All customer content |
| `caddy-data` | volume | optional tar | Weekly | Nothing — certs re-issue (but watch LE rate limits) |

Use `pg_dump -Fc` (custom format), not plain SQL: it supports parallel restore,
selective restore, and `pg_restore --list` for inspection.

### 2. `infra/backup/backup.sh`

Requirements:

- Run from the host as root, from the compose project directory.
- `set -euo pipefail`; fail loudly, never silently produce an empty file.
- Steps:
  1. Timestamp: `TS=$(date -u +%Y%m%dT%H%M%SZ)`.
  2. `docker compose exec -T postgres pg_dump -U signage -Fc signage > "$WORK/db.dump"`
     — note `-T` (no TTY), which is required for piping.
  3. **Assert the dump is non-trivial**: fail if it is smaller than a floor
     (e.g. 50 KB) or if `pg_restore --list` on it errors. A silently-empty dump
     that gets rotated into the retention window is the classic backup failure.
  4. Copy the config files listed above into `$WORK/config/`.
  5. Write `$WORK/manifest.txt`: timestamp, git SHA, image digests
     (`docker compose images -q`), migration status output, dump size, schema
     version (`SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 1`).
  6. `tar -czf backup-$TS.tar.gz -C "$WORK" .`
  7. Encrypt: `age` or `gpg --symmetric`. **The bundle contains `JWT_SECRET` and
     the DB password — it must not sit unencrypted on third-party storage.**
     Store the passphrase somewhere that is *not* the VPS (password manager).
  8. Ship off-box (step 3).
  9. Prune per the retention policy (step 5).
  10. Log a one-line result and exit non-zero on any failure.

- **Model B only:** add a media step — `mc mirror` the MinIO bucket to the
  off-box destination, or `docker run --rm -v minio-data:/data -v $PWD:/out alpine tar -czf /out/minio-$TS.tar.gz /data`.
  Media is large; run it less often than the DB dump if bandwidth demands, and be
  explicit about the resulting RPO.

### 3. Off-box destination

The backup is worthless on the same disk it protects. Pick one and script it:

- **Hetzner Storage Box** (natural fit; SFTP/rsync/BorgBackup, cheap, same DC region).
- Cloudflare R2 / S3 bucket with a **separate, backup-only** credential that has
  no delete permission on the media bucket.
- `rclone` to any supported remote.

Requirements: credentials stored `chmod 600` on the host; the destination account
must not be deletable using credentials that live on the VPS (ransomware /
compromise containment); enable object-lock or immutability if the provider
supports it.

### 4. Scheduling

Host-level systemd timer (preferred over cron: better logging, no mail config):

- `hamfield-backup.service` (Type=oneshot, runs `backup.sh`)
- `hamfield-backup.timer` (`OnCalendar=*-*-* 03:30:00`, `Persistent=true` so a
  missed run fires after a reboot)
- `journalctl -u hamfield-backup` is then the audit trail.
- Add a failure notification (`OnFailure=` unit that curls a webhook). **A backup
  system with no failure alerting is a backup system that stops working silently.**

### 5. Retention policy

Grandfather-father-son, pruned by the script.

**As deployed (2026-09-09), this is 14 / 8 / 12, not the 7 / 4 / 6 below.** R2
storage at this scale is free — ~34 bundles of ~6 MB is about 200 MB, inside the
free tier — so the retention window is set by "how late can I notice a mistake
and still recover", not by cost. The original figures are kept here for context:

- Keep **7** daily → **deployed: 14**
- Keep **4** weekly (Sunday) → **deployed: 8**
- Keep **6** monthly (1st of month) → **deployed: 12**
- Keep **every pre-upgrade backup for 30 days**, tagged `pre-upgrade-<sha>` (unchanged)

All four are `KEEP_*` environment overrides in `infra/backup/backup.sh`.

Document the resulting RPO explicitly: with nightly dumps, worst-case data loss
is ~24 h of dashboard changes plus device telemetry. Device *content* is
unaffected — devices keep playing from their local cache regardless.

### 6. `infra/backup/restore.sh`

- Takes a bundle path and a target compose project directory.
- **Requires an explicit confirmation string** (e.g. typing the target hostname)
  before touching anything. Restores are destructive.
- Steps:
  1. Decrypt and unpack; print `manifest.txt` and require confirmation of the
     git SHA and schema version.
  2. Restore config files first (they contain the DB password the new stack needs).
  3. `git checkout <sha>` so the code matches the schema in the dump.
  4. `docker compose up -d postgres` and wait for the healthcheck.
  5. `pg_restore --clean --if-exists -U signage -d signage` from the dump.
  6. **Do not run `migrate deploy` before verifying** — the dump already contains
     `_prisma_migrations` at the right version. Run `migrate status` and confirm
     it reports "up to date". If it reports pending migrations, the SHA is wrong.
  7. Model B: restore the MinIO volume.
  8. `docker compose up -d` for the rest.
  9. Run the post-restore verification (step 9).

### 7. Consistency between database and object storage

The DB and object storage are backed up at different instants, so a restore can
land in one of two skewed states:

- **DB newer than storage** — rows reference objects that do not exist. Symptom:
  media shows `ready` but downloads 404. Detection: a script that walks
  `MediaAsset` rows and `HEAD`s each `originalStorageKey`/`processedStorageKey`.
  Remedy: mark affected assets `failed` and re-upload, or delete the rows.
- **Storage newer than DB** — orphaned objects. Harmless; reclaimed by the
  retention job specified in **T013**.

Write the reconciliation check as part of the post-restore verification. Accept
the skew rather than trying to make the two atomic — atomicity is not worth the
complexity here, but *knowing* about the skew is mandatory.

### 8. Pre-upgrade / release procedure

This is the "safely upgradeable" half of the objective. Codify it:

```
1. Read the release notes / diff. Note whether packages/database/prisma/migrations/
   contains anything new since the deployed SHA:
     git diff --name-only <deployed-sha>..<target-sha> -- packages/database/prisma/migrations/
2. ./infra/backup/backup.sh --tag pre-upgrade-<target-sha>
3. Verify the backup: ./infra/backup/verify-backup.sh <bundle>   (step 9)
4. Take a Hetzner snapshot as a second, independent restore point.
5. git fetch && git checkout <target-sha>
6. Re-check the three git-ignored config files against the updated *.example.*
   templates for new required variables. A new required env var that is missing
   will fail the API's zod schema at startup (apps/api/src/env.ts).
7. docker compose -f docker-compose.yml -f infra/docker/docker-compose.prod.yml build
8. docker compose run --rm migrate          # migrations, explicitly, before the swap
9. docker compose up -d
10. Run the T010 smoke test.
11. If broken -> rollback (step 10).
```

**Migration safety rules:**

- Prisma migrations are forward-only. Treat every migration as irreversible.
- Additive migrations (new nullable column, new table, new enum value) are safe
  to run before the new code is live — the old code ignores them. All six
  existing migrations are of this shape.
- Destructive migrations (drop/rename column, narrow a type) require a two-phase
  release: deploy code that tolerates both shapes, then a later release that
  removes the old shape. Never combine a destructive migration with the code
  change that depends on it in a single deploy.
- Note the existing enum-widening pattern in
  `20260624000000_per_device_encoding_tiers` (`ALTER TYPE ... ADD VALUE`).
  In PostgreSQL this cannot run inside a transaction block — a failure there
  leaves the enum partially altered. Worth calling out in the runbook.

### 9. Verification — the part that makes this real

`infra/backup/verify-backup.sh`:

- Spins up a **throwaway** Postgres container.
- `pg_restore` the dump into it.
- Asserts row counts for the tables that matter: `users`, `organizations`,
  `devices`, `media_assets`, `playlists`, `schedules`, `audit_logs`.
- Asserts the `_prisma_migrations` head matches the manifest.
- Tears the container down and reports pass/fail.

Run it automatically after every nightly backup and fail the systemd unit if it
does not pass. **A backup that has never been restored is not a backup.**

### 10. Rollback procedure

| Scenario | Rollback |
|---|---|
| Config change broke the deploy, no migration ran | Restore the previous config files, `docker compose up -d`. Seconds. |
| New code broke the deploy, no new migration | `git checkout <previous-sha>`, rebuild, `up -d`. Minutes. Data untouched. |
| New code + additive migration, code is broken | `git checkout <previous-sha>`, rebuild, `up -d`. The extra columns are ignored by the old code. Minutes. **This is why additive-only migrations matter.** |
| New code + destructive migration, anything broken | **Full restore from the pre-upgrade backup.** Restore script, previous SHA. Expect ~15–30 min and loss of everything written since the pre-upgrade backup. |
| Disk failure / VPS loss | Provision a new VPS, run T010's first-deploy, then `restore.sh` with the latest bundle. |

Record the expected duration of each so an incident does not become a guessing
game about whether to wait or roll back.

---

## Acceptance criteria

- [ ] `backup.sh` runs unattended nightly and produces an encrypted bundle
      containing the DB dump, all config files, and a manifest with the git SHA
      and schema version.
- [ ] The bundle lands **off the VPS** automatically, on storage that cannot be
      deleted with credentials held on the VPS.
- [ ] `verify-backup.sh` runs after every backup and the systemd unit fails
      loudly (with a notification) if verification fails.
- [ ] Retention prunes correctly and keeps pre-upgrade backups for 30 days.
- [ ] **The drill has been performed:** a completely fresh VPS was provisioned
      and restored from a backup bundle alone, with no access to the original
      server, and the result was verified against the checklist below. The date
      and outcome are recorded in the runbook (T014).
- [ ] Restoring produces a stack where: superadmin login works; orgs, users,
      devices, playlists and schedules are all present; a previously paired
      device reconnects and syncs **without re-pairing** (device tokens are in
      the DB, hashed, so this must work); media downloads succeed; the audit log
      is intact.
- [ ] The upgrade procedure is documented and has been executed at least once on
      a non-production host.
- [ ] The rollback table above is documented with measured durations.
- [ ] `infra/backup/README.md` states plainly what is **not** backed up (Redis,
      images, in-flight jobs) and what that costs.

---

## Testing checklist

- [ ] Run `backup.sh`; inspect the bundle contents manually.
- [ ] Corrupt a dump deliberately and confirm `verify-backup.sh` fails.
- [ ] Simulate a full `pg_dump` failure (stop postgres mid-backup) and confirm
      the script exits non-zero and does **not** rotate away a good backup.
- [ ] Fill the backup destination and confirm the failure is reported.
- [ ] **Full drill:** new VPS → T010 first-deploy → `restore.sh` → verify.
      Time it. This is the acceptance test for the whole task.
- [ ] Confirm a real (or mock) device that was paired before the backup
      reconnects to the restored server with its existing token.
- [ ] Restore into a stack running the **wrong** git SHA and confirm
      `migrate status` reports the mismatch rather than silently proceeding.
- [ ] Model B only: restore the MinIO volume and confirm media downloads work.
- [ ] Model A only: run the DB↔storage reconciliation check and confirm it
      detects a deliberately deleted object.
- [ ] Run the full upgrade procedure on a staging host including a rollback.

---

## Rollback / safety notes

- **The backup bundle contains `JWT_SECRET`, the database password and S3
  credentials.** Encrypt it, and keep the passphrase off the VPS. An unencrypted
  bundle on third-party storage is a full compromise of the platform.
- Restores are destructive (`pg_restore --clean`). The script must require an
  explicit typed confirmation and must refuse to run against a database that
  already contains data unless forced.
- Never test a restore against the production database. Always use a fresh host
  or a throwaway container.
- After any restore, **rotate `JWT_SECRET`** if there is any suspicion the bundle
  was exposed. Note that rotating it invalidates all dashboard sessions (users
  re-login) but does **not** affect devices — device tokens are independent
  (`apps/api/src/lib/tokens.ts`, SHA-256 hashed in `device_tokens`).
- Schedule the nightly backup outside any window where large media uploads are
  expected, to avoid a dump racing a long transaction.

---

## Field notes from the phase-one implementation (2026-09-09)

Recorded so the drill session does not rediscover them. Everything here was
found by running the code, not by reading it.

**Found while building `backup.sh` / `verify-backup.sh`:**

1. `pg_isready` returns success against the *temporary* server the official
   postgres entrypoint runs while initialising a cluster. Waiting on it alone
   hands back a connection that dies mid-restore with
   `FATAL: the database system is shutting down`. Wait for the
   `PostgreSQL init process complete` marker first, then for readiness.
2. `age` writing its output into the directory `tar` was reading produced
   `tar: file changed as we read it`. Bundle contents now live in a
   subdirectory. The failure was safe — no upload, no prune.
3. Cloudflare's bucket page shows an "S3 API" URL with the bucket name appended
   as a path. Left as-is, every object key becomes `<bucket>/<bucket>/backups/…`.
   `load_r2_env` strips the path and validates the host.
4. R2 answers rclone's post-upload `HEAD` with `501 Not Implemented`. The object
   lands fine, but rclone retries and logs a spurious failure that would bury a
   real one. Disabled via `no_head`; `backup.sh` reads the object size back
   itself, which is a stronger check.
5. `pg_restore --list` cannot read a custom-format archive from a pipe. It reads
   the real file inside a throwaway container instead.

**Found in review, before the scripts were committed:**

6. `case "$TAG" in ""|[A-Za-z0-9._-]*)` validates only the **first** character —
   a glob of that shape means "one allowed char followed by anything", so
   `a/../../etc` passed. Replaced with an anchored regex. `assert_backup_path`
   was the only thing catching it.
7. `verify-backup.sh` did not check that the bundle's **config files** were
   present. A bundle with a perfect dump and no `config/` would pass — and then
   restore into a database nobody can authenticate against, since the Postgres
   password is baked into the volume at creation. It now cross-checks the
   bundle against the manifest's `config_files:` line.
8. `restore.sh` step 6 runs `git checkout <bundle sha>`. Now that
   `infra/backup/` is tracked, restoring a bundle older than that commit
   **deletes the running script mid-execution**. It now re-execs from a copy in
   `/tmp` first. This would have fired on the first drill using any of the four
   bundles taken before 2026-09-09.
9. `restore.sh` writes `<config>.pre-restore.<timestamp>` into the repo before
   overwriting. Those hold the database password and were not git-ignored —
   same class of bug as the `*.bak` gap found during the MinIO cleanup.
   `.gitignore` now covers them.

**Restore rehearsal, 2026-09-09 (NOT the drill):**

Run on a workstation, not a fresh VPS, and authorised as a scoped substitute for
the full drill. Bundle `backup-20260909T155753Z` (5.8 MB) pulled from R2 and
opened with the real age private key — **the first time any stored bundle had
been decrypted**. Matching public keys had been confirmed earlier; this proved
the round trip.

Passed, in 20 seconds:

- decrypt with the real identity; archive contains `db.dump`, `manifest.txt` and
  all three config files
- `db.dump` sha256 matches the manifest
- `pg_restore` into a throwaway `postgres:16-alpine` (`--network none`, no
  volumes) completes with no errors
- row counts identical to production: users 2, organizations 1, devices 4,
  media_assets 70, playlists 4, schedules 3, audit_logs 54
- `_prisma_migrations` head is `20260624000000_per_device_encoding_tiers`,
  matching the manifest — so a restore needs no `migrate deploy`
- **`device_tokens`: 2 rows, both live, both 64-char SHA-256 hashes.** This is
  what lets a paired device reconnect without re-pairing, and it survives.
- superadmin `jeff@hamfield.eu` present, `globalRole=superadmin`, 60-char bcrypt
  hash intact, not disabled

What this does NOT establish, and why the drill still stands: the machine already
had Docker, the repo and the images, so it says nothing about whether a bare VPS
plus `docs/deployment.md` plus a bundle is *sufficient*. No stack was started —
Caddy was never run (an ACME attempt for the production domain risks a
Let's Encrypt lockout) and the R2 media credentials were never used. `restore.sh`
itself remains unexecuted end to end, and RTO is still unmeasured.

Also observed, from the manifest: bundle composition is ~99% telemetry —
`playback_events` 87,615 and `device_heartbeats` 30,733 against 70 media assets.
T013's retention job is therefore what governs backup size, not just server disk.

**Still open, beyond the drill:**

- `OnFailure` only writes to local syslog — the alert dies with the box it is
  warning about. A **dead-man's switch** (an external service that alarms on a
  *missing* ping) is the right shape here: it catches a failed job, a hung job,
  a dead server and a deleted timer with one mechanism.
- DB↔storage reconciliation (step 7) is not implemented; `restore.sh` lists it
  in its closing checklist.
- No `flock`, so a manual run during the 03:30 timer would overlap. Harmless
  today (a run takes ~16 s and bundles are timestamped) but worth adding.
- Media objects are covered against disk failure by R2 durability, but **not
  against accidental deletion or a compromised media credential**. Enabling
  object versioning on the media bucket closes that; it belongs to T012.
