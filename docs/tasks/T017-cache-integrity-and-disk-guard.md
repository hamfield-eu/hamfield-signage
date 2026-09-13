# T017 — Device cache integrity and disk guard

|                |                                                                                                                                                                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Estimate**   | M                                                                                                                                                                                                                                                                                                    |
| **Risk**       | Medium — touches the sync engine, which is the code path that must never break playback. LRU eviction deletes files on customer devices                                                                                                                                                              |
| **Depends on** | None technically. Coordinate with **T015** (the watchdog must not reboot a device whose real problem is a full disk)                                                                                                                                                                                 |
| **Blocks**     | Production use of any device with small internal storage — i.e. most x86 thin clients (**T016**)                                                                                                                                                                                                     |
| **Status**     | **Implemented 2026-09-10.** Integrity + repair, the storage precheck and the `insufficient_storage` status, orphan/`.part` sweep, opt-in LRU eviction, metrics and the dead-constant cleanup. Not deployed, and `sync.test.ts` could not be executed in this environment — see "Outcome" at the end. |

> Self-contained by design: a fresh Claude Code session has no memory of the
> review that produced this file.

---

## Objective

Stop two device-side failure modes that are currently **permanent and
unrecoverable without manual intervention**:

1. A cached media file that is missing or corrupt on disk is never repaired — the
   player errors on it forever.
2. A device whose disk fills cannot complete a sync, aborts, retries, aborts
   again, and never converges. Content is frozen at whatever was last applied.

---

## Context from the review report

Graded **A3 — Critical before real customer use**. Both findings are CONFIRMED
by reading the code.

### F5 — Cached files are never re-validated against disk _(CONFIRMED)_

`packages/sync-protocol/src/manifest.ts:48` — `diffManifest` decides what to
download by comparing the manifest against the **SQLite cache index only**:

```ts
const entry = cachedByMedia.get(media.id);
if (entry && entry.checksum === media.checksum) {
  unchanged.push(media); // never re-downloaded
} else {
  toDownload.push(media);
}
```

The index is `media_cache` in `apps/agent/src/db.ts`. Nothing ever `stat`s the
file or re-hashes it. So if a file is truncated by an eMMC write failure, deleted
manually, or corrupted, the index still says "present with the right checksum"
and the file is **never re-downloaded**.

Downstream, `computePlayerState` (`apps/agent/src/state.ts`) includes the item
because `cachedMediaIds` comes from `db.listCachedMedia()` — the index again. The
player requests `/media/:id`, `PlayerServer.serveMedia`
(`apps/agent/src/player-server.ts`) `stat`s the file, gets ENOENT, returns 404,
and the player emits an error and advances. Every cycle. Forever.

The only escape today is the `clear_cache` command
(`apps/agent/src/commands.ts` → `SyncEngine.clearCacheAndResync`), which nukes
and re-downloads **everything**.

### F6 — No free-space precheck and no cache cap _(CONFIRMED)_

`apps/agent/src/sync.ts:89-118`:

```ts
for (const media of diff.toDownload) {          // line 89
  const filePath = join(this.config.mediaDir, media.id);
  await this.api.downloadMedia(media, filePath);
  upserts.push({ ... });
}
// ...
this.db.applyManifest(manifest, upserts, diff.toDelete);   // line 118
// stale files deleted only AFTER this commit
```

Two problems compound:

- **No `statfs` check before downloading.** `apps/agent/src/metrics.ts`
  `collectMetrics` computes `diskFreeBytes` for the heartbeat, but nothing
  consumes it as a guard. `bytesToDownload(diff)` already exists in
  `packages/sync-protocol/src/manifest.ts` and is used only for a log line.
- **Downloads complete before deletions happen.** This ordering is _correct_ for
  crash safety (a crash leaves orphans, never a dangling index) and must be
  preserved — but it means the device transiently needs `old + new` bytes. A
  playlist swap that replaces 6 GB with 6 GB needs 12 GB free.

