# T013 — Healthchecks, logging, retention and alerting

| | |
|---|---|
| **Estimate** | M |
| **Risk** | Medium — the retention job **deletes production data**; a wrong predicate is destructive and irreversible |
| **Depends on** | T010 (deployment), T011 (a verified backup must exist before anything deletes rows) |
| **Blocks** | Operating a fleet larger than a handful of devices |
| **Status** | Not started |

> Self-contained by design: a fresh Claude Code session has no memory of the
> review that produced this file.

---

## Objective

Make the production server **observable** (you can tell whether it is healthy,
and be told when it is not) and **bounded** (it cannot grow until the disk fills).

---

## Context from the review report

### The retention job does not exist *(F4 / A6 — High, CONFIRMED)*

`docs/architecture.md:229` states device telemetry tables are "append-only **and
pruned**". Three code comments defer cleanup to "the retention job":

- `apps/api/src/routes/device-api.ts:259` — screenshot object cleanup
- `apps/api/src/routes/media.ts:390` — soft-deleted media object purge
- `apps/worker/src/processor.ts:112` — superseded/legacy `MediaVariant` objects

**Grep confirms no such job exists anywhere in the repo.** Nothing prunes
anything. Growth rates:

| Table | Rate | Source |
|---|---|---|
| `device_heartbeats` | **2,880 rows/device/day** — one full JSON payload every 30 s | `apps/agent/src/main.ts:14` `HEARTBEAT_INTERVAL_MS = 30_000` → `applyHeartbeat` (`apps/api/src/lib/heartbeat.ts`) writes a `DeviceHeartbeat` row inside a transaction with every device update |
| `playback_events` | ~**8,640 rows/device/day** for a 10 s image playlist (a `start` and an `end` per item) | `apps/player/src/main.ts` `sendEvent` → agent buffer → `POST /device/playback-events` |
| `device_logs` | variable; spikes hard during a player error loop | `apps/agent/src/db.ts` `bufferLog` (device side is capped at 5,000 rows; **the server side is not capped at all**) |
| `device_screenshots` | rows trimmed to the newest 5 per device (`device-api.ts:253`), **but the S3 objects are never deleted** | `SCREENSHOTS_KEPT = 5` |
| Orphaned S3 objects | soft-deleted media, superseded variants, replaced org logos | `media.ts:390`, `processor.ts:112` |

At 100 devices that is roughly **1.1 M telemetry rows per day**, forever, plus
unbounded object storage.

### `/health` is shallow *(A11)*

`apps/api/src/server.ts:104`:
```ts
app.get('/health', async () => ({ status: 'ok', time: new Date().toISOString() }));
```
It returns 200 while Postgres, Redis and S3 are all down. It is also not proxied
(see T010 step 6), so it is unreachable from outside.

### No container healthchecks *(A11)*

`docker-compose.example.yml` defines healthchecks for `postgres`, `redis` and
`minio` only. `api`, `worker` and `web` have none, so `restart: unless-stopped`
restarts a *crashed* container but never a *wedged* one.

### No metrics, no alerting *(Phase 4 "missing observability", B2)*

No Prometheus/OTel, no queue-depth gauge, no request histograms. `isOnline` is
computed at serialization time (`apps/api/src/lib/serializers.ts:162`, using
`OFFLINE_THRESHOLD_SECONDS = 90` from `packages/shared/src/constants.ts`) — so
the dashboard *shows* offline devices, but nothing ever *tells* anyone. A screen
can be dark for a week and nobody knows until a customer calls.

### Log rotation

Container logs are unbounded by default. T010 sets `json-file` with `max-size`
/ `max-file`; this task confirms it and covers the host side.

---

## Files likely involved

**Create:**
- `apps/worker/src/retention.ts` — the pruning logic (pure, testable functions +
  a runner)
- `apps/worker/src/retention.test.ts`
- `apps/worker/src/alerts.ts` — alert evaluation + dispatch
- `apps/api/src/lib/health.ts` — dependency checks

**Edit:**
- `apps/api/src/server.ts` — `/health` (keep shallow) + new `/health/ready` (deep)
- `apps/worker/src/main.ts` — register a BullMQ repeatable job for retention and alerts
- `apps/worker/src/env.ts` — retention windows, alert thresholds, webhook URL
- `apps/api/src/env.ts` — if the API also needs the alert config
- `.env.example` — document every new variable
- `docker-compose.example.yml` + `infra/docker/docker-compose.prod.example.yml` —
  healthchecks for api/worker/web, logging options
- `docs/deployment.md:§12` — operations notes
- `docs/architecture.md:229` — the line currently claims pruning exists; it will
  become true, but verify the wording matches what is actually implemented

