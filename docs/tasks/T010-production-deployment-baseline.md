# T010 — Production deployment baseline (VPS + Docker Compose)

| | |
|---|---|
| **Estimate** | M |
| **Risk** | Medium — touches deployment config only, but a mistake here means an exposed database or an unrecoverable server |
| **Depends on** | Nothing. **This is the first task.** |
| **Blocks** | T011, T012, T013, T014 |
| **Status** | **Repo changes complete** — VPS deploy + smoke test still pending (see "Outcome" at the end) |

> Self-contained by design: a fresh Claude Code session has no memory of the review
> that produced this file, so the context below restates what matters. Same
> convention as `docs/todo-encoding-settings.md`.

---

## Objective

Make Hamfield Signage deployable on a single Hetzner (or equivalent) VPS with
Docker Compose, in a shape that is **safely upgradeable**: database state, media,
configuration and secrets survive every future `docker compose up -d --build`.
No rebuild-from-scratch, ever.

The end state is: a documented, repeatable first deploy that produces a working
HTTPS dashboard, a reachable device API, persistent storage, and a bootstrapped
superadmin — with only ports 80 and 443 exposed to the internet.

---

## Context from the review report

The repo already ships most of this as **templates**, not as a working deployment:

- `docker-compose.example.yml` — full stack (postgres, redis, minio, minio-setup,
  migrate, api, worker, web, optional mock-device). Publishes host ports for
  postgres (5432), redis (6379), minio (9000/9001), api (4000) and web (5173).
- `infra/docker/docker-compose.prod.example.yml` — production override that uses
  `!reset []` to remove those host ports, adds `restart: unless-stopped`, sets
  `NODE_ENV=production`, points S3 at Cloudflare R2, and adds a `caddy` service.
- `infra/docker/Caddyfile.example` — single-domain TLS terminator proxying to `web`.
- `infra/docker/web-nginx.conf` — nginx serving the SPA and proxying `/api/`
  (including the WebSocket upgrade) to `api:4000`.
- `.gitignore` already excludes the three real files: `/docker-compose.yml`,
  `/infra/docker/docker-compose.prod.yml`, `/infra/docker/Caddyfile`.
- `docs/deployment.md` (398 lines) documents the intended flow in detail.

**Gaps the review found that this task must close:**

1. **No named volumes in the prod override.** The base file defines
   `postgres-data`, `redis-data`, `minio-data`, and the override adds
   `caddy-data`/`caddy-config`. This is correct *as long as* the operator never
   runs `docker compose down -v`. That footgun is currently only a docs warning.
   → Needs an explicit volume/persistence section and a "never run `down -v`"
   guard in the runbook (T014).
2. **No healthchecks on `api`, `worker` or `web`.** Only postgres/redis/minio have
   them (`docker-compose.example.yml`). Without them, `restart: unless-stopped`
   restarts a *crashed* container but never an *unhealthy* one.
   → Full deep-health work is **T013**; this task adds the basic wiring hooks.
3. **`/health` is not proxied.** `apps/api/src/server.ts:104` registers `/health`
   outside the `/api/v1` prefix, and `web-nginx.conf` only proxies `location /api/`.
   So `https://<domain>/health` 404s and returns the SPA. `docs/device-install.md:145`
   tells operators to `curl $SIGNAGE_SERVER_URL/healthz`, which is the *agent's*
   route and has never worked against the server. Both are documentation bugs
   that mislead during a first deploy.
4. **Containers run as root.** No `USER` directive in any of the four Dockerfiles.
   Runtime images also `COPY --from=build /app /app`, shipping source and
   devDependencies. → Hardening is **T012**; note it here so T010 doesn't
   entrench the pattern.
5. **`JWT_SECRET` guard exists and is good:** `apps/api/src/env.ts:52` throws on
   startup if `NODE_ENV=production` and the secret still starts with
   `dev-only-secret`. Keep and verify this in the smoke test.
6. **Superadmin bootstrap works and is idempotent:** `apps/api/src/lib/superadmin.ts`
   `bootstrapSuperadmin` creates the account only if no superadmin exists, never
   overwrites, never logs the password, and promotes an existing user with the
   same email rather than failing the install. Called from `apps/api/src/main.ts:12`.
   CLI fallbacks: `apps/api/src/cli/create-superadmin.ts` and
   `reset-superadmin-password.ts`.