Result: ENOSPC mid-download → the catch block reports `sync-status: failed`
(`sync.ts:107`) → the whole sync aborts → old content keeps playing (good) → the
next poll tries the identical sync and fails identically. **It never converges**,
and the only signal is a string in `Device.lastError`.

### The cache cap is dead code _(CONFIRMED)_

`packages/shared/src/constants.ts` declares:

```ts
export const DEFAULT_MAX_CACHE_SIZE_GB = 8;
```

Grep confirms **zero consumers**. There is no cache budget, no LRU, no eviction.
(Several sibling constants — `HEARTBEAT_INTERVAL_SECONDS`,
`SYNC_INTERVAL_SECONDS`, `POLL_FALLBACK_INTERVAL_SECONDS`,
`DEFAULT_IMAGE_DURATION_SECONDS` — are also unused, with the agent hardcoding its
own values in `apps/agent/src/main.ts:11-17`. Worth cleaning up in the same pass.)

### Why this is urgent for x86

Thin clients typically ship with small internal storage. Combined with per-device
encoding tiers (`high` = 9000 kbps, `packages/media/src/transcode.ts`
`VIDEO_TIERS`), a modest playlist can exceed the disk. This is, per the review,
**the most likely first production failure on a thin client.**

### Existing behaviour worth preserving

- Download-to-temp-then-rename with SHA-256 verification is already correct
  (`apps/agent/src/api-client.ts` `downloadMedia`: streams to
  `<tmpDir>/<id>.part`, hashes, compares, renames, cleans up on failure).
- The transactional commit order in `sync.ts` is correct and must not be changed.
- `syncStatus` already maps three device-reported states to
  `syncing | in_sync | error` (`apps/api/src/routes/device-api.ts`
  `REPORTED_SYNC_STATUS`), and `cacheUsedBytes` is already reported and stored.

---

## Files likely involved

- `apps/agent/src/sync.ts` — precheck, budget, eviction, integrity pass
- `apps/agent/src/db.ts` — cache index: add `lastVerifiedAt`, `lastUsedAt`; eviction queries
- `apps/agent/src/api-client.ts` — `reportSyncStatus` payload
- `apps/agent/src/config.ts` — `SIGNAGE_MAX_CACHE_GB`, `SIGNAGE_MIN_FREE_DISK_MB`
- `apps/agent/src/metrics.ts` — report cache/integrity state
- `packages/shared/src/constants.ts` — wire up `DEFAULT_MAX_CACHE_SIZE_GB`; remove dead constants
- `packages/shared/src/schemas.ts` — `syncStatusSchema`: new status value
- `packages/shared/src/enums.ts` — `SyncStatusValue`
- `packages/database/prisma/schema.prisma` + additive migration — new enum value + columns
- `apps/api/src/routes/device-api.ts` — accept and map the new status
- `apps/web/src/pages/DeviceDetail.tsx`, `Devices.tsx` — distinct storage state
- **Tests:** `apps/agent/src/sync.test.ts` (already 230 lines — extend it)

---

## Non-goals

- Changing the transactional sync contract (download → verify → commit → delete).
  It is correct; keep it.
- Delta/patch downloads or dedup across media ids.
- Server-side awareness of per-device capacity (a "will this playlist fit?" check
  in the dashboard is a good follow-up, not this task).
- Filesystem-level integrity (dm-verity, btrfs checksums).
- Server-side alerting on the new status — **T013** owns dispatch; this task
  produces the signal.
- Watchdog/recovery — **T015**.

---

## Implementation plan

### 1. Cache integrity verification

Add a verification pass to `SyncEngine`, run at **agent startup** and **after
every successful sync**:

- **Cheap tier (always):** for every `media_cache` row, `stat` the file. Missing
  file, or size ≠ `size_bytes` → mark invalid.
- **Expensive tier (periodic):** re-hash with `sha256File` (already imported in
  `apps/agent/src/api-client.ts` from `@signage/media`). Full re-hash of a
  multi-GB cache is slow and hammers eMMC, so:
  - hash at most N files per pass (round-robin by oldest `lastVerifiedAt`)
  - and/or hash on a long interval (e.g. each file once a week)
  - always hash a file immediately after a playback error is reported for it —
    the player's error event is the cheapest possible corruption signal, and it
    is already flowing into `apps/agent/src/main.ts` (`event.eventType === 'error'`)
