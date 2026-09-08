# T018 — API authorization and regression test foundation

| | |
|---|---|
| **Estimate** | M–L |
| **Risk** | Low — adds tests only, changes no application behaviour. The risk is what the tests *find* |
| **Depends on** | T010 (so the production topology is settled). **Can start in parallel with T012/T013.** |
| **Blocks** | Customer use. A cross-tenant leak in a multi-tenant product is existential |
| **Status** | Not started |

> Self-contained by design: a fresh Claude Code session has no memory of the
> review that produced this file.

---

## Objective

Build the **minimum** automated test foundation needed before external customer
use. Specifically: prove that the authorization boundaries actually hold, that
one organization cannot reach another's data, that device tokens are correctly
scoped, and that the playback watchdog does not regress.

This is not a coverage-percentage exercise. It is targeted at the places where a
bug is unrecoverable.

---

## Context from the review report

### Current coverage *(F14 — Medium-High, CONFIRMED)*

Twelve test files, ~1,900 lines, **all pure unit tests**:

| Package | Files | Assessment |
|---|---|---|
| `packages/scheduler` | `resolve.test.ts` (222 L) | Window matching, overnight wrap, DST, precedence. **Good.** |
| `packages/shared` | `playback-queue.test.ts` (219 L), `display.test.ts`, `schemas-display.test.ts` | Queue engine, display resolution. **Good.** |
| `packages/sync-protocol` | `manifest.test.ts` (209 L) | Canonical hashing, diffing. **Good.** |
| `packages/media` | `media.test.ts` (191 L), `logo.test.ts` | Sniffing, sanitisation, probe interpretation. **Good.** |
| `apps/agent` | `state.test.ts` (381 L), `sync.test.ts` (230 L) | Player state, sync guarantees. **Good.** |
| `apps/api` | `playlist-resolver.test.ts`, `tokens.test.ts`, `media-variant.test.ts` | **All under `src/lib/` — pure functions only.** |
| `apps/worker` | none | `"test": "vitest run --passWithNoTests"` |
| `apps/web`, `apps/player` | none | `"test": "echo \"no tests\""` |

**No route handler has ever been exercised by a test.** No authorization boundary
is verified. No migration is validated. No media job is run. No browser code is
covered. `pnpm test` passes while testing none of the integration surface.

### Why authorization specifically

The authorization model is non-trivial and therefore worth testing:

- `apps/api/src/plugins/auth.ts` `requireOrgRole` has several interacting rules:
  a 4-level ladder (`viewer < editor < admin < owner` via `roleSatisfies` in
  `lib/auth.ts`); **superadmins get `owner` in any org** even without a
  membership; disabled users are rejected; disabled orgs are rejected **except**
  for superadmins; soft-deleted orgs are rejected for everyone.
- Two entirely separate credential systems: user JWTs and device tokens
  (`makeDeviceAuth`, SHA-256 hashed, `device_tokens`).
- Every org-scoped route re-checks the role. That is the right design, but it
  means the check is repeated ~50 times and a single omission is a leak.
- Device media authorization goes through `allowedMediaIdsForDevice`
  (`apps/api/src/lib/manifest.ts`) with a **30-second per-instance cache**
  (`routes/device-api.ts:38`) — so revocation is not instant, and the cache is
  per-replica.

### Specific untested behaviours worth asserting

- **Pairing single-use** — `routes/device-api.ts` uses a conditional `updateMany`
  (`where: { id, pairingCode: code }`) so concurrent claims yield exactly one
  token. Elegant, and completely untested.
- **Playback event dedup** — `@@unique([deviceId, clientEventId])` +
  `createMany({ skipDuplicates: true })`. The offline-resubmission idempotency
  claim in `docs/sync-protocol.md` rests entirely on this.
- **Manifest determinism** — unit-tested in `sync-protocol`, but not end-to-end
  through `buildSyncManifest` against a real database.
- **Migration drift** — six migrations exist; nothing checks that they produce
  the schema in `schema.prisma`.

---

## Files likely involved

**Create:**
- `apps/api/vitest.config.ts` — integration test setup, longer timeouts
- `apps/api/src/test/helpers.ts` — build the app with a test DB, seed fixtures,
  mint tokens for each role
- `apps/api/src/test/authz.test.ts` — **the route × role matrix**
- `apps/api/src/test/tenancy.test.ts` — cross-tenant isolation
- `apps/api/src/test/device-auth.test.ts` — device token scope
- `apps/api/src/test/pairing.test.ts`
- `apps/api/src/test/sync.test.ts` — manifest generation end to end
- `apps/api/src/test/playback-events.test.ts` — dedup
- `apps/player/vitest.config.ts` + `apps/player/src/player.test.ts` —
  **state machine regression, incl. the T015 watchdog behaviour**
