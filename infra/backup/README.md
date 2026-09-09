# Backup and restore

Nightly, encrypted, verified, off-box backups of the Hamfield Signage
production database and its git-ignored configuration.

Implements T011 steps 1-6 and 9. **The fresh-VPS restore drill (the acceptance
test) has NOT been performed** - see "What is still missing" below.

## What runs

| | |
|---|---|
| Schedule | `hamfield-backup.timer`, `OnCalendar=*-*-* 03:30:00` UTC, `Persistent=true` |
| Runs | `infra/backup/backup.sh` as root, from the compose project directory |
| Destination | `r2backup:hamfield-signage-backup/backups/` (a **dedicated** R2 bucket) |
| Encryption | `age`, to the public key in `/root/.backup-secrets/age.pub` |
| Audit trail | `journalctl -u hamfield-backup` |
| Failure alert | `OnFailure=hamfield-backup-failure@.service` |

Each run takes roughly 16 seconds and produces a ~5.8 MB bundle.

## What is backed up

- **PostgreSQL**, via `pg_dump -Fc` (custom format: supports parallel restore,
  selective restore and `pg_restore --list`). This is the whole product state:
  organizations, users, devices, device tokens, playlists, schedules, media
  metadata and the audit log.
- **The three git-ignored config files** - `docker-compose.yml`,
  `infra/docker/docker-compose.prod.yml`, `infra/docker/Caddyfile`. They hold the
  database password, `JWT_SECRET` and the R2 credentials. Losing them is
  equivalent to losing the database, because the Postgres password is baked into
  the `postgres-data` volume when it is first created.
  (`.env.prod` is also bundled if it ever exists; this deployment does not use one.)
- **A manifest** - UTC timestamp, deployed git SHA, image digests, dump size and
  SHA-256, the `_prisma_migrations` head, and row counts at backup time.

## What is NOT backed up, and what that costs

| Not backed up | Why | What it costs you |
|---|---|---|
| **Media objects** (images, video) | Cloudflare R2, model A - durability is Cloudflare's problem | Nothing under normal failure. But an *accidental deletion* or a compromise of the media credential is NOT covered by anything here. |
| **Redis** | Queue state is rebuildable | In-flight transcodes are lost. Recover by re-running `apps/api/src/cli/reprocess-media.ts`. |
| **Docker images** | Rebuild from the pinned git SHA in the manifest | A restore requires a rebuild, adding minutes to recovery. |
| **`caddy-data`** (TLS certs) | Let's Encrypt re-issues | Nothing, unless you restore repeatedly and hit LE rate limits. |
| **The `postgres-data` volume itself** | The logical dump supersedes it | Nothing - the dump is the better artefact. |

**Point-in-time recovery is explicitly out of scope.** Nightly logical dumps are
the right complexity for a single-VPS deployment. The cost is the RPO below.

## RPO / RTO

- **RPO (worst-case data loss): 24 hours + up to 3.5 h**, i.e. anything written
  between 03:30 UTC and the moment of failure. Concretely that is dashboard
  changes, pairings and telemetry. **Devices keep playing from their local cache
  regardless** - a server loss is not a display outage.
- **RTO: not yet measured.** It cannot be stated honestly until the fresh-VPS
  drill has been run.

## Encryption, and why the key is not here

Bundles are encrypted with `age` to a public key. **The private key does not
exist on this server, deliberately.** This box can create backups but cannot
read them back, so compromising the server does not expose the backup history.

The consequence is a hard split in what can be verified where:

| Check | Where it runs |
|---|---|
| dump size floor, `pg_restore --list` | **unattended**, on the server |
| real `pg_restore` into a throwaway container | **unattended**, on the server |
| row counts, `_prisma_migrations` head, dump SHA-256 | **unattended**, on the server |
| that a **stored, encrypted** object decrypts and restores | **manual, on a machine holding the private key** |

The unattended checks run against the bundle *before* encryption. That proves
the dump is good; it does not prove the ciphertext in R2 is retrievable and
decryptable. Only the manual check does, and only you can run it:

```
rclone copyto r2backup:hamfield-signage-backup/backups/<bundle> ./<bundle>
./infra/backup/verify-backup.sh --encrypted ./<bundle> --identity ~/signage-backup-key.txt
```

**Do this periodically.** If the public key on the server were ever wrong, every
bundle would be permanently unreadable and nothing on the server could tell.

## Retention

Pruned by `backup.sh`, only after an upload whose remote byte size has been
confirmed against the local file.

- 14 daily
- 8 weekly (Sunday)
- 12 monthly (1st)
- anything tagged `pre-upgrade-*` for 30 days

Roughly 33 bundles, about 200 MB. Names that do not parse, and tags the policy
does not recognise, are **kept and flagged** - never deleted.

> Note: T011 §5 specifies 7/4/6. The deployed policy is 14/8/12, chosen
> deliberately. The task document should be reconciled to match.

## Secrets on this host

`/root/.backup-secrets/` (mode 700, files 600):

| File | Contents |
|---|---|
| `r2.access`, `r2.secret` | R2 API token, scoped to the backup bucket ONLY |
| `r2.endpoint` | R2 S3 endpoint |
| `age.pub` | age **public** key (safe to hold here) |

There is no `rclone.conf`: the remote is defined through `RCLONE_CONFIG_*`
environment variables set from these files at call time, so the credentials
live in exactly one place and never appear in argv.

The backup token must **not** be the one the application uses for media. A leak
of the app's credentials must not reach the backups, and vice versa.

## Usage

```
./infra/backup/backup.sh                          # nightly (what the timer runs)
./infra/backup/backup.sh --tag pre-upgrade-<sha>  # before a release; kept 30 days
./infra/backup/backup.sh --no-prune               # back up, delete nothing
./infra/backup/backup.sh --prune-dry-run          # show what prune would delete
./infra/backup/backup.sh --simulate-prune FILE    # test the policy offline

./infra/backup/verify-backup.sh --plain <dir|tar.gz>
./infra/backup/verify-backup.sh --encrypted <bundle.age> --identity <key>

./infra/backup/reconcile-media.sh                 # DB <-> media storage skew
./infra/backup/reconcile-media.sh --from-dir DIR  # compare pre-computed sets

./infra/backup/restore.sh --bundle <bundle.age> --identity <key>   # DESTRUCTIVE
```

## What is still missing before T011 can be closed

1. **The fresh-VPS restore drill.** This is the acceptance test. A new VPS,
   restored from a bundle alone with no access to this server, verified against
   the T011 checklist - including that a previously paired device reconnects
   **without re-pairing**. Until this is done, recovery is asserted, not proven.
2. **A real failure notification.** `hamfield-backup-failure@.service` currently
   only writes to local syslog - the alert dies with the box it is warning about.
   Replace its `ExecStart` with an off-box notifier.
3. ~~DB <-> object storage reconciliation (T011 step 7)~~ - **done**, see
   `reconcile-media.sh`. Run it after any restore. It is read-only against the
   media bucket (`rclone lsf` and nothing else); the media bucket holds all
   customer content and is not covered by these backups.
4. **`restore.sh` has never been executed.** It is written but unproven; the
   drill is what proves it.
5. **Rotate the R2 backup token** if it has ever been exposed.