- Add `lastVerifiedAt` to `media_cache` (extend the existing
  `migrateEventBuffer`-style additive-column pattern in `apps/agent/src/db.ts`,
  which already handles schema evolution with `PRAGMA table_info` + `ALTER TABLE`).

**Repair:** for each invalid entry, delete the row from `media_cache` and the
file, then trigger a sync. `diffManifest` will then naturally place it in
`toDownload`. Do **not** invent a separate repair download path — reuse the
existing one so checksum verification and temp-file handling stay identical.

**Do not abort the whole sync for a repair.** A single corrupt file should
re-download that file; only a genuine download failure should abort (existing
behaviour).

### 2. Free-space precheck

In `runSync`, before the download loop (`sync.ts:89`):

```
required = bytesToDownload(diff)                     // already exists
        + headroom                                    // SIGNAGE_MIN_FREE_DISK_MB, default ~500 MB
available = statfs(mediaDir).bavail * bsize
reclaimable = bytes held by cache entries in diff.toDelete
```

- If `available + reclaimable < required` → **do not start downloading.** Report
  the new `insufficient_storage` status with the numbers, buffer a log line,
  leave the previous content playing untouched.
- If `available < required` but `available + reclaimable >= required` → this is
  the "swap needs old + new" case. Options, in order of preference:
  1. **Stream deletions safely:** delete a `toDelete` file only once its
     replacement has been downloaded and verified. Requires care — a crash
     mid-way must still leave a consistent index. Safest variant: download in
     batches, and after each batch commit only the _additions_ to the index,
     deleting stale files whose ids are no longer in the manifest.
  2. **Two-phase sync:** commit an intermediate manifest state. More complex.
  3. **Simplest acceptable:** report `insufficient_storage` and require the
     operator to reduce the playlist. Not great, but far better than today's
     silent non-convergence.

  Pick (1) only if the crash-safety argument can be made cleanly; otherwise ship
  (3) first and improve later. **The non-negotiable requirement is that the
  device reports a clear, distinct, actionable state instead of looping.**

- Also check free space **during** the loop for large files, and catch ENOSPC
  explicitly so it maps to `insufficient_storage` rather than a generic error.

### 3. Cache budget and LRU eviction

- Wire up `DEFAULT_MAX_CACHE_SIZE_GB` (8 GB) as the default, overridable per
  device via `SIGNAGE_MAX_CACHE_GB` in `/etc/signage/agent.env`.
- On a small-disk device, the effective budget should be the **lesser** of the
  configured cap and a percentage of total disk (e.g. 70%), so a 32 GB eMMC does
  not get an 8 GB cache plus an OS that then has no room.
- Eviction candidates are **only files not referenced by the current manifest**.
  Add `lastUsedAt` to `media_cache`, touched when `PlayerServer.serveMedia`
  serves the file, so LRU is real rather than by download date.
- **Never evict a file the current manifest references** — that would defeat
  offline playback, which is the product's core promise. If the manifest itself
  exceeds the budget, that is an `insufficient_storage` condition, not an
  eviction problem.
- Given the existing sync already deletes everything in `toDelete`, unreferenced
  files should be rare. Eviction is therefore mostly a safety net for orphans
  left by a crash between commit and cleanup (a case `docs/sync-protocol.md`
  explicitly documents as expected). Add an **orphan sweep**: files present in
  `mediaDir` with no `media_cache` row, older than a grace period, get deleted.
  Also sweep stale `*.part` files in `tmpDir`.

### 4. New device status: `insufficient_storage`