**Read-only reference:**
- `packages/database/prisma/schema.prisma` — `DeviceHeartbeat`, `DeviceLog`,
  `PlaybackEvent`, `DeviceScreenshot`, `MediaAsset`, `MediaVariant`, `AuditLog`
- `apps/api/src/lib/s3.ts` — `deleteFromS3`
- `apps/api/src/lib/queues.ts` — BullMQ queue setup pattern to mirror

---

## Non-goals

- A full metrics stack (Prometheus + Grafana + exporters). A single-VPS
  deployment does not need it yet; a `/metrics` endpoint can come later.
- Log shipping to an external aggregator (Loki, ELK, Datadog).
- Distributed tracing.
- Paging/on-call rotation tooling. A webhook and an email are enough.
- A new admin UI area — reuse the existing dashboard pages
  (`apps/web/src/pages/Monitoring.tsx`, `DeviceDetail.tsx`).
- Pruning the `AuditLog`. It is a compliance artifact; keep it indefinitely, or
  archive rather than delete.

---

## Implementation plan

### 1. Deep health checks

Keep **two** endpoints, because they answer different questions:

- `GET /health` — **liveness**. Stays exactly as it is: cheap, no dependencies,
  always 200 if the process is up. This is what a container healthcheck and a
  load balancer should hit. Do not make it dependency-aware, or a brief Postgres
  blip will cause Docker to restart-loop the API and make an outage worse.
- `GET /health/ready` — **readiness/diagnostic**. Checks each dependency with a
  short timeout (~2 s) and returns a per-dependency breakdown:

```jsonc
{
  "status": "degraded",              // ok | degraded | down
  "checks": {
    "database": { "ok": true,  "latencyMs": 3 },
    "redis":    { "ok": true,  "latencyMs": 1 },
    "storage":  { "ok": false, "error": "timeout" }
  },
  "version": "<git sha>",
  "time": "..."
}
```

Implementation notes:
- database: `SELECT 1` via `prisma.$queryRaw`
- redis: `PING` via `getRedisPub()` (`apps/api/src/lib/redis.ts`)
- storage: a `HeadBucket` (cheap) rather than listing objects
- Return **200 when ok, 503 when down**, so it is scriptable.
- **Do not require auth** but **do not leak internals** — no connection strings,
  no credentials, no stack traces in the error field.
- Rate-limit it, and consider exposing it only on the internal network (decide
  together with T010 step 6).

Worker liveness: the worker has no HTTP server. Either add a tiny one, or have
it write a heartbeat key to Redis (`signage:worker:<id>:alive`, short TTL) that
`/health/ready` reports on. The Redis-key approach avoids adding a listener.

### 2. Container healthchecks

Add to `docker-compose.example.yml` (inherited by the prod override):

- `api` — `CMD-SHELL` curl/node fetch against `http://localhost:4000/health`,
  `interval: 30s`, `timeout: 5s`, `retries: 3`, `start_period: 30s`.
  Note the slim image has no `curl`; use `node -e "fetch(...)"` as
  `docs/deployment.md:§8` already does.
- `worker` — check the Redis liveness key, or a `pgrep`-style process check.
  Keep it simple; a false-negative that restarts a mid-transcode worker is worse
  than no check (BullMQ will retry the job, but it wastes CPU).
- `web` — nginx `/` returns 200.

Then in the prod override use `depends_on: { condition: service_healthy }` where
it genuinely helps, and confirm restart behaviour.

### 3. The retention job

**This job deletes production data. Build it defensively.**

Add a BullMQ repeatable job in `apps/worker/src/main.ts` (mirroring the existing
queue pattern in `apps/api/src/lib/queues.ts`), running daily at a quiet hour.

Configurable windows (`apps/worker/src/env.ts`, documented in `.env.example`):

| Data | Default | Predicate | Notes |
|---|---|---|---|
| `device_heartbeats` | 14 days | `createdAt < now - N` | Highest-volume table. Consider keeping one row/hour beyond the window if history matters — decide explicitly. |
| `playback_events` | 90 days | `occurredAt < now - N` | **Careful:** these back the proof-of-play and play-count features (`apps/api/src/routes/media.ts` `playStatsFor`, `playback-stats`). Deleting them silently changes reported play counts. Either keep 90 days, or aggregate into a rollup table before deleting. Default to a *long* window and make it configurable. |
| `device_logs` | 30 days | `loggedAt < now - N` | |
| `device_screenshots` | rows already capped at 5/device | delete the **S3 objects** for rows already removed | Requires tracking orphans — see below |
| Soft-deleted `media_assets` | 30 days after `deletedAt` | purge `originalStorageKey`, `processedStorageKey`, `thumbnailStorageKey` + variant objects, then optionally hard-delete the row | **Highest-risk operation in this task.** |
| Orphaned `MediaVariant` objects | immediate | rows deleted by `processor.ts:112` leave objects behind | |
| Replaced org logos | already best-effort deleted inline (`routes/orgs.ts`) | sweep any misses | |