---

## Files likely involved

**Create (real, git-ignored, on the server):**
- `docker-compose.yml` — from `docker-compose.example.yml`
- `infra/docker/docker-compose.prod.yml` — from `infra/docker/docker-compose.prod.example.yml`
- `infra/docker/Caddyfile` — from `infra/docker/Caddyfile.example`
- `.env.prod` (or equivalent) — see "Production env handling" below

**Edit (committed templates):**
- `docker-compose.example.yml` — add healthcheck stanzas for api/worker/web (hooks only; T013 fills in the deep check)
- `infra/docker/docker-compose.prod.example.yml` — explicit volume documentation, `env_file` wiring, log rotation defaults
- `infra/docker/web-nginx.conf` — expose `/health` through the proxy (see plan step 6)
- `docs/deployment.md` — correct the `/healthz` → `/health` error, add the volume-safety and rollback sections
- `docs/device-install.md:145` — fix the `curl $SIGNAGE_SERVER_URL/healthz` line

**Read-only reference (do not change in this task):**
- `apps/api/src/server.ts` (`/health`, CORS, rate limit, multipart registration)
- `apps/api/src/env.ts` (env schema + production JWT guard)
- `apps/api/src/lib/superadmin.ts`, `apps/api/src/cli/*`
- `infra/docker/{api,worker,web}.Dockerfile`

---

## Non-goals

- Kubernetes, Nomad, Terraform, Ansible, or any IaC.
- Multi-server, multi-region, or horizontally scaled API replicas.
- CI/CD pipelines and image registries (a later task can add these; the first
  deploy builds on the box).
- Blue/green or zero-downtime deploys. A ~30 s restart window is acceptable.
- Non-root containers and security headers — **T012**.
- Deep health checks, retention jobs, alerting — **T013**.
- Backup and restore — **T011** (this task must not claim the server is safe).

---

## Implementation plan

### 1. Decide the storage model up front

Two supported shapes. Pick one and document it in the runbook:

- **A — External object storage (recommended).** Cloudflare R2 or equivalent.
  Delete `minio` and `minio-setup` from `docker-compose.yml`, remove them from
  the `depends_on` of `api` and `worker`, and set the `S3_*` values to the
  provider. Media durability becomes the provider's problem; backups then only
  need Postgres + config (see T011).
  The code already supports this: `apps/api/src/lib/s3.ts` maintains a separate
  `getPublicS3()` client for `S3_PUBLIC_ENDPOINT` so presigned URLs handed to
  browsers/devices point at a publicly reachable host.
- **B — Self-hosted MinIO.** Keep both services, but **remove the `9000`/`9001`
  host port mappings** and never expose the MinIO console publicly. The
  `minio-data` volume then becomes backup-critical (T011).

### 2. Create the three real config files from templates

```
cp docker-compose.example.yml docker-compose.yml
cp infra/docker/docker-compose.prod.example.yml infra/docker/docker-compose.prod.yml
cp infra/docker/Caddyfile.example infra/docker/Caddyfile
chmod 600 docker-compose.yml infra/docker/docker-compose.prod.yml
```

Replace every `# ❗CHANGE` marker. The two YAML anchors (`x-database-url`,
`x-r2-credentials`) exist specifically so credentials cannot drift between
`migrate`, `api` and `worker` — keep using them.

### 3. Production env handling

The prod override currently inlines secrets directly in YAML. Improve this:

- Move secrets to a single `env_file` (e.g. `/opt/hamfield-signage/.env.prod`,
  `chmod 600`, owned by root) referenced by the `api`, `worker` and `migrate`
  services. Keep the `x-database-url` anchor for the one value that must be
  byte-identical across three services.
- Required in production: `JWT_SECRET` (`openssl rand -hex 32`),
  `POSTGRES_PASSWORD` + matching `DATABASE_URL`, `API_PUBLIC_URL` (https),
  `CORS_ORIGINS` (the dashboard origin only), `S3_*`, `S3_PUBLIC_ENDPOINT`,
  `NODE_ENV=production`, `INITIAL_SUPERADMIN_*`.
- Document that `apps/api/src/env.ts` **hard-fails startup** if `JWT_SECRET` is
  left at the dev placeholder under `NODE_ENV=production`. That is a feature.