- `.github/workflows/ci.yml` (or equivalent) — run it all on every push
- `docs/testing.md` — how to run the suites, what needs Docker

**Edit:**
- `apps/api/package.json` — split `test` (unit) and `test:integration`
- `apps/player/package.json` — replace `"test": "echo \"no tests\""`
- `packages/database/package.json` — a `migrate:check` script

**Read-only reference:**
- `apps/api/src/server.ts` — `buildServer({ prisma, logger })` already accepts an
  injected Prisma client and a logger toggle. **This is exactly the seam a test
  harness needs** — the app is already testable, nobody has used it.
- `apps/api/src/plugins/auth.ts`, `apps/api/src/lib/auth.ts`
- `packages/database/src/seed.ts` — existing fixture patterns
- `apps/mock-device/src/main.ts` — the E2E device driver

---

## Non-goals

- A coverage percentage target. Target the *risk*, not the number.
- Testing the dashboard UI (React component tests). Valuable later; not the
  minimum bar.
- Load or performance testing.
- Full worker/media-pipeline tests with real ffmpeg — worthwhile (report P1) but
  slower and lower risk than authorization. Out of scope here.
- Mutation testing, property-based testing beyond one or two targeted cases.
- Replacing the existing good unit tests. Keep them; they are the model.

---

## Implementation plan

### 1. Test harness

Decide the database strategy first — it shapes everything:

- **Preferred: Testcontainers** (`@testcontainers/postgresql`). Real Postgres,
  real migrations, real constraints, disposable. Requires Docker in CI.
- Alternative: a dedicated test database on a local Postgres, reset per run.
- **Do not mock Prisma.** Most of what needs testing here *is* the query
  predicates (`deletedAt: null`, org scoping, `skipDuplicates`), and a mock
  asserts nothing about them.

`apps/api/src/test/helpers.ts` should provide:

- `withTestDb()` — container up, `prisma migrate deploy`, truncate between tests
- `buildTestApp(prisma)` — `buildServer({ prisma, logger: false })`
- `seedFixture()` — two organizations (**A** and **B**, deliberately), one user
  per role in each, a superadmin, a disabled user, a disabled org, a soft-deleted
  org, devices, device groups, media in several `processingStatus` states,
  playlists (manual/folder/random/priority), schedules, folders
- `tokenFor(user)` — mint a JWT via `signUserToken`
- `deviceTokenFor(device)` — create a `DeviceToken` row and return the raw token

Use `app.inject()` throughout — no network, fast, and it exercises the full
Fastify pipeline including `preHandler` hooks and the error handler.

### 2. The route × role matrix — the highest-value test in the repo

Enumerate every registered route (there are 13 route modules in
`apps/api/src/server.ts`) and assert the status code for each caller:

| Caller | Expectation |
|---|---|
| no token | 401 |
| malformed / expired token | 401 |
| `viewer` in the org | 200 on reads, 403 on writes |
| `editor` | 200 on content writes, 403 on admin actions |
| `admin` | 200 on admin actions, 403 on owner-only if any |
| `owner` | 200 |
| **member of a different org** | 403/404 — **never 200** |
| non-member, non-superadmin | 403 |
| `superadmin` (no membership) | 200 — treated as `owner` |
| disabled user | 403 |
| member of a **disabled org** | 403 |
| superadmin in a disabled org | 200 |
| member of a **soft-deleted org** | 403 |

Write it as a **data-driven table**, one row per route, so adding a route without
adding a row is visible in review. Include the specific minimum roles the code
sets today, e.g.:

- `POST /orgs/:orgId/media` → `editor` (`routes/media.ts:81`)
- `DELETE /orgs/:orgId/devices/:deviceId` → `admin` (`routes/devices.ts:167`)
- `POST /orgs/:orgId/devices/:deviceId/revoke-token` → `admin`
- `POST /orgs/:orgId/emergency` → `admin` (`routes/emergency.ts:51`)
- `POST /orgs` → superadmin only (`routes/orgs.ts:32`)
- all `/superadmin/*` → superadmin (hook at `routes/superadmin.ts:34-38`)
- `POST /auth/register` → **410 Gone** (deliberate, `routes/auth.ts:26`)

Also assert the negative: `GET /superadmin/audit-logs` as a plain org **owner**
must be 403.

### 3. Cross-tenant isolation

Generate, rather than hand-write, the important half: for every route taking an
org-scoped resource id, call it as an authenticated member of **org A** using an
id belonging to **org B**, and assert a non-2xx.