**Mandatory safety properties:**

1. **Dry-run mode by default.** `RETENTION_DRY_RUN=true` initially: log exactly
   what *would* be deleted, counts and sample ids, delete nothing. Run in
   dry-run for at least a week in production before enabling.
2. **Batch with a cap.** Delete in batches (e.g. 5,000 rows) with a per-run
   ceiling, so the first real run cannot lock the database for minutes or blow
   up WAL. Log progress.
3. **Never delete based on a nullable field without an explicit null guard.**
   A `deletedAt < X` predicate that accidentally matches `NULL` semantics, or an
   inverted comparison, destroys live data. Unit-test every predicate.
4. **Object deletion must follow row deletion, never precede it** — the same
   ordering discipline the device sync engine already uses
   (`apps/agent/src/sync.ts`: commit, *then* delete files). An orphaned object is
   harmless; a row pointing at a deleted object is a broken screen.
5. **Never delete an object still referenced.** Before purging a media asset's
   storage keys, re-check that no `MediaVariant` or other `MediaAsset` shares the
   key. Storage keys are id-scoped (`org/<orgId>/media/<assetId>/...`,
   `routes/media.ts:118`) so sharing should be impossible — verify rather than
   assume.
6. **Log every run** to `AuditLog` with `action: 'retention.run'` and the counts,
   so deletions are attributable and reviewable.
7. **Require a recent verified backup.** Ideally the job refuses to run
   destructively if the last successful backup (T011) is older than N hours.

### 4. Indexes to support the job (and the dashboard)

The delete predicates need indexes or the job will table-scan:

- `device_heartbeats` already has `@@index([deviceId, createdAt])` — a delete
  filtered on `createdAt` alone cannot use it. Consider a `createdAt` index.
- `device_logs` has `@@index([deviceId, loggedAt])` — same issue.
- `playback_events` has `@@index([deviceId, occurredAt])` — same issue.
- Related (from report B8): `playStatsFor` (`routes/media.ts:50`) groups by
  `mediaAssetId` filtered on `eventType`, but the only matching index is
  `@@index([organizationId, mediaAssetId, eventType, occurredAt])`, whose leading
  column is `organizationId` — so the query cannot use it. Add
  `@@index([mediaAssetId, eventType, occurredAt])`.

All index additions are additive migrations. Follow T011's migration procedure.
On a large table, consider `CREATE INDEX CONCURRENTLY` (which Prisma migrations
do not emit by default and which cannot run in a transaction).

### 5. Log rotation

- Docker: confirm T010's `json-file` `max-size: 10m`, `max-file: 5` is applied to
  `api`, `worker`, `web`, `caddy`. Without it, a chatty error loop fills the disk.
- Host: `journald` `SystemMaxUse=` in `/etc/systemd/journald.conf`.
- API log level in production is already `info`
  (`apps/api/src/server.ts:45`); confirm nothing logs a full manifest or payload
  at info level.
- Confirm no secrets are logged. Existing code is careful here — the superadmin
  bootstrap explicitly never logs the password
  (`apps/api/src/lib/superadmin.ts`), and audit metadata excludes credentials.
  Re-verify after T012 adds audit call sites.

### 6. Alerting

Evaluate on a schedule (every 5 min) in the worker; dispatch to a configurable
webhook (Slack/Discord/ntfy/email relay). Keep it stateless and idempotent:
fire on transition, re-fire at most every N hours while still firing, and send a
recovery notice.

| Condition | Threshold | Why it matters |
|---|---|---|
| Device offline | `lastSeenAt` older than `OFFLINE_THRESHOLD_SECONDS * 2` (~3 min), sustained 15 min | A dark screen is the product failing at its one job |
| Device sync failed | `syncStatus = 'error'` for > 30 min | Content is stale; often a full disk (see T017) |
| Media processing failed | any `MediaAsset.processingStatus = 'failed'` in the last hour | Upload silently never appears on screens |
| Emergency active too long | `EmergencyOverride.active = true` and `startedAt` older than N hours (default 4, configurable) | **Highest-value alert.** An override left on blanks a customer's screens indefinitely, and `routes/emergency.ts` has no auto-expiry |
| Queue backlog | BullMQ waiting count > N for > 15 min | Worker wedged or under-provisioned |
| Backup stale | last successful backup older than 36 h | Ties to T011; a silent backup failure is the worst failure |
| Disk low on the server | < 15% free | |