- Add `.env.prod` (and any `*.env` variant chosen) to `.gitignore`.

### 4. Persistence — the "never rebuild from scratch" requirement

Named Docker volumes, all defined in `docker-compose.yml`:

| Volume | Holds | Backup-critical? |
|---|---|---|
| `postgres-data` | all metadata: orgs, users, devices, playlists, schedules, media rows, audit log | **Yes — irreplaceable** |
| `redis-data` | BullMQ queue state, pub/sub | No — rebuildable; in-flight jobs are lost, media can be re-processed |
| `minio-data` | media objects (**model B only**) | **Yes, if using MinIO** |
| `caddy-data` / `caddy-config` | TLS certificates + ACME account | No — re-issues automatically, but restoring avoids Let's Encrypt rate limits |

Rules to write into the runbook (T014) and enforce by habit:

- **Never run `docker compose down -v`.** That single flag destroys the database.
- `docker compose up -d --build` is safe and is the normal upgrade path.
- The Postgres password is baked into `postgres-data` on first creation. Changing
  `POSTGRES_PASSWORD` later without also changing `DATABASE_URL` produces the
  `P1000` failure already documented in `docs/deployment.md:§13`.

Also pin log rotation so container logs cannot fill the disk:

```yaml
logging:
  driver: json-file
  options: { max-size: "10m", max-file: "5" }
```

Apply to `api`, `worker`, `web`, `caddy`.

### 5. Network exposure — only 80/443

- `caddy` is the **only** service with a `ports:` mapping (`80:80`, `443:443`).
- The prod override already uses `!reset []` on postgres, redis, api and web.
  Verify that Compose is ≥ v2.24.4 (`!reset` requirement) or, on older versions,
  physically delete the `ports:` blocks from `docker-compose.yml`.
- If using MinIO (model B), add `ports: !reset []` for it too — the override
  does **not** currently do this, because it assumes R2. **This is a real gap:
  a model-B operator who follows the override as-is leaves the MinIO console on
  `:9001` open to the internet.**
- Remove the `mock-device` profile from the production compose file entirely.
- Firewall rules are specified in **T012** and applied per **T014**.

### 6. Make `/health` reachable through the proxy

`apps/api/src/server.ts:104` serves `/health` outside `/api/v1`, and nginx only
proxies `location /api/`, so it is currently unreachable from outside. Pick one:

- **Preferred:** add a dedicated `location = /health { proxy_pass http://api:4000/health; }`
  to `infra/docker/web-nginx.conf`, and decide deliberately whether Caddy should
  expose it publicly or restrict it to the Docker network.
- Alternative: leave it internal and document `docker compose exec api node -e ...`
  as the only check (what `docs/deployment.md:§8` does today).