- Add to `SyncStatusValue` (`packages/shared/src/enums.ts` and the Prisma enum —
  additive `ALTER TYPE ... ADD VALUE`; **note this cannot run inside a
  transaction in PostgreSQL**, so follow T011's migration procedure carefully).
- Extend `syncStatusSchema` (`packages/shared/src/schemas.ts`) with the new
  status plus structured fields: `requiredBytes`, `availableBytes`,
  `cacheUsedBytes`, `cacheBudgetBytes`.
- Map it in `REPORTED_SYNC_STATUS` (`apps/api/src/routes/device-api.ts`) —
  **keep it distinct from `error`.** The whole point is that an operator can tell
  "this device needs a smaller playlist or a bigger disk" apart from "something
  went wrong".
- **Backwards compatibility:** an older agent will never send it; a newer agent
  talking to an older server would get a 400 from the zod schema. Deploy the
  server change before the agent change, or have the agent fall back to `failed`
  with a descriptive error string if the server rejects the new value.

### 5. Dashboard surface

- `apps/web/src/pages/Devices.tsx` — a distinct badge for storage problems.
- `apps/web/src/pages/DeviceDetail.tsx` — show cache used vs. budget vs. disk
  free (all three already exist or are added here), the shortfall in MB, and a
  plain-language explanation ("This screen needs 2.4 GB more space for its
  current playlist").
- Feed `insufficient_storage` into T013's alerting.

### 6. Reported metrics

Extend `collectMetrics` (`apps/agent/src/metrics.ts`) with: `cacheBudgetBytes`,
`cachedFileCount`, `lastIntegrityCheckAt`, `integrityFailureCount24h`,
`orphanFilesRemoved24h`. This makes the fix observable rather than invisible.

Also clean up the dead constants in `packages/shared/src/constants.ts` while
touching this area — either wire them up in `apps/agent/src/main.ts` or delete
them, so the shared module stops lying about being the source of truth.

---

## Acceptance criteria

- [ ] A deliberately truncated cached file is detected and re-downloaded
      automatically, without operator action and without `clear_cache`.
- [ ] A deleted cached file is detected and re-downloaded.
- [ ] Integrity verification runs at startup and after each sync, and never
      blocks playback while it runs.
- [ ] A device with insufficient free space reports **`insufficient_storage`**,
      not a generic error, with the required/available byte counts.
- [ ] A device in that state **keeps playing its previously cached content** —
      the screen never goes blank because of a storage problem.
- [ ] Once space is freed (or the playlist is reduced), the device recovers
      **automatically** on the next sync, with no manual intervention.
- [ ] A cache budget is enforced; unreferenced files are evicted LRU.
- [ ] Files referenced by the current manifest are **never** evicted.
- [ ] Orphaned files and stale `.part` files are swept.
- [ ] The dashboard clearly distinguishes a storage problem from a sync error and
      states the shortfall.
- [ ] `DEFAULT_MAX_CACHE_SIZE_GB` is actually used; remaining dead constants are
      resolved.
- [ ] The transactional sync guarantees in `docs/sync-protocol.md` still hold —
      the failure-mode table in that document is still accurate after this change
      (update it if the semantics change).

---

## Testing checklist

**Unit / integration — extend `apps/agent/src/sync.test.ts`:**

- [ ] Cache index says present, file missing → re-downloaded.
- [ ] Cache index says present, file truncated → detected by size, re-downloaded.
- [ ] Cache index says present, file same size but wrong content → detected by
      hash on the periodic pass, re-downloaded.
- [ ] Integrity failure on one file does **not** abort the sync for other files.
- [ ] `bytesToDownload > available` → `insufficient_storage`, no download
      started, previous manifest and cache index untouched.
- [ ] Space freed → next sync succeeds with no intervention.
- [ ] Eviction never selects a manifest-referenced file.
- [ ] Orphan sweep removes an unindexed file but respects the grace period.
- [ ] Stale `.part` files are cleaned.
- [ ] Existing sync guarantees still pass: checksum mismatch aborts; crash
      between commit and cleanup leaves only orphans; concurrent triggers still
      coalesce (`syncing`/`queued` in `SyncEngine`).

**On-device:**

- [ ] Fill `/var/lib/signage` to ~99% with `fallocate`, add media to the playlist
      → confirm `insufficient_storage`, content keeps playing, dashboard shows the
      shortfall. **This test fails today** — it is the acceptance test for F6.
- [ ] `truncate -s 0` a cached file → confirm automatic repair.
      **This test fails today** — acceptance test for F5.
- [ ] Pull power during a download ×5 → no `.part` files accumulate, no dangling
      index entries, sync converges.
- [ ] Large playlist swap (replace most content) on a device with ~1.5× the
      required free space → confirm the behaviour matches whichever option was
      chosen in step 2, and that it is _documented_.
- [ ] Verify integrity hashing does not cause visible playback stutter on the
      target hardware (eMMC read contention) — throttle if it does.
- [ ] **Interaction with T015:** a device in `insufficient_storage` with an
      unplayable item must **not** trigger a watchdog reboot. Confirm the
      watchdog distinguishes "content is broken" from "player is wedged".

---

## Rollback / safety notes

- **The sync engine is the code path that must never break playback.** The
  guarantee in `docs/sync-protocol.md` — "the screen keeps playing the old
  content" through any sync failure — is the product's core promise. Every change
  here must preserve it; the existing tests in `apps/agent/src/sync.test.ts` are
  the guard, so extend them rather than rewriting them.
- **LRU eviction deletes files on customer devices.** Ship it behind a config
  flag, default-off, and enable it only after the integrity and precheck work has
  been running cleanly. Log every eviction.
- Roll out to one device via `software_update` (`infra/device/update.sh`) and
  watch for 48 h before the fleet.
- The `insufficient_storage` enum value requires a Postgres `ALTER TYPE ... ADD
VALUE`, which cannot run in a transaction — a failure can leave the enum
  partially altered. Take a verified backup first (T011) and deploy the server
  side before the agent side.
- Consider making the integrity re-hash pass abortable and low-priority. On a
  slow eMMC, hashing several GB while a video plays could itself cause the
  stalls T015 is trying to eliminate. Measure before enabling the expensive tier
  by default.
- Keep `clear_cache` working as the operator's blunt-instrument fallback — it is
  the current workaround documented in the runbook (T014) and should remain.

---

## Outcome (2026-09-10)

Both failure modes are closed in the repository. Nothing is deployed, and one
class of test could not be run here — details at the end, because they change
what this can be trusted for.

### What shipped

**1. Cache integrity and repair.** `verifyCache` in
`apps/agent/src/cache-maintenance.ts` runs at agent startup and after every
applied sync, in two tiers: `stat` every file each pass (catches missing and
truncated, one syscall each), and fully re-hash a bounded few, oldest
verification first, so each file is checked roughly weekly. Same-size corruption
is only visible to the second tier, and the second tier is rate-limited on
purpose — hashing several gigabytes saturates eMMC read bandwidth and would
itself cause the decode stalls T015 exists to remove.

A file the player has just reported a playback error on is re-hashed
**immediately, out of rotation**. That error event is the cheapest corruption
signal in the system and it was already flowing into `main.ts`; it now reaches
the sync engine through `noteSuspectMedia`.

Repair deletes the file and its index row, which is what puts the media back
into `toDownload`, then re-fetches it through the ordinary download path — same
checksum verification, same temp-file handling, same commit. No second download
path was invented.

**2. The repair path needed a `force` flag, and this is the part the task
plan got wrong.** The plan says: drop the row, trigger a sync, let `diffManifest`
do the rest. But `runSync` returns at
`if (manifest.version === currentVersion)` — and after a local repair the server
manifest is byte-identical to the one already applied, so the diff never runs and
the file is never re-fetched. A unit test calling `diffManifest` directly would
have passed while F5 stayed open. `syncNow(reason, { force: true })` skips only
that shortcut; everything downstream is unchanged. The regression tests drive
this through `maintainCache` end to end, not through `diffManifest`.

Automatic re-fetch is **rate-limited to once per 10 minutes**. Maintenance runs
at the end of every sync, so without that a device whose storage is physically
failing would corrupt a file, repair it, corrupt it again, and loop —
re-downloading the whole playlist continuously over the customer's network. The
damage is still detected and reported on every pass; only the re-fetch waits.

**3. The storage precheck.** Before a single byte is written, `planStorage`
compares required bytes plus a free-space headroom against `statfs`, and the
manifest's total size against the cache budget. Not enough room means the sync
**does not start**: it reports `insufficient_storage` with
required/available/reclaimable/shortfall, buffers a log line, and leaves the
previous manifest, index and files untouched. The screen keeps playing.

That is the whole difference from today, where the sync starts, hits ENOSPC
part-way, aborts, and the next poll repeats the identical failure forever with
nothing but a string in `lastError` to show for it.

ENOSPC is also caught explicitly inside the download loop and mapped to the same
status — the precheck can still be beaten by another process taking the space.

**Reclaimable bytes are reported but deliberately not counted as available.**
This is option (3) from the task's step 2, and the reasoning is the valuable
part: option (1) — deleting stale files early to make room for a large swap —
means either deleting a file while leaving its index row, which manufactures
exactly the F5 bug this task fixes, or removing the row too, which drops the
media out of `cachedMediaIds` and takes it off the screen while the old manifest
is still the active one. Either way it breaks the promise that the old content
keeps playing through a failed sync. The device genuinely needs `old + new`
space for a swap, and saying so plainly beats a clever scheme that can blank a
screen.

**4. `insufficient_storage`** as a device status, kept **distinct from `error`**
end to end: `SYNC_STATUSES`, the Prisma enum, `syncStatusSchema`,
`REPORTED_SYNC_STATUS`, and the dashboard. The distinction is the point — this
is the one sync failure an operator can act on, and the action ("smaller
playlist, or a bigger disk") is different from "something went wrong".

The agent falls back to `failed` when a pre-T017 server rejects the new value
with a 400. Note that this needed an explicit catch: every `reportSyncStatus`
call site ends in `.catch(() => undefined)`, so without one the 400 would have
been swallowed and the device would have shown a stale status instead.

**5. Cache budget and opt-in eviction.** `DEFAULT_MAX_CACHE_SIZE_GB` is finally
wired up, capped at 70% of the filesystem so a small eMMC does not hand most of
its disk to media. Eviction is **default-off** (`SIGNAGE_CACHE_EVICTION`), logs
every deletion to the buffered device log, and **never selects a file the
current manifest references** — that would break offline playback, and a device
with no network could not get the file back. A manifest that does not fit is an
`insufficient_storage` condition, not something eviction may paper over.

**Wiring `DEFAULT_MAX_CACHE_SIZE_GB` up is a behaviour change, not just a
cleanup.** While the constant was dead, a device with a 12 GB playlist on a
roomy disk synced happily; now it would refuse every sync and report
`insufficient_storage` until someone raised `SIGNAGE_MAX_CACHE_GB`. That is what
the task asks for, but it is a silent regression for any existing device over
the cap, so it was checked against production before shipping rather than after
(2026-09-10, `signage.hamfield.eu`):

|                                       |                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------- |
| All non-deleted media, whole platform | **672 MB**                                                                  |
| Device disks                          | 14 GB each → the 70% cap yields 9.8 GB, so the 8 GB default is what applies |
| Cache in use                          | 625 MB and 4.7 MB on the two live screens                                   |

No device is anywhere near the cap, so this ships as-is. Worth noting for later:
the busier screen has only 4.6 GB free on its 14 GB disk, so **free space, not
the budget, is the limit that will bite first** — which is the correct order,
since it is the one that used to produce the endless-retry loop.

**6. Orphan and `.part` sweep**, past a grace period and skipped while a sync is
running. Both guards matter: `downloadMedia` renames into the media directory
before `applyManifest` commits the rows, so an unindexed file is _normal_ for the
duration of a sync, and a sweep without them would delete a download in flight.

**7. Observability.** `cacheBudgetBytes`, `cachedFileCount`,
`lastIntegrityCheckAt`, `integrityFailureCount` and `orphanFilesRemoved` ride the
heartbeat; `storageShortfallBytes` is stored on the device and cleared on the
next successful sync, so the dashboard cannot show a stale "needs 2.4 GB more"
after the operator has fixed it. The device page shows cache used against
budget, cached file count, last integrity check, and a plain-language
explanation of the shortfall.

**8. Dead constants.** `DEFAULT_MAX_CACHE_SIZE_GB`, `HEARTBEAT_INTERVAL_SECONDS`,
`POLL_FALLBACK_INTERVAL_SECONDS` and `DEFAULT_IMAGE_DURATION_SECONDS` are now
used by the code that had been hardcoding the same numbers. `SYNC_INTERVAL_SECONDS`
was **deleted**: the agent has no sync timer — it syncs on the poll fallback, on
a server push, and on command — so the constant described a mechanism that does
not exist.

### Migration

`20260910190000_device_storage_guard` is additive: one `ALTER TYPE ... ADD VALUE
IF NOT EXISTS` plus four nullable columns. It matches the shape of
`20260624000000_per_device_encoding_tiers`, which already ran on production —
which settles the "cannot run in a transaction" warning empirically: since
PostgreSQL 12 it can, provided the migration does not _use_ the new value. This
one does not, and there is a comment in the file saying so, because adding a
statement that does would break it.

**Deploy the server before the agent**, and take a tagged pre-upgrade backup
first (runbook §7).

### Testing

28 new tests that run today, covering the parts that decide whether a device
downloads or deletes a customer's files:

- `cache-policy.test.ts` (17) — budget capping on a small disk, the precheck
  including that reclaimable bytes are **not** treated as available, headroom
  being kept rather than filling the disk to the last byte, `over_budget`
  reported ahead of `disk_full` because eviction cannot fix it, LRU ordering by
  real playback rather than download date, and that a referenced file is never
  an eviction candidate.
- `cache-maintenance.test.ts` (11) — missing, truncated and same-size-corrupt
  files; that `stat` alone deliberately cannot see the third; forced re-hash
  after a playback error; the orphan grace period that keeps the sweep from
  racing an in-flight download; `.part` cleanup.

`apps/agent/src/sync.test.ts` gained **16** end-to-end cases — the F5 and F6
acceptance tests among them, driven through `syncNow`/`maintainCache` against
the existing stub backend rather than through the pure helpers.

### Not verified — read this before trusting any of it

- **`sync.test.ts` cannot execute in this environment.** `better-sqlite3` has no
  compiled binding for Node 24 and `node-gyp` cannot build one because `make` is
  absent. Its four pre-existing tests already failed here on a clean `HEAD` for
  the same reason; the 16 new ones are **written and typechecked but never
  run**. `pnpm rebuild better-sqlite3` after installing a C toolchain is all it
  should need.
- **Nothing has run on a device.** The two acceptance tests the task calls out —
  `fallocate` the disk to 99% and confirm `insufficient_storage`; `truncate -s 0`
  a cached file and confirm automatic repair — are exactly the ones that need
  real hardware.
- **The T015 interaction is reasoned, not measured.** A device in
  `insufficient_storage` should not be "recovered" by a reboot. The liveness
  monitor shipped in T015 only reports, never restarts, so today it cannot do
  the wrong thing — but that constraint must be honoured when the recovery
  ladder is eventually built, and the ladder is where the coupling becomes real.
- **LRU bookkeeping is throttled to once per five minutes per media id.**
  `serveMedia` answers Range requests — that is what `accept-ranges` is for —
  and a buffering Chromium issues a stream of them; an unthrottled synchronous
  SQLite write per range would put flash writes in the middle of the one code
  path that must never disturb playback. Eviction orders by day-scale recency,
  so the coarse resolution costs nothing. Not covered by a test: nothing here
  exercises request volume, and it would only show up on real hardware.
- **The repair cooldown is not covered by a test** — it lives in `SyncEngine`,
  so its test would be in the file that cannot run here.
- **Eviction has never run against a real cache**, which is why it is off by
  default. Turn it on per device only after the integrity and precheck work has
  been running cleanly.
