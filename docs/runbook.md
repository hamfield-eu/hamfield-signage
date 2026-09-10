# Production runbook — Hamfield Signage

Day-two operations for `signage.hamfield.eu`. First-time installation lives in
[deployment.md](deployment.md); this document is what you open when something
needs to be deployed, checked, or fixed.

> **Read this box before you trust anything below.**
>
> Every procedure block carries a provenance tag. It tells you whether the
> commands were actually run, and where. This matters more than the commands
> themselves — at 2am you need to know which of these are proven and which are
> best-effort reconstruction.
>
> | Tag | Meaning |
> |---|---|
> | `[PROD]` | Executed against `signage.hamfield.eu`, **as written**, and the output matched. |
> | `[PROD-PARTS]` | The individual commands ran on production, but **this sequence has never been executed as a unit**. Assembled from verified pieces. |
> | `[LOCAL]` | Executed on a workstation against real production data (a restored dump or a downloaded backup bundle). Proves the command; does not prove it in situ. |
> | `[TESTED]` | Covered by automated tests in this repo, but the containing feature is **not yet deployed** (see §1, "Deployed version"). |
> | `[UNVERIFIED]` | Written from source-reading. **Never executed.** Read it, then confirm before relying on it. |
>
> There is no fresh-VPS restore drill behind this document. See §8.

---

## Table of contents