Cover: `mediaId`, `playlistId`, `playlistItemId`, `scheduleId`, `deviceId`,
`groupId`, `folderId`, `overrideId`, `priorityRuleId`, `membershipId`.

Also assert **list endpoints never leak**: as org A, `GET /orgs/A/media` returns
only A's media even when B has media with identical names. Same for devices,
playlists, schedules and folders.

Two specific traps worth explicit tests:

- `PATCH /orgs/:orgId` (`routes/orgs.ts:67`) calls `prisma.organization.update`
  **without a `deletedAt: null` guard** — assert the intended behaviour for a
  soft-deleted org and fix the code if the test says it is wrong.
- `POST /orgs/:orgId/devices/:deviceId/commands` (`routes/devices.ts:215`)
  mutates device state for `set_playlist` / `set_orientation` / `update_settings`
  **before** creating the command row — assert a cross-org `playlistId` is
  rejected *before* any mutation happens.

### 4. Device token authorization

- Device token from org B cannot fetch org A's manifest.
- `GET /device/media/:mediaId/file` with a media id **not in the device's own
  manifest** → 403 (`routes/device-api.ts:302`, `allowedMediaIdsForDevice`).
- A **revoked** token → 401 (`plugins/auth.ts:97`).
- A token belonging to a **soft-deleted device** → 401.
- Token accepted via the `?token=` query parameter as well as the
  `Authorization` header (used by the WebSocket upgrade) — assert both, and
  assert an invalid one is rejected on both.
- Command ack/result from device A for device B's command id → 404
  (`updateMany` scoped by `deviceId`, `routes/device-api.ts`).
- **Document the 30-second `allowedMediaCache` window** with an explicit test, so
  the eventual-consistency behaviour is intentional and known rather than
  surprising. If it should be instant, that is a code change — record the decision.

### 5. Pairing

- Valid code → 201, returns a token exactly once, clears `pairingCode`.
- Same code again → 404/409 (single use).
- **Concurrent claims:** fire N simultaneous requests with the same code; assert
  exactly one 201 and N−1 failures. This is the test for the conditional
  `updateMany` pattern.
- Expired code → 400 with the "generate a new one" message.
- Unknown code → 404.
- Code for a soft-deleted device → 404.
- Normalisation: lowercase, spaces and dashes all resolve
  (`normalizePairingCode` in `lib/tokens.ts`).
- Token format: `sgd_` prefix + 64 hex; only the SHA-256 hash is stored — assert
  the raw token is **not** in the database.

### 6. Sync and manifest end-to-end

- Build a manifest for a device with schedules (direct + via group), a default
  playlist, folder entries, priority rules, and media in mixed states.
- Assert only `ready` media with a checksum appears.
- Assert **determinism**: two consecutive builds with no changes produce an
  identical `version` (the whole poll-skip optimisation depends on this).
- Assert the version **changes** when: a playlist item is added, a schedule is
  edited, an emergency starts, media is replaced, device settings change.
- Assert a soft-deleted media asset disappears from the manifest.
- Assert per-device tiers: a `light`-profile device gets the `video_light`
  variant's checksum and size (`applyProfileVariants`), and falls back to
  standard when the variant is absent.
- Assert **v1 backwards compatibility**: a manifest without `playbackOrderMode`
  and display fields is handled by the current agent state builder as
  `manual_order` + platform defaults. `docs/sync-protocol.md` claims this;
  nothing currently verifies it.

### 7. Playback event dedup

- Submit a batch, then resubmit the identical batch → row count unchanged.
- Mixed batch (some new, some duplicate) → only the new ones inserted.
- Events with `clientEventId: null` → **not** deduped (Postgres treats NULLs as
  distinct in a unique index; the code comments say this is intentional —
  assert the intent).
- A device cannot write events attributed to another device.

### 8. Migration drift check

Add a CI step:

- `prisma migrate deploy` against an empty database, then
  `prisma migrate diff --from-schema-datasource --to-schema-datamodel` and assert
  the diff is empty. Catches "someone edited `schema.prisma` without generating a
  migration".
- Assert every migration in `packages/database/prisma/migrations/` applies
  cleanly from scratch.

### 9. Player state machine regression tests

`apps/player` has no test setup at all. Stand up vitest + jsdom and cover the
behaviours **T015** introduces (this task provides the harness; T015 provides the
behaviour — coordinate so the tests land with the fix):

- **A video element that never fires `ended` still advances.** The F1 regression
  guard. This is the single most important test in this task.
