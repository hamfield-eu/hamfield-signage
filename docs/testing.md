# Testing

Two suites, deliberately separate. The unit suite is what you run while working;
the integration suite is what proves the authorization boundaries hold.

## Quick reference

| Command                                       | What it runs                                  | Needs Docker |
| --------------------------------------------- | --------------------------------------------- | ------------ |
| `pnpm test`                                   | Every package's unit tests                    | No           |
| `pnpm --filter @signage/api test:integration` | The API integration suite (~220 tests, ~80 s) | **Yes**      |
| `pnpm typecheck`                              | Every package, plus the API's test tsconfig   | No           |
| `pnpm format:check`                           | Prettier                                      | No           |

## The unit suite — `pnpm test`

Pure functions, no network, no database, under a second per package. It must
stay that way: this is the suite that runs on every save and on every pull
request, and a suite people skip is a suite that rots.

| Package                  | Covers                                                      |
| ------------------------ | ----------------------------------------------------------- |
| `packages/scheduler`     | Window matching, overnight wrap, DST, precedence            |
| `packages/shared`        | Queue engine, display resolution                            |
| `packages/sync-protocol` | Canonical hashing, manifest diffing                         |
| `packages/media`         | Sniffing, sanitisation, probe interpretation                |
| `apps/agent`             | Player state, sync guarantees, cache policy and maintenance |
| `apps/api`               | `src/lib/` pure helpers only                                |
| `apps/player`            | The F1 watchdog, rendering, state transitions (jsdom)       |

Packages with no tests yet run `vitest run --passWithNoTests`, which reports an
empty suite rather than printing "no tests" and exiting 0. The difference
matters: the second form is indistinguishable from a suite that passed.

### Known failure in this environment

`apps/agent`'s SQLite-backed tests fail on **Node 24** with a missing
`better_sqlite3.node`. `better-sqlite3@11.10.0` has no prebuilt binding for that
ABI, so the install falls back to compiling from source, which needs `make` and
a C++ toolchain — absent here, so the binding is simply never produced.

This is not caused by any application change: four of these tests failed this
way before the cache work landed, and the other thirteen are the cases that work
added. Nothing about the agent's own logic is implicated.

CI pins Node 22 for this reason. That the tests pass there is **unverified** —
no Node 22 is installed on this machine, so the fix is reasoned from the missing
ABI, not observed. If Node 22 also lacks a prebuild, the alternative is
installing build-essential on the runner or upgrading `better-sqlite3`.

## The integration suite — `apps/api`

```bash
pnpm --filter @signage/api test:integration
```

Requires a working Docker daemon and nothing else. Testcontainers starts one
`postgres:16-alpine` and one `redis:7-alpine` for the whole run, on random
ports — so it will not collide with `pnpm dev:infra` or with another project
holding 5432 — runs `prisma migrate deploy` against the fresh database, and
stops both containers at the end.

Redis is there because `getMediaQueue()` and `getRedisPub()` are constructed
lazily inside route handlers; without it, the routes that enqueue a media job
would retry-loop instead of answering. **S3 is not stood up**, so the two
multipart upload routes are exercised for authorization only.

| File                      | What it proves                                                         |
| ------------------------- | ---------------------------------------------------------------------- |
| `harness.test.ts`         | The harness itself: migrations, fixtures, tokens, rate-limit spreading |
| `authz.test.ts`           | The route × role matrix, and that it covers every registered route     |
| `tenancy.test.ts`         | Org A cannot reach org B through any id, and lists never leak          |
| `device-auth.test.ts`     | Device token scope, revocation, `?token=`, media authorization         |
| `pairing.test.ts`         | Single use under concurrency, expiry, normalisation, hash-only storage |
| `playback-events.test.ts` | Offline resubmission is idempotent                                     |
| `sync-manifest.test.ts`   | Manifest determinism, what may appear, per-device tiers                |
| `migrations.test.ts`      | The migration chain reproduces `schema.prisma`                         |

### How it is put together

- `src/test/global-setup.ts` starts the containers and hands their URLs to the
  worker processes through Vitest's `provide`/`inject`. Not `process.env`:
  global setup runs in the main process, and `getEnv()` caches its parse on the
  first call anyway.
- `src/test/helpers.ts` builds an app per test file with an injected Prisma
  client, truncates between tests, and seeds two complete organizations, A and
  B. Every id in B is a cross-tenant probe.
- `src/test/route-table.ts` is the single list of routes. A completeness test
  walks Fastify's own route tree and fails when a registered route has no row,
  so adding a route without adding a row shows up in review.
- Workspace packages resolve to their TypeScript sources, not `dist/`. Their
  `dist/` is CommonJS while Vite serves `apps/api` as ESM, and the two halves
  would load different copies of zod — making `err instanceof ZodError` false
  and turning every validation error into a 500 under test only.
- Every request is injected from a unique source address, because the global
  rate limit is 300/minute keyed by `req.ip` and the matrix alone is ~900
  requests. A 429 looks exactly like an authorization failure.

### Writing a new test

Use `app.inject()` through the `call()` helper — no sockets, and it exercises
the whole Fastify pipeline including hooks and the error handler. Do **not**
mock Prisma: most of what is worth testing here is the query predicate itself
(`deletedAt: null`, the organization scope, `skipDuplicates`), and a mock
asserts nothing about any of it.

If you add a route, add a row to `route-table.ts`. The completeness test will
tell you if you forget.

### Confirm a new test can fail

A test that cannot fail is not a test. Before trusting a new one, break the
behaviour it guards and watch it go red. The ones already checked this way:

| Mutation                                     | Caught by                 |
| -------------------------------------------- | ------------------------- |
| Comment out one `requireOrgRole`             | The matrix, on that route |
| Drop `organizationId` from one device lookup | Ten cross-tenant tests    |
| `skipDuplicates: false`                      | The dedup tests           |
| A schema.prisma column with no migration     | The drift check           |
| Remove the player's stale-`playToken` guard  | The playToken test        |

## CI

`.github/workflows/ci.yml` runs the unit job on every push and pull request, and
the integration job alongside it. The unit job needs no Docker and must stay
that way.

`pnpm format:check` runs first in the unit job — it is the fastest way to fail
and the cheapest to fix. The whole repository was brought into compliance with
one `pnpm format` pass when the check was added; if you see it fail, run that.

**The workflow has never run.** It was written from the commands that were
executed locally; treat its first run as part of the review.