Either way, **fix `docs/device-install.md:145`**, which currently instructs
operators to `curl $SIGNAGE_SERVER_URL/healthz` — wrong path *and* wrong service
(`/healthz` is the device agent's local player server, `apps/agent/src/player-server.ts`).

### 7. Migrations

The `migrate` service already does the right thing: a one-shot container built
from `api.Dockerfile` running `prisma migrate deploy`, with `api` and `worker`
gated behind `service_completed_successfully`.

- Confirm it stays in the prod override and that its `DATABASE_URL` comes from
  the shared anchor.
- Document the manual form for a controlled release:
  `docker compose run --rm migrate`.
- The full pre-upgrade backup → migrate → verify → rollback procedure is **T011**.

### 8. Superadmin bootstrap

- Set `INITIAL_SUPERADMIN_EMAIL` / `_PASSWORD` (≥ 12 chars) / `_NAME` before the
  first `up`. `bootstrapSuperadmin` runs on API start, is idempotent, and never
  logs the password.
- Verify the log line `superadmin bootstrap: account created` on first boot.
- Fallback if the vars were empty at first start:
  `docker compose exec api node apps/api/dist/cli/create-superadmin.js <email> '<password>' '<name>'`
- **Change the password after first login** and record the rotation in the runbook.

### 9. Smoke test checklist (must pass before declaring the deploy done)

1. `docker compose ps` — every service `running`; `migrate` shows `exited (0)`.
2. `curl -fsSI https://<domain>/` → 200, `content-type: text/html`.
3. API health reachable (per step 6) and returning `{"status":"ok",...}`.
4. `docker compose exec api node packages/database/node_modules/prisma/build/index.js migrate status --schema packages/database/prisma/schema.prisma` → up to date.
5. `docker compose logs api | grep -i superadmin` → bootstrap succeeded.
6. Log in to the dashboard over HTTPS with the superadmin account.
7. Create an org, upload one image and one video → both reach `ready`
   (proves S3 credentials, the worker, ffmpeg and the queue all work).
8. Create a playlist, create a screen, note the pairing code.
9. Pair the mock device against the **production** URL and confirm it appears
   online and reaches `syncStatus: in_sync`.
10. Confirm the device WebSocket upgrades (dashboard shows the device online
    within ~90 s, not only after a 30 s poll). Check `docker compose logs api`
    for `device websocket connected`.
11. **Port audit from off-box:** `nmap -Pn <server-ip>` shows only 22/80/443.
    Explicitly confirm 5432, 6379, 9000, 9001, 4000 and 5173 are all closed.
12. `docker compose restart` → everything comes back, no data loss.
13. Reboot the VPS → stack auto-starts (`restart: unless-stopped`).

### 10. Rollback considerations for this task

- The stack is config-only at this stage, so rollback = restore the previous
  three config files and `docker compose up -d`.
- **Before the very first `up`, take a snapshot of the VPS** (Hetzner snapshots
  are cheap). That is the only rollback available until T011 lands.
- Record the deployed git SHA (`git rev-parse HEAD`) so a rollback target exists.
- Once a migration has run, config rollback is **not** sufficient — a schema
  change may be incompatible with the older image. Migration rollback is
  specified in T011 and must not be attempted ad hoc.

---

## Acceptance criteria

- [ ] A fresh Hetzner VPS goes from bare Debian/Ubuntu to a working HTTPS
      dashboard by following `docs/deployment.md` alone, with no undocumented steps.
- [ ] Only ports 22, 80 and 443 are reachable from the internet, verified by an
      external port scan.
- [ ] Postgres, Redis, MinIO (if used), the API port and the Vite dev server are
      all unreachable from outside the Docker network.
- [ ] `docker compose up -d --build` twice in a row is idempotent and preserves
      all data.
- [ ] A VPS reboot brings the whole stack back with no manual intervention.
- [ ] `JWT_SECRET`, DB password and S3 credentials exist only in git-ignored,
      `chmod 600` files.
- [ ] Superadmin login works and the bootstrap password has been rotated.
- [ ] Media upload → transcode → `ready` → device download works end to end
      against production storage.
- [ ] All 13 smoke-test items pass and the results are recorded.
- [ ] Container logs are size-capped and cannot fill the disk.
- [ ] `docs/deployment.md` and `docs/device-install.md` contain no incorrect
      health-check URLs.

---

## Testing checklist

- [ ] Deploy to a **throwaway** VPS first, not the intended production host.
- [ ] External `nmap` port scan.
- [ ] TLS: certificate issues, auto-renews, `curl -fsSI` clean, no mixed content.
- [ ] WebSocket upgrade survives the Caddy → nginx → api chain (this is the
      classic reverse-proxy failure; `docs/deployment.md:§13` documents the
      Cloudflare orange-cloud variant).
- [ ] Upload a >100 MB video to exercise `client_max_body_size 2g` (nginx),
      Caddy's `max_size 2GB`, and `MAX_UPLOAD_SIZE_BYTES`.
- [ ] Kill each container individually (`docker kill`) and confirm it restarts.
- [ ] `docker compose down` (**without** `-v`) then `up -d` → all data intact.
- [ ] Confirm `docker volume ls` shows the expected named volumes and that none
      are anonymous.
- [ ] Verify the production JWT guard: temporarily set the dev placeholder and
      confirm the API refuses to start.

---

## Rollback / safety notes

- **`docker compose down -v` destroys the database.** Never type it on the
  production host. Consider a shell alias that refuses the `-v` flag.
- Take a Hetzner snapshot before the first deploy and before every subsequent
  upgrade until T011's scripted backup exists.
- Do not point production DNS at the server until the smoke test passes on the
  IP or a staging hostname — Let's Encrypt has issuance rate limits and repeated
  failed attempts will lock you out for a week.
- Keep the three git-ignored config files backed up off-box **from day one**
  (formalised in T011). Losing `docker-compose.prod.yml` means losing the DB
  password, which means losing the database.

---

## Outcome (repo half)

Everything in this task that lives in the repository is done and verified; the
half that needs an actual server is not, and cannot be from a workstation.

### Landed

- **`.env.prod.example` (new).** One documented file holding every production
  secret and host-specific value. Copied to `.env.prod` (git-ignored, `chmod 600`)
  and passed with `--env-file`.
- **`infra/docker/docker-compose.prod.example.yml` — no credentials left in
  YAML.** Every value is now `${VAR:?message}`, read from `.env.prod`.
  - *Deviation from plan step 3:* the plan said `env_file:`. That would have been
    silently broken — a service's `environment:` map always wins over `env_file:`,
    and the base `docker-compose.yml` sets `S3_*`, `DATABASE_URL`, `JWT_SECRET`
    under `environment:`. An `env_file:` in the override would have been ignored
    for exactly those keys, so a production deploy would have quietly used
    `S3_ENDPOINT: http://minio:9000`. Interpolated `environment:` entries in the
    override *do* win over the base file. Verified with `docker compose config`.
  - *Filename:* `.env.prod`, not `.env`. `.env` is already the local-dev env file
    (`.env.example`), and Compose auto-loads it — a stray dev copy on the server
    would have leaked localhost URLs into production. `--env-file .env.prod`
    replaces the default `.env` entirely. Verified by planting a hostile `.env`
    and confirming none of it reached the resolved config.
  - The `POSTGRES_PASSWORD` / `DATABASE_URL` drift footgun is gone: both derive
    from one variable, so a mismatch is now structurally impossible.
  - `logging: json-file` (10 MB × 5) on every long-running service, in **both**
    compose files — YAML anchors do not cross files.
  - Commented `minio: ports: !reset []` block for storage model B. This was the
    real gap flagged in plan step 5: a model-B operator following the old
    override left the MinIO console on `:9001` open to the internet.
  - `migrate` now also gets `NODE_ENV=production`.
- **`docker-compose.example.yml`** — `x-logging` anchor; `healthcheck` on `api`
  (dependency-free `node -e fetch(/health)`) and `web` (busybox `wget`); log
  rotation on api/worker/web; a documented persistence block on `volumes:` with
  the `down -v` warning.
  - No healthcheck on `worker`: it is a BullMQ consumer with **no HTTP listener**,
    so there is nothing to probe. A comment says so and points at T013. Adding a
    liveness endpoint is application work.
  - `mock-device` was **kept** — it is profile-gated and this file doubles as the
    dev compose file. Deleting it is a documented production step (§5b) instead.
- **`infra/docker/web-nginx.conf`** — `location = /health` proxied to
  `api:4000/health`. **Exact** match, deliberately: T013 adds `/health/ready`,
  which reports per-dependency detail and must not become public by accident.
  Config validated with `nginx -t`.
- **`.gitignore`** — `/.env.prod`.
- **`docs/deployment.md`** — largely rewritten around the new config model:
  §0 (four files, secrets in one place, the `.env` vs `.env.prod` trap), §5a–5e,
  §8 health check now `curl https://<domain>/health` through the proxy, new §8a
  18-item first-deploy smoke test, §9a rollback (and why a rollback after a
  migration is a restore, not a checkout), new **§10 Persistence & data safety**
  (volume table, the `down -v` rule, log caps, how to actually rotate the DB
  password), and §11–§14 renumbered with corrected troubleshooting rows.
  - §7 now defines `dc` as a shell **function** that refuses `-v`, replacing the
    old `alias dc=…`. This matters: bash expands aliases *before* function
    lookup, so keeping both would have left the alias shadowing the guard and the
    guard doing nothing. The doc says so explicitly and gives `type dc` as the
    check.
  - §6 (where a model-B operator actually lands) now repeats the
    "uncomment the `minio:` block" warning, not just §5c.
  - The smoke test's upload item is split in two: one large upload to prove the
    body survives the proxy chain, and one *over* `MAX_UPLOAD_SIZE_BYTES` to
    confirm the API rejects it rather than a proxy. The three limits must be
    ordered `MAX_UPLOAD_SIZE_BYTES` ≤ nginx `client_max_body_size` ≤ Caddy
    `max_size`, or the API's error never reaches the user. (They currently are:
    1 GiB ≤ 2g ≤ 2GB.)