- A stalled video (`currentTime` frozen) is detected.
- A healthy video slightly longer than its probed duration is not truncated.
- A single looping video re-arms its safety timer per loop.
- Images advance on their normal duration.
- Repeated load errors back off rather than spinning at `ERROR_RETRY_DELAY_MS`.
- Fit mode × rotation produce the expected CSS classes.
- A state update mid-item preserves position for `manual_order` and restarts for
  random modes.
- `playToken` invalidation prevents two concurrent playbacks.

### 10. One E2E path with the mock device

`apps/mock-device` already exists and pairs, syncs and serves like a real device.
Use it for a single golden path (Playwright or a plain script):

1. Superadmin logs in → creates an org and an editor user
2. Editor uploads an image → polls until `ready`
3. Creates a playlist with that item
4. Creates a screen → gets a pairing code
5. Mock device pairs against the API
6. Assert the manifest the mock device receives contains the expected item, with
   the expected checksum and resolved display settings
7. Mock device downloads the media and verifies the checksum
8. Issue an `identify` command → assert the device acks and reports a result
9. Start an emergency override → assert the manifest flips
10. Stop it → assert it restores

**One** path, run in CI, kept fast. Its value is catching wiring breakage between
layers, not exhaustive coverage.

### 11. CI

- Run `pnpm typecheck` and `pnpm test` (unit) on every push — fast, no Docker.
- Run integration + E2E on push to `master` and on PRs — needs Docker services.
- Add the migration drift check.
- Fail the build on any failure. Today `pnpm test` passes trivially for three
  packages that have no tests; fix those `echo "no tests"` scripts so an empty
  suite is visible rather than green.

---

## Acceptance criteria

- [ ] Every route registered in `apps/api/src/server.ts` appears in the
      authorization matrix with an explicit expectation per caller type.
- [ ] Cross-tenant tests cover every org-scoped id parameter; **no test produces
      a 2xx for a cross-org id**.
- [ ] Superadmin escalation, disabled users, disabled orgs and soft-deleted orgs
      all behave as the matrix specifies.
- [ ] Device token scope is verified, including revoked tokens, deleted devices,
      query-param auth and media not in the device's manifest.
- [ ] Concurrent pairing yields exactly one token.
- [ ] Manifest generation is proven deterministic against a real database, and
      proven to change for each of the five listed mutations.
- [ ] Playback event resubmission is proven idempotent.
- [ ] Migration drift check passes and runs in CI.
- [ ] **A video that never fires `ended` still advances** — test exists and passes
      (with T015).
- [ ] The E2E path runs green in CI.
- [ ] `apps/web` and `apps/player` no longer report a false-green `echo "no tests"`.
- [ ] `docs/testing.md` explains how to run each suite and what needs Docker.
- [ ] Any bug the tests uncover is filed as a follow-up task — **do not fix
      application code inside this task beyond what is needed to make a correct
      test pass.**

---

## Testing checklist

*(This task is tests. The checklist is about testing the tests.)*

- [ ] Confirm each test fails when the behaviour it guards is deliberately
      broken — comment out a `requireOrgRole` call and confirm the matrix goes
      red. **A test that cannot fail is not a test.**
- [ ] Confirm the cross-tenant suite catches a deliberately removed
      `organizationId` filter.
- [ ] Confirm the dedup test catches removing `skipDuplicates`.
- [ ] Confirm the drift check catches a `schema.prisma` edit without a migration.
- [ ] Confirm the player test catches reverting the T015 safety timer.
- [ ] Run the full suite ten times; fix any flakiness immediately. A flaky
      authorization suite will be ignored within a month, and then it is worse
      than nothing.
- [ ] Measure total runtime. Unit < 30 s; integration ideally < 5 min.
- [ ] Verify tests clean up (no leaked containers, no cross-test DB state).
- [ ] Verify the suite runs on a clean checkout with no manual setup beyond
      Docker.

---

## Rollback / safety notes

- This task adds tests only; there is no production rollback concern.
- **Expect the tests to find real bugs.** The review already flagged two likely
  candidates in this area: the missing `deletedAt` guard on `PATCH /orgs/:orgId`,
  and command-route mutation ordering. When a test fails, decide deliberately
  whether the test or the code is wrong — and if it is the code, file it rather
  than fixing it inline, so the security-relevant change gets its own review.
- Do **not** weaken a test to make it pass. If the authorization matrix says a
  cross-org request should be 403 and the code returns 200, that is the finding,
  not a test bug.
- Testcontainers needs Docker in CI. If that is not available, fall back to a CI
  service container rather than mocking Prisma — mocking would make the whole
  suite worthless for its stated purpose.
- Keep integration tests out of the default `pnpm test` if they slow the inner
  loop, but make sure CI runs both. A suite developers skip is a suite that rots.