Add a "muted until" concept per device so a screen that is knowingly powered down
overnight does not page every night.

### 7. Operational visibility in the dashboard

Reuse what exists rather than building a new area:

- `apps/web/src/pages/Monitoring.tsx` — add a fleet summary: online/offline/error
  counts, devices with failed syncs, active emergency overrides with elapsed time,
  media stuck in `pending`/`failed`.
- `apps/web/src/pages/DeviceDetail.tsx` — surface `lastError`, `syncStatus`,
  `cacheUsedBytes` vs `diskTotalBytes`, and last heartbeat age prominently.
  (Note: `lastError` is currently never cleared once set — report D10. Fixing
  that belongs to T015, but this task should not present a stale error as
  current.)
- Superadmin: a simple platform health panel (device counts, queue depth, last
  retention run, last backup) reading `/health/ready` plus a small stats endpoint.

---

## Acceptance criteria

- [ ] `GET /health` stays dependency-free and is used by the container healthcheck.
- [ ] `GET /health/ready` reports per-dependency status and returns 503 when a
      dependency is down; verified by stopping Redis and then Postgres.
- [ ] `api`, `worker` and `web` all have working Compose healthchecks;
      `docker compose ps` shows `(healthy)`.
- [ ] The retention job runs daily, defaults to **dry-run**, and logs exactly
      what it would delete.
- [ ] After enabling it for real, `device_heartbeats`, `device_logs` and
      `playback_events` stop growing without bound; measured over two weeks.
- [ ] Orphaned S3 objects from soft-deleted media, superseded variants and
      trimmed screenshots are reclaimed; verified by bucket size before/after.
- [ ] Every retention run writes an `AuditLog` entry with counts.
- [ ] The job never deletes a row or object that is still referenced — proven by
      unit tests on the predicates and by a staging run against a seeded dataset.
- [ ] Container and journal logs are size-capped; a deliberate error loop cannot
      fill the disk.
- [ ] Alerts fire for all seven conditions and are received on the webhook.
- [ ] A left-on emergency override produces an alert within the configured window.
- [ ] `docs/architecture.md:229`'s pruning claim is now accurate.

---

## Testing checklist

- [ ] Unit-test every retention predicate, including boundary cases: exactly at
      the cutoff, `NULL` `deletedAt`, and a row referenced by a live playlist.
- [ ] Seed a database with ~1 M synthetic telemetry rows; run the job; measure
      duration, lock behaviour and WAL growth. Confirm batching works.
- [ ] Dry-run output matches what a subsequent real run actually deletes.
- [ ] Delete-ordering test: kill the job between row deletion and object deletion;
      confirm the result is orphaned objects (recoverable) and never a dangling
      reference.
- [ ] Play-count regression: confirm `GET /orgs/:orgId/media/:mediaId/playback-stats`
      still returns sensible numbers after a retention run, and that the change
      in totals is understood and documented.
- [ ] `/health/ready` with Postgres stopped → 503, `database.ok: false`, no
      credentials leaked in the response.
- [ ] `/health/ready` with S3 unreachable → `degraded`, and confirm the API still
      serves the dashboard and device sync from cache/DB.
- [ ] Healthcheck false-positive test: pause the API container
      (`docker pause`) and confirm Docker marks it unhealthy.
- [ ] Alert test for each condition, including the recovery notification.
- [ ] Confirm alert dispatch failures do not crash the worker or block the queue.
- [ ] Index verification: `EXPLAIN ANALYZE` the retention deletes and
      `playStatsFor` before and after adding indexes.

---

## Rollback / safety notes

- **Do not enable non-dry-run retention until T011's backup + verified restore is
  in place.** These deletions are irreversible.
- Run the first real retention pass **manually, in a maintenance window, with a
  fresh backup taken minutes before**, and inspect the audit entry afterwards.
- Start with generous windows (e.g. 90 days everywhere) and tighten later. It is
  trivial to delete more next month; it is impossible to un-delete.
- Keep `RETENTION_DRY_RUN` as a runtime kill switch — an operator must be able to
  stop deletions without a code deploy.
- Deep health checks must never take down the service: wrap every dependency
  check in a timeout, never let `/health` (liveness) depend on them, and make
  sure a slow S3 cannot make the container appear unhealthy and restart-loop.
- Alerting must fail open. A broken webhook should log a warning, not throw
  inside the worker loop.
- Adding indexes to large tables locks writes unless created concurrently.
  Schedule it, and follow T011's pre-migration backup step.