- **`docs/device-install.md:145`** — `curl $SIGNAGE_SERVER_URL/healthz` →
  `curl -fsS $SIGNAGE_SERVER_URL/health`, with a note that `/healthz` is the
  device's *own* player server. `infra/device/signage:48,101` were left alone —
  those call `127.0.0.1:<player_port>/healthz` and are correct.

### Added after review: §15, migrating a live deployment

The task assumed a greenfield first deploy; the actual server is already running
on the old model (secrets inline in `docker-compose.prod.yml`). `docs/deployment.md`
now has **§15**, a config-only migration: capture the running resolved config →
pull → build `.env.prod` from that capture → swap the real files → **diff the
resolved config as a gate** → apply → rollback by restoring three files.

The procedure was **rehearsed** locally: an old-model deployment was reconstructed
from `HEAD` with realistic inline secrets, migrated per the doc, and both resolved
configs diffed. Every credential carried over byte-identically; the only
differences were the intended ones, and §15.5 lists exactly that diff.

§15.2 deliberately does **not** `git pull`. A pull would advance the server to
`origin/master` and bring every application commit with it, and
`prisma migrate deploy` would then apply `20260624000000_per_device_encoding_tiers`
(landed in `44cb453`, two commits before T010) on any server deployed before
2026-06-24 — at which point the migration is no longer config-only and the cheap
rollback is false. Instead it does a scoped `git checkout origin/master -- <paths>`
for the templates, `web-nginx.conf` and the docs, leaving `HEAD` untouched.
Upgrading the application is a separate release, and it needs T011 first.