1. [At a glance](#1-at-a-glance)
2. [Initial VPS setup](#2-initial-vps-setup)
3. [Firewall rules](#3-firewall-rules)
4. [DNS and TLS](#4-dns-and-tls)
5. [First deploy](#5-first-deploy)
6. [Update / release deploy](#6-update--release-deploy)
7. [Migration handling](#7-migration-handling)
8. [Backup and restore](#8-backup-and-restore)
9. [Rollback](#9-rollback)
10. [Checking logs](#10-checking-logs)
11. [Checking service health](#11-checking-service-health)
12. [Smoke test](#12-smoke-test)
13. [Adding a new device](#13-adding-a-new-device)
14. [Pairing a Chromebox (x86)](#14-pairing-a-chromebox-x86)
15. [Common failure modes](#15-common-failure-modes)
16. [Decision rules and ownership](#16-decision-rules-and-ownership)

---

## 0. The `dc` shorthand

**Set this up first.** Every `docker compose` command in this runbook is
written as `dc`, so the code fences copy-paste cleanly. Define it as a
**function** in `~/.bashrc` — not an alias, which breaks the `-v` guard used in
scripts:

```bash
dc() {
  docker compose --env-file /root/hamfield-signage/.env.prod \
    -f /root/hamfield-signage/docker-compose.yml \
    -f /root/hamfield-signage/infra/docker/docker-compose.prod.yml "$@"
}
```

`[PROD-PARTS]` — a `dc` function was used during the T010–T013 work, but not
with these exact absolute paths. **Confirm it resolves before you rely on it:**

```bash
type dc && dc ps
```

> A previous session lost this mid-deploy and wasted time on
> `dc: command not found`. It is defined in `~/.bashrc`, so it exists in an
> interactive login shell and **not** in `cron`, `systemd` units, or
> `ssh host '<command>'`. In those, write the invocation out in full.

The expansion is not cosmetic: every invocation must include **both** compose
files and `--env-file .env.prod`. Running plain `docker compose up -d` from the
repo root uses the base file only and will **not** produce the production
topology.

---

## 1. At a glance

| | |
|---|---|
| **Production URL** | `https://signage.hamfield.eu` |
| **Host** | Hetzner Cloud VPS |
| **Repo on host** | `/root/hamfield-signage` (this is the path baked into `infra/backup/systemd/hamfield-backup.service`) |
| **TLS** | Let's Encrypt via Caddy, automatic renewal; certs persist in the `caddy-data` volume |
| **Object storage** | Cloudflare R2 — media bucket `signage-media`, backup bucket `hamfield-signage-backup` (Infrequent Access) |
| **Backups** | Nightly 03:30 UTC via `hamfield-backup.timer` → encrypted → R2 |
| **Alerts** | ntfy (topic URL is a secret — see below) |
| **Owner / escalation** | Single operator: the project owner. There is no second on-call. |

### The three git-ignored config files

These are **not in git by design** (`.gitignore`), which makes this runbook and
the backup bundles the only record that they exist:

| File | Holds |
|---|---|
| `/root/hamfield-signage/docker-compose.yml` | Service topology |
| `/root/hamfield-signage/infra/docker/docker-compose.prod.yml` | Production overrides |
| `/root/hamfield-signage/infra/docker/Caddyfile` | Domain and TLS config |
| `/root/hamfield-signage/.env.prod` | **All secrets** — DB password, `JWT_SECRET`, S3 credentials |

Their templates are `docker-compose.example.yml`,
`infra/docker/docker-compose.prod.example.yml`, `infra/docker/Caddyfile.example`
and `.env.prod.example`. Every backup bundle contains a copy of the real four.

### Where the secrets live

**No secret values appear in this runbook.** Locations only:

| Secret | Where it lives | Who holds it |
|---|---|---|
| DB password, `JWT_SECRET`, S3 keys | `/root/hamfield-signage/.env.prod` on the VPS, and inside every backup bundle | Owner |
| Backup `age` **private** key | Owner's workstation + password manager. **Deliberately not on the VPS** — the host can write backups it cannot read | Owner |
| Backup `age` public key | `infra/backup/age.pub` on the VPS (not a secret) | — |
| R2 media + backup API tokens | `.env.prod` / rclone env config on the VPS; Cloudflare dashboard | Owner |
| ntfy topic URL | `.env.prod` on the VPS (`ALERT_NTFY_URL`) + owner's password manager | Owner |

> The ntfy topic name **is** the access control on ntfy.sh — anyone who knows it
> can read and post alerts. It must never be committed, pasted into an issue, or
> written here.

### Deployed version

```bash
cd /root/hamfield-signage && git rev-parse HEAD
```

`[PROD]`

**Last recorded deployed SHA: `a7a9661` (2026-09-09)** — `[UNVERIFIED]`, this
is inferred from what was known to be deployed, not read off the host. **Run the
command above and correct this line** before using it for a rollback target.

What is certain: everything from `6e3c621` onward — all of T012 (security
hardening) and T013 (health, retention, alerting) — is committed and pushed but
**not yet deployed**.

Practical consequences until that deploy happens:

- `GET /health/ready` returns 404. Only `GET /health` exists in production.
- No retention job, no ntfy alerts, no worker-liveness key.
- Containers still run as root; the dashboard has no security headers.
- Sections marked `[TESTED]` below describe code that is not running yet.

**Update that SHA in this file as the last step of every deploy** (§6, step 12).
A runbook that names the wrong version is how a rollback targets the wrong
commit.

---

## 2. Initial VPS setup

`[UNVERIFIED]` — **the entire section.** The production host was provisioned
before this runbook existed and has never been rebuilt from these steps. This is
a reconstruction from `docs/deployment.md` and the repo, not a transcript. If
you are actually rebuilding, expect to debug.

- **Sizing.** The CPU driver is the `worker`: it runs `ffmpeg` with
  `-preset medium` (`packages/media/src/transcode.ts`) at `WORKER_CONCURRENCY`
  2 by default. Transcoding, not serving, is what saturates the box.
- **Build RAM.** `api.Dockerfile`, `worker.Dockerfile` and `web.Dockerfile` each
  run `pnpm install` at build time. The *build* needs meaningfully more RAM than
  the steady state. Add swap if RAM is tight — an OOM-killed build fails in
  confusing ways.
- **OS baseline.** Debian/Ubuntu LTS, `unattended-upgrades` enabled, timezone
  and NTP set. Server timestamps in this runbook are UTC.
- **SSH.** Key-only, `PasswordAuthentication no`, root login disabled.
  > Currently **not applied** on production — SSH hardening is on the backlog,
  > deprioritised by the owner. Access is restricted at the Hetzner Cloud
  > Firewall to the admin IP instead (§3).
- **Docker + compose plugin ≥ v2.24.4.** Required: the prod override uses
  `!reset []`, which older compose silently mishandles.
- Clone to `/root/hamfield-signage` and record the SHA.

---

## 3. Firewall rules

The authoritative control is the **Hetzner Cloud Firewall**, not `ufw`.

> **Why `ufw` alone is not enough:** Docker writes its own `iptables` rules
> directly into the `DOCKER` chain, which is traversed *before* the chains `ufw`
> manages. A published container port can therefore be reachable from the
> internet even when `ufw` claims to deny it. On this host `ufw` is inactive and
> the cloud firewall is the only enforcement layer — which is the correct
> arrangement, not an oversight.

| Port | Proto | Source | Purpose |
|---|---|---|---|
| 22 | TCP | admin IP only | SSH |
| 80 | TCP | any | ACME HTTP-01 + redirect to 443 |
| 443 | TCP | any | Dashboard, API, device WSS |
| — | ICMP | any | Diagnostics |

Outbound: all allowed. Everything else inbound: denied.

`[PROD]` — owner-attested standing configuration, read from the Hetzner Cloud
Firewall. This is a config statement, not command output; see the verification
caveat immediately below.

### Verification

These ports **must** be closed from the internet: `4000` (API), `5173` (Vite
dev), `5432` (Postgres), `6379` (Redis), `9000`/`9001` (MinIO — the containers
were removed as leftovers during T012, but check anyway).

```bash
nmap -Pn signage.hamfield.eu
```

`[UNVERIFIED]` as an *external* audit. A scan was run during T012, but **from
the admin's own network** — the one source permitted to reach port 22. That scan
therefore cannot demonstrate that 22 is closed to anyone else; it can only
confirm the other ports. To actually verify, run the scan from an unrelated
network (a mobile hotspot, or a cloud shell). Expect `22/tcp filtered` from
there.

---

## 4. DNS and TLS

`[PROD]` for the outcome — the live deployment issues and renews certificates by
this route, and `curl https://signage.hamfield.eu/health` has been served over a
valid certificate throughout. `[UNVERIFIED]` for the three diagnostic commands
below as a troubleshooting sequence.

- A/AAAA record → the VPS IP, at the registrar.
- **Point DNS at the server only after the stack is up.** Let's Encrypt
  rate-limits repeated failures and can lock you out for a week. A broken stack
  behind live DNS burns attempts you cannot get back.
- **Cloudflare users: keep the record DNS-only (grey cloud)** until certificates
  issue. Orange-cloud proxying breaks the ACME HTTP-01 challenge, and can break
  the device WebSocket upgrade. This is repeated from
  [deployment.md §13](deployment.md) deliberately — this is where you will be
  looking during an outage.

```bash
dig +short signage.hamfield.eu
curl -fsSI https://signage.hamfield.eu/ | head -n 5
dc logs caddy          # see §0 for the full invocation
```

Renewal is automatic. The only thing to check is that `caddy-data` is a
**persistent named volume** — if it is not, every container recreation asks
Let's Encrypt for a new certificate and you will hit the rate limit.

```bash
docker volume ls | grep caddy
```

---

## 5. First deploy

See [deployment.md](deployment.md) §§4–8 for the full procedure — it is not
duplicated here. What matters operationally:

1. Build config from the four templates (§1).
2. Bring the stack up; `migrate` runs as a one-shot service and must exit 0.
3. Superadmin bootstrap runs on first API start from `INITIAL_SUPERADMIN_*`.
   If those were blank:
   ```bash
   dc exec api node apps/api/dist/cli/create-superadmin.js \
     admin@example.com 'StrongPass12+' 'Platform Admin'
   ```
4. **Rotate the superadmin password after first login. This is mandatory** —
   the bootstrap password sits in `.env.prod` and in every backup bundle.
5. Run the full smoke test (§12).

---

## 6. Update / release deploy

The controlled sequence. Tick these off literally.

```
[ ]  1. Check whether any migration is included:
        git diff --name-only <deployed-sha>..<target-sha> -- packages/database/prisma/migrations/
        Empty output => rollback is cheap (§9). Non-empty => read §7 first.

[ ]  2. Take a tagged pre-upgrade backup:
        /root/hamfield-signage/infra/backup/backup.sh --tag pre-upgrade-<sha>

[ ]  3. Verify that bundle — it must PASS before you continue:
        /root/hamfield-signage/infra/backup/verify-backup.sh --plain <dir|tar.gz>

[ ]  4. Take a Hetzner snapshot. This is a second, independent restore point
        that does not depend on the backup scripts being correct.

[ ]  5. Announce the window if the screens are customer-facing.

[ ]  6. git fetch && git checkout <target-sha>

[ ]  7. Diff the templates against your four real config files for newly
        required env vars:
        git diff <deployed-sha>..<target-sha> -- '*.example.*' .env.prod.example
        A missing required var fails the zod schema in apps/api/src/env.ts at
        startup, and the API exits immediately.

[ ]  8. Build:
        dc build

[ ]  9. Migrate explicitly, so you see the result before anything restarts:
        dc run --rm migrate

[ ] 10. dc up -d

[ ] 11. If the Caddyfile or any bind-mounted config changed:
        dc restart caddy
        (see the note below — this one has bitten this deployment)

[ ] 12. Smoke test (§12).

[ ] 13. Record the new SHA in §1 of this runbook, commit, push.
```

`[PROD-PARTS]` — **this checklist has never been run end to end as a unit.**
Per step:

| Step | Provenance |
|---|---|
| 2, 3 (backup + verify) | `[PROD]` — the nightly path, run repeatedly under T011 |
| 6, 8, 10, 11 (checkout, build, up, restart caddy) | `[PROD]` — executed individually during the T010 `.env.prod` migration |
| 9 (`run --rm migrate`) | `[PROD-PARTS]` — migrations have applied on production, but via the one-shot `migrate` service during `up`, **not** as a standalone `run --rm` ahead of it. The standalone form is documented in `deployment.md` §9 and is the safer order, because you see the result before anything restarts — but confirm it on the next deploy |
| 1, 7 (the two diffs) | `[UNVERIFIED]` — plain `git diff`, but not run in this form |
| 4 (Hetzner snapshot) | `[UNVERIFIED]` |
| 12, 13 | see §12 |

> **Step 11 is not optional when config changed.** A bind-mounted `Caddyfile` is
> **not** re-read by `up -d`; the container keeps its old config and you get a
> 502 across the whole site. This happened during the T010 deploy and
> `restart caddy` cleared it. `up -d` alone was not enough.

> **Web image older than 2026-09-09:** add `restart web` after every `up -d`, or
> rebuild `web` once. Older builds pin the `api` container's IP at nginx startup
> and 502 on every `/api/…` call once that IP changes. The current
> `infra/docker/web-nginx.conf` fixes this with a `resolver` plus a variable
> `proxy_pass`, so a single rebuild removes the need permanently. `[PROD]` —
> reproduced and fixed during T012.

### Expected impact

- **Downtime: roughly 30 seconds** while containers restart. `[UNVERIFIED]` as a
  measured figure — it is the expected shape, never timed with a stopwatch.
- **Screens keep playing throughout.** The device agent plays from its local
  cache (`apps/agent/src/db.ts` + `/var/lib/signage/media`) and resyncs when the
  API returns. A server restart is not a display outage. `[PROD]` — the fleet
  stayed up across the T010 deploy.

---

## 7. Migration handling

**Prisma `migrate deploy` is forward-only. There are no down migrations.**
Every migration in this project is effectively irreversible. "Rollback" of a
migration means *restore from backup* — there is no other mechanism. Internalise
this before you deploy anything schema-touching.

- **Additive migrations** — new nullable column, new table, new enum value — are
  safe ahead of the code: old code ignores what it does not know about. All
  current migrations are this shape, including the two added by T012/T013
  (`user_password_changed_at`, `retention_and_playstats_indexes`).
- **Destructive migrations** require a two-phase release: ship tolerant code
  first, remove the old shape in a *later* release. **Never combine them.** A
  single release that both drops a column and ships code assuming it is gone has
  no cheap rollback.
- **`ALTER TYPE ... ADD VALUE`** (used in
  `20260624000000_per_device_encoding_tiers`) cannot run inside a transaction in
  PostgreSQL. A failure mid-way can leave the enum partially altered. **If
  migrate fails on an enum change, stop and restore. Do not retry blindly** —
  a retry against a half-applied enum can compound the damage.

Check migration state:

```bash
dc exec api node packages/database/node_modules/prisma/build/index.js \
  migrate status --schema packages/database/prisma/schema.prisma
```

`[PROD]`

> A restored backup does **not** need `migrate deploy` afterwards. The bundle's
> `_prisma_migrations` head matches the manifest, so the restored database is
> already at the recorded schema version. `[LOCAL]` — confirmed during the
> 2026-09-09 rehearsal.

---

## 8. Backup and restore

### What runs

A systemd timer, `hamfield-backup.timer`, nightly at **03:30 UTC**. It runs
`backup.sh`, which dumps PostgreSQL with `pg_dump -Fc`, bundles the dump with
the four git-ignored config files, the deployed git SHA and a manifest, verifies
the bundle by restoring it into a throwaway container, encrypts it to an `age`
public key, and ships it to the R2 bucket `hamfield-signage-backup`.

The private key is **not on the server**. The host can create backups it cannot
read. That is deliberate: a compromised VPS cannot decrypt the backup history.

```bash
journalctl -u hamfield-backup -n 100          # last run
systemctl list-timers hamfield-backup.timer   # next run
```

`[PROD]`

### Ad-hoc backup and verification

```bash
cd /root/hamfield-signage

./infra/backup/backup.sh                          # what the timer runs
./infra/backup/backup.sh --tag pre-upgrade-<sha>  # kept 30 days
./infra/backup/backup.sh --no-prune               # back up, delete nothing
./infra/backup/backup.sh --prune-dry-run          # show what prune would delete

./infra/backup/verify-backup.sh --plain <dir|tar.gz>
./infra/backup/verify-backup.sh --encrypted <bundle.age> --identity <key>
```

`[PROD]` for `backup.sh` and `--plain` verification (the nightly path).
`[LOCAL]` for `--encrypted` — that mode needs the private key, which by design
only exists on the owner's workstation.

`verify-backup.sh` never touches the live stack: it uses `docker run`, not
`docker compose`, with no volumes and no network, and asserts that
`users, organizations, devices, media_assets, playlists, schedules, audit_logs`
all contain rows.

### Restore

```bash
cd /root/hamfield-signage
./infra/backup/restore.sh --bundle <bundle.age> --identity <key>   # DESTRUCTIVE
```

`[UNVERIFIED]` — **`restore.sh` has never been executed end to end.** It is
written but unproven. If you are running it during a real incident, you are
debugging it and recovering at the same time. Read it first; prefer restoring
into a scratch host before pointing production at the result.

### Drill and rehearsal record

Two separate things, deliberately not conflated:

**Drills** — a full recovery on a fresh VPS from a bundle alone.

| Date | Result | Duration |
|---|---|---|
| *(none)* | — | — |

> **No drill has ever been performed.** It was **waived by the project owner on
> 2026-09-09** as a scheduling decision, with the rehearsal below accepted in its
> place. This is recorded as a decision, not an omission. Residual risk: it is
> unproven that a bare VPS + `deployment.md` + a bundle is sufficient to rebuild,
> and **RTO is unmeasured**.

**Rehearsals** — partial exercises that prove specific links in the chain.

| Date | What was proven | What it did **not** prove | Duration |
|---|---|---|---|
| 2026-09-09 | Bundle `backup-20260909T155753Z` pulled from R2, decrypted with the real `age` private key, archive contents and dump sha256 checked, `pg_restore` into a throwaway container, row counts identical to production, `_prisma_migrations` head matching the manifest, 2 live 64-char `device_token` hashes surviving (so **paired screens reconnect without re-pairing**), superadmin bcrypt hash intact | Nothing about a bare VPS — the machine already had Docker, the repo and the images. **No stack was started**; Caddy was never run, because an ACME attempt for the production domain risks a Let's Encrypt lockout. `restore.sh` was not used. | ~20 s (decrypt + restore only) |

**A rehearsal older than six months should be treated as untested.** Re-run by
2027-03-09 at the latest.

### What is NOT backed up

| Not covered | Cost | Recovery |
|---|---|---|
| Redis / BullMQ queue state | In-flight jobs lost | Re-enqueue: `dc exec api node apps/api/dist/cli/reprocess-media.js` `[UNVERIFIED]` — path inferred from `apps/api/src/cli/reprocess-media.ts` and the `tsc -p tsconfig.json` build; the sibling `create-superadmin.js` is attested at that path. Confirm with `dc exec api ls apps/api/dist/cli` |
| Media objects (images/video) | All customer content | **Relies entirely on Cloudflare R2 durability.** R2 has **no object versioning** (`PutBucketVersioning` is not implemented), so an accidental or malicious delete is not recoverable from the media bucket itself. Risk explicitly accepted by the owner, 2026-09-09. |
| In-flight transcodes | Partial outputs | Reprocess the affected assets |
| TLS certificates | Re-issued by ACME | Automatic, but counts against rate limits |

Run `/root/hamfield-signage/infra/backup/reconcile-media.sh` after any restore to find DB ↔ object
storage skew. It is read-only against the media bucket (`rclone lsf` only).

### RPO / RTO

- **RPO: 24 h + up to 3.5 h** — anything written between 03:30 UTC and the
  failure. Concretely: dashboard changes, pairings, telemetry.
- **RTO: unmeasured.** `[UNVERIFIED]` — it cannot be stated honestly until a
  drill runs. Do not quote a number to a customer.

> Screens keep playing from cache regardless. **A total server loss is not
> immediately a display outage** — it is a management outage that becomes a
> display outage as content goes stale.

---

## 9. Rollback

### Decision rule

> **Did a migration run?**
> **No** → roll back the code. Minutes, no data loss.
> **Yes** → **do not improvise.** Restore from the pre-upgrade backup.
> Checking out the old code leaves the schema ahead of the image that expects
> it. There is no down migration to save you.

### Scenarios

| Scenario | Action | Expected cost |
|---|---|---|
| Config change broke it, no migration | Restore the previous config file, `up -d` | Seconds `[UNVERIFIED]` |
| New code broke it, no new migration | `git checkout <previous-sha>`, build, `up -d` | Minutes; data untouched `[UNVERIFIED]` |
| New code + **additive** migration, code broken | `git checkout <previous-sha>`, build, `up -d`. The extra columns are simply ignored by the old code. **This is why additive-only migrations matter.** | Minutes `[UNVERIFIED]` |
| New code + **destructive** migration, anything broken | **Full restore from the pre-upgrade backup**, then the previous SHA | Loss of everything written since the pre-upgrade backup. Duration **unmeasured** |
| Disk failure / VPS loss | New VPS → first-deploy (§5) → `restore.sh` with the latest bundle | **Unmeasured — never drilled** |

> **All durations in this table are estimates, not measurements.** `[UNVERIFIED]`
> — the upgrade procedure has never been executed on a non-production host, so
> nothing here was timed. Do not use these figures to decide whether to wait or
> roll back; use them only to understand relative cost. Time the next real
> deploy and replace them.

`git checkout` never touches `.env.prod` or the three config files — they are
git-ignored. If you changed one as part of the upgrade, restore your copy of it
too.

---

## 10. Checking logs

| Need | Command |
|---|---|
| API | `dc logs -f api` (JSON in production) |
| Worker / transcoding | `dc logs -f worker` |
| TLS / proxy | `dc logs -f caddy` |
| Dashboard proxy (nginx) | `dc logs -f web` |
| Migrations | `dc logs migrate` |
| Backups | `journalctl -u hamfield-backup` |
| Device agent | `signage logs -f` (on the device) |
| Kiosk browser | `signage player-logs -f` (on the device) |
| Device logs, centrally | Dashboard → screen → Logs, or `GET /orgs/:orgId/devices/:deviceId/logs` |

`[PROD]` for `logs api`, `logs worker`, `logs caddy`, `logs migrate` and
`journalctl -u hamfield-backup` — all run on production during T010–T013.
`[UNVERIFIED]` for `logs web` and for both device-side commands; the syntax is
from `infra/device/signage`, but these were not run for this runbook.

### The greps that matter in an incident

```bash
dc logs api    | grep -i "device websocket"      # pairing / WSS upgrade
dc logs api    | grep -i "superadmin"            # bootstrap (password never logged)
dc logs worker | grep -iE "processing failed|ffmpeg"
dc logs api    | grep -iE "sync failed|syncStatus"
dc logs migrate                                  # always read in full; it is short
```

Production API logs are JSON. `| jq -R 'fromjson? // .'` makes them readable.
`[UNVERIFIED]` — the `jq` filter itself is untested here.

---

## 11. Checking service health

```bash
dc ps          # all running/healthy; migrate must show exited (0)
curl -fsS https://signage.hamfield.eu/health      # liveness -> {"status":"ok",...}
df -h                                             # disk
docker system df                                  # image/volume/build-cache usage
```

`[PROD]`

> `migrate` showing `exited (0)` is **correct**, not a crash. It is a one-shot
> job. `exited (1)` is the problem — see §15.

### Deep readiness — not yet live

```bash
curl -fsS https://signage.hamfield.eu/health/ready
```

`[TESTED]` — shipped in T013 but **not deployed**; today this returns 404.
Once deployed it checks database, Redis, storage and worker liveness, and grades
them: database or Redis down → `down`; storage or workers down → `degraded`;
otherwise `ok`. `/health` remains the liveness probe and is the one to point an
uptime monitor at — it deliberately does not touch dependencies.

### Dashboard checks

- Fleet online/offline counts (a screen is offline after
  `OFFLINE_THRESHOLD_SECONDS = 90`).
- Sync statuses — anything not `in_sync` for long is a problem.
- Active emergency overrides — these have **no auto-expiry**.
- Superadmin → Platform health panel and queue depth. `[TESTED]`, not deployed.

### Alerting

Once T013 is deployed, the worker evaluates alerts on `ALERT_CRON`
(default `*/5 * * * *`) and posts to ntfy: emergency override still active,
screen offline, screen cannot sync, media processing failed, processing queue
backed up, backups not running.

The backup-freshness check **fails closed** — if it cannot determine when the
last backup ran, it alerts. That is the intended behaviour: a dead-man's switch
that stays silent when broken is worse than useless.

`ALERT_NTFY_URL` and `ALERT_NTFY_TOKEN` are read by the **worker**, not the API.
They reach it through `worker.environment` in
`infra/docker/docker-compose.prod.yml`, interpolated from `.env.prod`. **Both
default to empty, which silently disables alerting** — nothing fails, nothing
logs, you simply have no monitoring. Verify explicitly after any deploy that
recreates the worker:

```bash
dc exec worker printenv ALERT_NTFY_URL   # must be non-empty
```

`[UNVERIFIED]` — T013 is not deployed yet.

---

## 12. Smoke test

Run after **every** deploy. Kept short so it actually gets run — the long
first-deploy version is [deployment.md §8a](deployment.md).

```
[ ] dc ps        — all running/healthy, migrate exited (0)
[ ] curl -fsSI https://signage.hamfield.eu/          -> 200, text/html
[ ] curl -fsS  https://signage.hamfield.eu/health    -> {"status":"ok",...}
[ ] migrate status                                   -> up to date (§7)
[ ] Log in to the dashboard over HTTPS
[ ] Upload one image AND one video -> both reach `ready`
      (the single test that proves S3 creds + worker + ffmpeg + Redis together)
[ ] All 4 paired screens show online and `in_sync`
[ ] dc logs api | grep -i "device websocket"  -> upgrades succeeding
[ ] No unexpected errors in `logs api` / `logs worker`
```

`[PROD-PARTS]` — every line here is a check that has been performed against
production and passed, but **not as a post-deploy checklist run in one sitting**.
The upload check in particular was verified as a property of the running system,
not as a deploy gate.

Add once T013 is deployed: `curl -fsS .../health/ready` → `{"status":"ok"}`.

---

## 13. Adding a new device

1. **Dashboard → Screens → create.** Set name, timezone, orientation, rotation
   and `playbackProfile`. `standard` (1080p30) is the default and the safe
   choice — `packages/shared/src/constants.ts`.
2. **Note the pairing code.** It is **8 characters**
   (`PAIRING_CODE_LENGTH = 8`), single-use, and **expires after 15 minutes**
   (`PAIRING_CODE_TTL_MINUTES`, `apps/api/src/env.ts`). If it expires,
   regenerate it in the dashboard — do not try to reuse it.
3. **Install on the device** — see §14 and
   [device-install.md](device-install.md):
   ```bash
   sudo ./infra/device/install.sh --server https://signage.hamfield.eu \
     --pairing-code <CODE>
   ```
   Other flags: `--no-player` (agent only), `--bundle <file>`.
4. **Verify.** The screen appears online within ~90 s
   (`OFFLINE_THRESHOLD_SECONDS`), and `syncStatus` reaches `in_sync`.
   On the device: `signage status`, `signage health`, `signage logs -f`.
5. **Assign** a default playlist and/or schedules.
6. **Send `identify`** to confirm you are looking at the physical screen you
   think you are. Do this before you trust any later troubleshooting.

Device CLI: `status`, `logs`, `player-logs`, `restart`, `restart-player`,
`pair`, `config`, `health`, `screenshot`, `version`.

### Re-pairing an existing device

1. Dashboard → revoke the device token.
2. Regenerate a pairing code.
3. On the device: `signage pair <CODE>`.

`[UNVERIFIED]` as a written sequence — the current fleet was paired before this
runbook. The 2026-09-09 rehearsal did confirm that `device_token` hashes survive
a restore intact, so **a restore does not require re-pairing**. `[LOCAL]`

---

## 14. Pairing a Chromebox (x86)

Short by design — **T016 owns the x86 profile.** Everything here is
`[UNVERIFIED]`: no Chromebox has been provisioned for this project.

- **Prerequisite: the unit must boot a standard Linux distribution.** An Acer
  Chromebox CXI3 generally needs firmware work first (write-protect removal and
  a firmware flash). **Verify this on the actual hardware before planning a
  rollout** — it is the step most likely to stop the project, and it is
  unverified for this model.
- **Installer reality.** `infra/device/install.sh` is Debian/apt-only and does a
  full `pnpm install` + build **on the device** (`build_release()`), so every
  screen needs a repo checkout and a toolchain. Prebuilt packages are report
  item B3 / part of T016.
- **Install:**
  ```bash
  sudo ./infra/device/install.sh --server https://signage.hamfield.eu \
    --pairing-code <CODE>
  ```
- **Expect software rendering, and high CPU during 1080p playback.**
  `infra/device/start-player.sh:73-75` maps only `*v3dv*` (Raspberry Pi) to an
  accelerated backend; **everything else, Intel included, falls through to
  `software`**, and no VA-API packages are installed. Overrides:
  `SIGNAGE_KIOSK_GPU` / `SIGNAGE_CHROMIUM_EXTRA_FLAGS` in
  `/etc/signage/agent.env`. Fixing this properly is T016.
- **Verify:** `signage status`, `signage health`, dashboard shows online +
  `in_sync`, content actually plays.

---

## 15. Common failure modes

Every row says what to **do**.

### Server-side

| Symptom | Likely cause | Action |
|---|---|---|
| `migrate` exits 1 with `P1000` | `POSTGRES_PASSWORD` ≠ the password inside `DATABASE_URL`. The password is baked into `postgres-data` at first creation and never updated by changing the env var | Fix the URL to match the **original** password. **Do not `down -v`** — that deletes the database |
| API exits immediately on start | `JWT_SECRET` still the dev placeholder under `NODE_ENV=production` (guard at `apps/api/src/env.ts:52`) | Set a real secret in `.env.prod` |
| API exits on start after an upgrade | A newly required env var is missing; the zod schema rejects it | Diff your config against the updated templates (§6 step 7); read `logs api` — zod names the variable |
| **502 across the whole site after a deploy** | Bind-mounted `Caddyfile` changed but Caddy was not restarted; `up -d` does not re-read it | `dc restart caddy` `[PROD]` |
| **502 on `/api/…` only, dashboard loads** | Old `web` image pinned the `api` container IP at nginx startup; the IP changed | `restart web` now; rebuild `web` from current `infra/docker/web-nginx.conf` to fix permanently `[PROD]` |
| Caddy cannot get a certificate | DNS not pointing here, 80/443 blocked, or Cloudflare orange-cloud | `dig`, check the firewall, set the record to DNS-only. **Stop retrying** — you are burning rate limit |
| Devices reach HTTPS but not WSS | Proxy not forwarding the upgrade | The bundled nginx + Caddyfile do forward it; a Cloudflare proxy may not |
| Thumbnails broken in the dashboard | `S3_PUBLIC_ENDPOINT` wrong, bucket CORS, or `S3_FORCE_PATH_STYLE` wrong for the provider | Check all three. R2 wants `true` |
| Media stuck at `pending` | Worker down, Redis down, or ffmpeg missing | `logs worker`; re-enqueue with `reprocess-media` |
| Media `failed` | Read `processingError` on the asset | Fix the source, then reprocess |
| Disk filling on the server | Telemetry tables, images, build cache | `docker system df`; `docker image prune -f`. Retention (T013) fixes the telemetry share once deployed and taken out of dry-run |
| Emergency override left on | No auto-expiry in `routes/emergency.ts` | Dashboard → Emergency → stop. T013 adds an alert after `ALERT_EMERGENCY_HOURS` (default 4) |

### Device-side

The four known issues from the review. Each has a workaround **and** the task
that fixes it properly — do not mistake the workaround for a fix.

| Symptom | Cause | Workaround | Real fix |
|---|---|---|---|
| Device online but content stale | Sync failing | `signage logs -f`; dashboard sync status; send `refresh_content` | — |
| **Screen frozen on one video** (F1) | Videos get `durationSeconds: null`, so no timer is armed and `onended` is the only exit. A stalled video never advances | `restart_player` command | **T015** |
| **Device disk full → sync fails forever** (F6) | No free-space precheck; sync aborts and never converges | Free space, or reduce the playlist | **T017** |
| **Cached file corrupt → item errors forever** (F5) | The cache is never re-validated against what is on disk | `clear_cache` command | **T017** |
| **Command shows `sent` forever** (F9) | The device is offline; commands expire after 10 min but are never marked `expired` | Re-issue once the device is back online | — |
| Screen shows "not paired" | Wrong or expired code | `signage logs -f`, then `signage pair <new code>` | — |
| Black screen / no X | X permissions | `signage player-logs`; confirm `/etc/X11/Xwrapper.config` has `allowed_users=anybody` | — |
| Media won't download | Server unreachable from the device | `curl -fsS $SIGNAGE_SERVER_URL/health`. Note `/healthz` is the device's **own** player server, not the server's | — |

---

## 16. Decision rules and ownership

### Ownership

This is a **single-operator deployment.** The project owner holds every
credential, is the only escalation path, and is the only person who can decrypt
a backup. There is no rota and no second on-call; writing a contact table would
be inventing an organisation that does not exist.

The consequences are worth stating plainly, because they are the real
operational risk:

- **The `age` private key exists only on the owner's workstation and password
  manager.** If both are lost, every backup ever taken becomes permanently
  unreadable. Confirm the password-manager copy exists; it is the single point
  of failure in the whole recovery story.
- Nobody else can currently perform a recovery. That is the strongest argument
  for running the drill in §8.

### Who may run what

| Action | Rule |
|---|---|
| Deploy / rollback | Owner |
| Retention job **non-dry-run** (`RETENTION_DRY_RUN=false`) | **Owner only, and only with a verified backup from the same day.** It issues batched `DELETE`s against telemetry tables. Leave it in dry-run until the deleted counts in the logs have been read and look right |
| `restore.sh` | **Owner only. Destructive, and never executed end to end** (§8) |
| Rotating the superadmin password | Owner |

### When to roll back vs. wait

- **No migration ran, and the site is down** → roll back immediately. It costs
  minutes and nothing is at risk.
- **No migration ran, and the site is degraded but serving** → you can afford to
  diagnose. Screens keep playing from cache, so the customer-visible clock is
  slower than it feels.
- **A migration ran** → do not improvise, and do not "just try" a checkout of
  the previous SHA. Decide between repair-in-place and restore-from-backup
  before touching anything.

### When to restore vs. repair in place

- **Repair in place** when the schema is intact and the fault is config, code or
  a stuck queue. Nearly every incident is this.
- **Restore from backup** when the *data* is wrong or the schema is
  half-migrated — specifically after a failed `ALTER TYPE` (§7), an accidental
  `down -v`, or any destructive migration that shipped with broken code.
- **Never `docker compose down -v` on production.** It deletes `postgres-data`.
  There is no undo, and your recovery becomes the untested restore path.

### A note on this document

- It must be readable **when the server is down.** A copy on the VPS is useless
  during exactly the incident it exists for. It lives in git; keep a clone
  off-box, and keep an exported copy alongside the backups.
- `git checkout <sha>` yields the runbook that matches that release — which is
  why the deployed SHA in §1 must be kept current.
- **Re-verify after every task that changes operations.** T016 will change §14;
  deploying T012/T013 will turn several `[TESTED]` tags into `[PROD]`.