Three hazards found while writing it, the first two verified against real
containers:

- **An unquoted `$` in an env-file value is silently eaten.**
  `POSTGRES_PASSWORD=abc$def` reaches the container as `abc` — confirmed by
  running it. For a password carried over from an existing deployment this is
  silent corruption that surfaces as `P1000`. The fix is single quotes (which
  disable interpolation entirely; double quotes do not). Documented in §5a, §15.3
  and `.env.prod.example`.
- **`JWT_SECRET` rotation does not un-pair devices.** `.env.prod.example`
  originally claimed it did. Device tokens are random values stored as SHA-256
  hashes (`apps/api/src/lib/tokens.ts:23,28`, `DeviceToken.tokenHash`), not JWTs —
  only dashboard sessions are invalidated. Corrected.

Also worth stating plainly, since it is easy to assume otherwise: a `git pull` on
a running server delivers **only** `infra/docker/web-nginx.conf` (committed, baked
into the `web` image). Everything else in this task lives in git-ignored real
files and reaches the box only through §15. §9 now says so.

### Correction to this task file

Gap #2 above says healthchecks matter because `restart: unless-stopped` "never
restarts an *unhealthy* container". Plain Docker/Compose does not restart on
unhealthy either — health status only drives `depends_on: condition:
service_healthy` at startup, and restart-on-unhealthy in Swarm mode. What the new
healthchecks buy is `docker compose ps` visibility and startup gating. Acting on
an unhealthy container needs an external supervisor; that belongs to T013/T014.
The docs are written that way.

### Verified

- `docker compose --env-file .env.prod -f docker-compose.yml -f infra/docker/docker-compose.prod.yml config`
  resolves cleanly; `api`/`worker`/`migrate` all carry production values, and
  `caddy` is the only service publishing host ports (`minio` still does in the
  base file, which is why §5b tells the operator to delete it).
- A missing secret fails at `config` time, naming the variable.
- A planted local-dev `.env` does not reach the resolved config.
- `nginx -t` passes on the new `web-nginx.conf`.
- `prettier --check` clean on both edited docs.

### Not done — needs the server

None of this can be closed from a workstation. Carry it into the first deploy:

- The whole of §8a (18 items), in particular the external `nmap` port audit, the
  TLS issuance, the >100 MB upload, the WebSocket upgrade through
  Caddy → nginx → api, the reboot test, and `up -d --build` twice being
  idempotent.
- The acceptance criteria in this file remain **unticked** for that reason.
- Deploy to a throwaway VPS first, and take a snapshot before the first `up` —
  that is still the only rollback that exists until T011 lands.
