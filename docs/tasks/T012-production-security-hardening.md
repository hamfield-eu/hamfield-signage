# T012 — Production security hardening

| | |
|---|---|
| **Estimate** | M |
| **Risk** | Medium — touches auth middleware and proxy config; a mistake can lock out the dashboard or break device connections |
| **Depends on** | T010 (needs the production topology to harden) |
| **Blocks** | External/customer use |
| **Status** | S2, S4, S5, S6, S8, S10 done. S9 partly done (non-root yes, image pruning deferred). Firewall + verification are operator tasks, not done. Nothing deployed yet. |

> Self-contained by design: a fresh Claude Code session has no memory of the
> review that produced this file.

---

## Objective

Close the security findings the review graded **High** and **Medium**, so the
platform is fit for external customers rather than a trusted internal fleet.

Everything below was found by reading the code. Line references are from commit
`44cb453`; re-verify before editing.

---

## Context from the review report

### S2 — `trustProxy: true` makes `req.ip` attacker-controlled *(High, LIKELY)*

`apps/api/src/server.ts:51` sets `trustProxy: true`. `@fastify/proxy-addr` with an
all-trust function walks the `X-Forwarded-For` chain right-to-left and returns
the first *untrusted* address — with everything trusted, that is the **leftmost**
entry. `infra/docker/web-nginx.conf:15` uses `$proxy_add_x_forwarded_for`, which
**appends** the real peer to whatever the client sent. So a client sending
`X-Forwarded-For: 1.2.3.4` produces a chain of `1.2.3.4, <real-ip>` and `req.ip`
becomes `1.2.3.4`.

Consequences:
- The rate limits on `/auth/login` (10/min, `routes/auth.ts:38`),
  `/auth/change-password` (5/min) and `/device/pair` (10/min,
  `routes/device-api.ts:87`) are all keyed on `req.ip` and become trivially
  bypassable by rotating a header.
- Every `AuditLog.ipAddress` (`apps/api/src/lib/audit.ts`) is forgeable, which
  undermines the audit trail this task also strengthens.

**This finding is marked LIKELY, not CONFIRMED — verify empirically before and
after the fix** (see the testing checklist).

### S8 — No security headers *(Medium)*

Neither `infra/docker/web-nginx.conf` nor `infra/docker/Caddyfile.example` sets
HSTS, CSP, `X-Content-Type-Options`, `X-Frame-Options` / `frame-ancestors`, or
`Referrer-Policy`. This matters more than usual here because of S5: the dashboard
JWT lives in `localStorage` (`apps/web/src/lib/api.ts:12`), so any XSS is a full
account takeover with no defence in depth.

### S6 — No global rate limit *(Medium)*

`apps/api/src/server.ts:63` registers `@fastify/rate-limit` with `global: false`.
Only three routes opt in. `/device/heartbeat`, `/device/logs`,
`/device/playback-events` and every `/orgs/*` route are unlimited — one
compromised device token can write unbounded rows into `device_logs` /
`playback_events`, which compounds the unbounded-growth problem T013 addresses.

### S4 — Org logo upload memory DoS *(Medium, CONFIRMED)*

`apps/api/src/server.ts:67` registers multipart with a global
`limits: { fileSize: env.MAX_UPLOAD_SIZE_BYTES }` (default **1 GiB**).
`apps/api/src/routes/orgs.ts:87` calls `file.toBuffer()` — fully materialising
the upload in API memory — and only afterwards calls `validateLogoBuffer`
(`packages/media/src/logo.ts:81`), which enforces the 2 MB `ORG_LOGO_MAX_BYTES`.
Any org admin can spike the API process by ~1 GiB.

### S9 — Containers run as root *(Medium)*

None of `infra/docker/{api,worker,web}.Dockerfile` sets `USER`. The runtime
stages also `COPY --from=build /app /app`, shipping source and devDependencies
into production images.

### S10 — Audit gaps *(Medium-High)*

`docs/architecture.md` claims "privileged and destructive actions are recorded in
an append-only `AuditLog`". Grep of `writeAudit` call sites shows coverage in
`superadmin.ts` (8), `orgs.ts` (3), `media.ts` (2), `playlists.ts` (2),
`priority-rules.ts` (4), `media-folders.ts` (1), `auth.ts` (1 — superadmin login).

**Not logged at all:**
- `apps/api/src/routes/emergency.ts` — emergency override **start and stop**.
  This is the single most disruptive action in the product; it blanks a
  customer's screens org-wide.
- `apps/api/src/routes/devices.ts` — device create, device delete,
  **token revoke**, **command issue** (including `reboot_device`), pairing-code
  regeneration.
- `apps/api/src/routes/schedules.ts` — all schedule mutations.

### S5 — JWT is not revocable *(Medium)*

`apps/api/src/lib/auth.ts` signs a 7-day token carrying only `sub` and `email`.
No `jti`, no password-version claim. Changing a password
(`routes/auth.ts:83`) does not invalidate outstanding tokens. Disabling a user is
caught on org-scoped routes by `requireOrgRole` (`plugins/auth.ts:47`, checks
`membership.user.disabledAt`) and on superadmin routes by `requireSuperadmin`,
so a disabled account is largely contained — but a **stolen** token stays valid
for up to seven days with no way to kill it.

### Firewall

T010 removes host port publishing, but that is a Docker-level control. Docker
manipulates `iptables` directly and can bypass a naively configured `ufw`, so a
host firewall alone is not sufficient — the Hetzner Cloud Firewall (applied at
the network edge, outside the host) is the reliable control.

---

## Files likely involved

- `apps/api/src/server.ts` — `trustProxy`, rate-limit defaults, multipart limits
- `apps/api/src/env.ts` — new env var for trusted-proxy configuration
- `apps/api/src/routes/orgs.ts` — route-scoped logo upload limit
- `apps/api/src/routes/emergency.ts` — add `writeAudit` (start + stop)
- `apps/api/src/routes/devices.ts` — add `writeAudit` (create, delete, revoke, command, regen code)
- `apps/api/src/routes/schedules.ts` — add `writeAudit` (create, update, delete)
- `apps/api/src/lib/auth.ts`, `apps/api/src/plugins/auth.ts` — optional `passwordChangedAt` claim
- `packages/database/prisma/schema.prisma` + a new migration — `User.passwordChangedAt` (if S5 is done)
- `infra/docker/web-nginx.conf`, `infra/docker/Caddyfile.example` — security headers
- `infra/docker/{api,worker,web}.Dockerfile` — `USER`, pruned runtime stage
- `docs/deployment.md:§11` — extend the hardening checklist
- New: `docs/security.md` or a section in the runbook — firewall rules

---

## Non-goals

- Rewriting the auth model (sessions, refresh tokens, OAuth/SSO). Out of scope.
- Moving the dashboard JWT out of `localStorage` into an httpOnly cookie. That is
  a larger change (CSRF handling, CORS credentials) and is a separate task.
- Granular per-permission RBAC (report item C12).
- SVG rasterisation for org logos (report S11, **Low** — logos render only via
  `<img src>`, which cannot execute SVG script).
- WAF, IDS, fail2ban, or intrusion detection.
- Penetration testing.

---

## Implementation plan

### 1. Fix `trustProxy` (S2)

- Change `apps/api/src/server.ts:51` from `trustProxy: true` to a **hop count**
  that matches the real topology. Behind Caddy → nginx → api, the API sees two
  proxies, so `trustProxy: 2` (or the explicit Docker-network CIDR) is correct.
  Count the hops on the actual deployment; do not guess.
- Make it configurable: add `TRUST_PROXY_HOPS` (default `1`) to
  `apps/api/src/env.ts`, so a different proxy chain does not require a code change.
- **Verify empirically.** Before the change:
  `curl -H 'X-Forwarded-For: 1.2.3.4' https://<domain>/api/v1/auth/login -d ...`
  repeated past the 10/min limit — if it never 429s while a clean client does,
  the finding is confirmed. After the change, the spoofed header must be ignored
  and the limit must engage.
- Also confirm `AuditLog.ipAddress` records the real client IP afterwards.

### 2. Rate limiting defaults (S6)

- Set a sensible global default in the `rateLimit` registration, keyed on
  `req.ip` (now trustworthy after step 1).
- Keep the existing tight per-route overrides (login 10/min, change-password
  5/min, pair 10/min).
- **Device telemetry routes need a different key.** Rate-limiting
  `/device/heartbeat`, `/device/logs`, `/device/playback-events` and
  `/device/sync` by IP is wrong — a whole site of screens behind one NAT shares
  an IP and would throttle each other. Key those by **device id**
  (`req.device.id`, populated by `makeDeviceAuth` in `apps/api/src/plugins/auth.ts`)
  via `keyGenerator`, with a limit generous enough for the real cadence:
  heartbeat every 30 s, buffer flush every 60 s, poll every 30 s
  (`apps/agent/src/main.ts:13-16`).
- Leave `/device/media/:id/file` generous — a device syncing a large playlist
  makes many sequential download requests.
- Make sure a 429 on a device route degrades gracefully: the agent already
  swallows failures and retries (`apps/agent/src/main.ts` `pollFallback`,
  `sendHeartbeat`), so throttling is safe, but confirm it does not abort a sync.

### 3. Route-scoped upload limits (S4)

- Add a per-route multipart limit on `POST /orgs/:orgId/logo` so the connection
  is aborted at ~2 MB instead of buffering 1 GiB.
  `@fastify/multipart` supports per-request limits via
  `req.file({ limits: { fileSize: ORG_LOGO_MAX_BYTES } })`.
- Keep the `file.file.truncated` check that follows (`routes/orgs.ts:88`) so an
  oversized upload returns a clean 400 rather than a stream error.
- Audit the other multipart route, `POST /orgs/:orgId/media`
  (`routes/media.ts:83`): it streams to a temp file via `pipeline` and checks
  `truncated` — **that one is already correct** and should not be changed.

### 4. Security headers (S8)

Add to `infra/docker/web-nginx.conf` (and mirror the transport-level ones in
`Caddyfile.example`):

- `Strict-Transport-Security: max-age=31536000; includeSubDomains` — only once
  TLS is confirmed working, and understand it is hard to undo.
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`
- `Referrer-Policy: strict-origin-when-cross-origin`
- A `Content-Security-Policy` for the SPA. Start in `Content-Security-Policy-Report-Only`
  and check the browser console before enforcing — Vite's build output and
  Tailwind may need `style-src 'unsafe-inline'`. Getting this wrong blanks the
  dashboard, so stage it.
- **Do not set CSP headers on `/api/`** responses; scope them to the SPA location.

### 5. Non-root containers (S9)

- Add `USER node` to the runtime stage of `api.Dockerfile` and `worker.Dockerfile`
  (the `node:22-bookworm-slim` base already provides the `node` user).
- `web.Dockerfile` uses `nginx:1.27-alpine`; switch to `nginxinc/nginx-unprivileged`
  or adjust the listen port — nginx binding :80 as non-root needs either
  `CAP_NET_BIND_SERVICE` or a high port plus a Caddy target change.
- Prune the runtime stage: replace `COPY --from=build /app /app` with a
  `pnpm deploy --prod` output. Verify Prisma's generated client and native engine
  binaries are included — this is the step most likely to break the build.
- Ensure `/app` and any temp directories are writable by the new user. The API
  writes upload temp files via `mkdtemp(join(tmpdir(), 'signage-upload-'))`
  (`routes/media.ts:89`) and the worker uses `signage-worker-` temp dirs
  (`apps/worker/src/processor.ts`), so `/tmp` must remain writable.

### 6. Audit logging (S10)

Use the existing helper: `writeAudit(prisma, req, { action, targetType, targetId,
organizationId, metadata })` from `apps/api/src/lib/audit.ts`. It already swallows
its own failures so it can never break the action it documents, and it truncates
the user-agent. **Never put tokens, passwords or pairing codes in `metadata`.**

Add:

| Route | Action string | Target | Metadata |
|---|---|---|---|
| `emergency.ts` POST `/orgs/:orgId/emergency` | `emergency.start` | `emergency_override` | name, appliesToAll, target device/group counts, playlistId or mediaAssetId |
| `emergency.ts` POST `.../stop` | `emergency.stop` | `emergency_override` | duration in seconds |
| `devices.ts` POST `/orgs/:orgId/devices` | `device.create` | `device` | name |
| `devices.ts` DELETE `.../:deviceId` | `device.delete` | `device` | name, tokens revoked count |
| `devices.ts` POST `.../revoke-token` | `device.revoke_token` | `device` | revoked count |
| `devices.ts` POST `.../regenerate-pairing-code` | `device.regenerate_pairing_code` | `device` | — (**never log the code**) |
| `devices.ts` POST `.../commands` | `device.command` | `device_command` | command type; payload only for non-sensitive types |
| `schedules.ts` create/update/delete | `schedule.create` / `.update` / `.delete` | `schedule` | name, playlistId, priority |

The superadmin read endpoint already exists (`GET /superadmin/audit-logs`,
`routes/superadmin.ts:343`), so no new read surface is required for this task.

### 7. JWT revocation (S5) — decide, then do one

Three options, cheapest first:

- **A (recommended, ~20 lines).** Add `User.passwordChangedAt` (new Prisma
  migration, additive/nullable). Include the timestamp as a claim at sign time
  (`apps/api/src/lib/auth.ts` `signUserToken`); in `requireActiveUser`
  (`apps/api/src/plugins/auth.ts:24`) reject when the claim is older than the
  stored value. Set the column on password change (`routes/auth.ts:95`) and on
  superadmin password reset (`routes/superadmin.ts:257`). Result: changing a
  password immediately kills every outstanding session for that user.
- **B.** Shorten `JWT_EXPIRES_IN` from `7d` to a few hours and add a refresh
  flow. More correct, more work, changes UX.
- **C.** A Redis denylist keyed by `jti`. Adds a hard Redis dependency to the
  auth path — not worth it here.

Take **A** unless there is a reason not to, and record the decision.

### 8. Hetzner firewall rules

Apply at the **Hetzner Cloud Firewall** level, not only `ufw` — Docker writes
`iptables` rules directly and can bypass host-level `ufw` configuration.

**Inbound (default deny):**

| Port | Proto | Source | Why |
|---|---|---|---|
| 22 | TCP | **your admin IP(s) only** | SSH. Do not leave open to `0.0.0.0/0`. |
| 80 | TCP | `0.0.0.0/0`, `::/0` | ACME HTTP-01 challenge + HTTP→HTTPS redirect |
| 443 | TCP | `0.0.0.0/0`, `::/0` | Dashboard, API, device WSS |

Everything else denied. Explicitly confirm **5432, 6379, 9000, 9001, 4000, 5173**
are unreachable from outside.

**Outbound:** allow all (needed for ACME, R2/S3, `apt`, NodeSource, container
registries).

**Host-level in addition:** SSH key-only auth (`PasswordAuthentication no`),
disable root login, `unattended-upgrades` for OS security patches, and `fail2ban`
on sshd if SSH must be open more broadly.

---

## Acceptance criteria

- [ ] A spoofed `X-Forwarded-For` header no longer changes `req.ip`; login rate
      limiting engages against a header-rotating client. **Verified by test, not
      by reading code.**
- [ ] `AuditLog.ipAddress` contains real client IPs after the change.
- [ ] A global rate limit is active; device telemetry routes are keyed by device
      id, not IP, and a site of 20 screens behind one NAT is not throttled.
- [ ] `POST /orgs/:orgId/logo` rejects a 100 MB upload without buffering it —
      confirmed by watching API container memory during the attempt.
- [ ] `curl -I https://<domain>/` returns HSTS, `X-Content-Type-Options`,
      `X-Frame-Options`/`frame-ancestors` and `Referrer-Policy`.
- [ ] The dashboard fully functions with the CSP enforced (no console violations).
- [ ] `docker compose exec api id` reports a non-root user; same for worker.
- [ ] Runtime images no longer contain `src/` or devDependencies; image size
      measurably reduced.
- [ ] Emergency start/stop, device create/delete, token revoke, command issue and
      schedule mutations all appear in `GET /superadmin/audit-logs` with the
      acting user and real IP.
- [ ] No audit metadata contains a password, token or pairing code.
- [ ] Changing a user's password invalidates their existing JWT immediately
      (if option A is taken).
- [ ] An external port scan shows only 22 (restricted), 80 and 443.
- [ ] Firewall rules are documented in the runbook (T014) and applied in the
      Hetzner console.

---

## Testing checklist

- [ ] **Before/after XFF spoof test** on `/auth/login` and `/device/pair`.
- [ ] Rate limit: burst past each configured limit and confirm a 429 with a
      sensible `retry-after`.
- [ ] Rate limit regression: run the mock device (`apps/mock-device`) for 30
      minutes and confirm it is never throttled at its normal cadence.
- [ ] Simulate 20 devices behind one source IP; confirm none are throttled.
- [ ] Logo upload: 1 KB PNG (ok), 3 MB PNG (400), 100 MB file (rejected fast,
      no memory spike).
- [ ] Media upload still accepts a >100 MB video — confirm step 3 did not
      tighten the wrong route.
- [ ] Header check via `curl -I` and an external header scanner.
- [ ] CSP staged in report-only first; check the browser console on every
      dashboard page, especially `PlaylistEditor` and `Media`.
- [ ] Non-root containers: full T010 smoke test after the Dockerfile changes —
      upload, transcode, thumbnail, presign, device download.
- [ ] Audit: perform each newly-logged action and confirm the row, including
      that a `reboot_device` command issue is attributable.
- [ ] JWT: log in, change password in another session, confirm the first
      session's token is rejected on the next request.
- [ ] Device regression: confirm devices are **unaffected** by JWT changes —
      device tokens are a separate credential system (`device_tokens`, SHA-256
      hashed) and must keep working.
- [ ] External port scan from a machine outside the Hetzner network.

---

## Rollback / safety notes

- **HSTS is sticky.** Browsers cache it for `max-age`. Deploy it only after TLS
  is confirmed stable, and start with a short `max-age` (e.g. 300) for one day
  before raising it to a year.
- **CSP can blank the dashboard.** Always stage via `-Report-Only`.
- **Getting `trustProxy` wrong in the other direction** makes every request
  appear to come from the proxy's IP, so one client tripping a rate limit locks
  out everyone. Verify with real requests through the full Caddy → nginx → api
  chain, not against the API directly.
- The non-root Dockerfile change is the most likely to break the build (Prisma
  engine paths, temp dir permissions). Do it as its own commit so it can be
  reverted independently.
- Audit logging additions are low-risk by construction — `writeAudit` catches and
  logs its own errors and never rethrows (`apps/api/src/lib/audit.ts`).
- Do the JWT change **after** T011's backup exists — it requires a schema
  migration, and every migration should be preceded by a verified backup.

---

## Outcome (2026-09-09)

### S2 — the finding does not reproduce as written

The file marked it *"LIKELY, not CONFIRMED — verify empirically"*. Verified, and
it is **not exploitable from the internet**. Measured through a real
`caddy → nginx → echo` chain:

```
via caddy         XFF=[172.20.0.5, 172.20.0.4]   <- the spoofed 1.2.3.4 is GONE
bypassing caddy   XFF=[1.2.3.4, 172.20.0.5]      <- nginx appends blindly
direct to api     XFF=[1.2.3.4]
```

**Caddy replaces an inbound `X-Forwarded-For` with the peer address.** The blind
append happens at nginx, and Caddy is the only thing preventing it. So login
throttling was never bypassable from outside and audit IPs were never forgeable
from outside. Regrade this from *High, live* to *fragile*: it is one topology
change away — a proxy in front (the Cloudflare orange-cloud option
`docs/deployment.md` documents), a Caddy `trusted_proxies` setting, or any
container on the Docker network talking to `api:4000` directly.

Fixed anyway, and with a **better fix than the plan**. The file suggested
`trustProxy: 2`. Replicating fastify's `getTrustProxyFn` over
`@fastify/proxy-addr` against the measured chains, real client `203.0.113.9`:

| setting | via caddy | caddy bypassed | extra hop injected |
|---|---|---|---|
| `true` (was) | correct | SPOOFED | SPOOFED |
| `2` (planned) | correct | SPOOFED | correct |
| **address list (shipped)** | correct | correct | correct |

A hop count trusts *positions*, so shifting the chain shifts which entry is
believed. An address list walks left to the first address that is not one of our
own proxies — always the real peer, whatever the chain length. Shipped as
`TRUST_PROXY`, default `loopback, uniquelocal`. Verified on 172.x and 10.x.

Residual, and unavoidable with any XFF-trusting config: a process **inside** the
Docker network talking straight to `api:4000` can still dictate `req.ip`. That
requires an already-compromised container.

### S5 — the check had to move

The file said to check in `requireActiveUser`. That would have been bypassable:
`GET /orgs` (`routes/orgs.ts`) reads `req.user.id` directly and relies only on the
plugin-wide `authenticateUser` hook, as do other handlers. The check is in
`authenticateUser`, which now loads the account row and caches it on the request
so downstream guards reuse it rather than issuing a second query.

`POST /auth/change-password` returns a **fresh token**. Without it the caller
invalidates its own token, and the web client's `refreshUser()` immediately after
would 401 and dump the user at the login screen — worst on the forced first-login
gate. Every other session still dies.

### Extra finding, not in this file

Because `GET /orgs` never called `requireActiveUser`, a **disabled account could
still list its organizations**. `authenticateUser` now rejects disabled accounts
uniformly. T018's authorization tests should assert this.

### S9 — half done, and the half that is deferred is named

Done and verified by building and running the images: `api` and `worker` run as
`USER node` (uid 1000), the Prisma client and its engine binary load as that
user, `/tmp` stays writable for the upload and transcode temp dirs, and the API
boots to a database-connection error rather than `EACCES`. `web` moved to
`nginxinc/nginx-unprivileged` (uid 101) on port **8080** — a non-root process
cannot bind 80. That port is encoded in four other places, all updated:
`web-nginx.conf`, `EXPOSE`, the compose port map and healthcheck, and Caddy's
`reverse_proxy web:8080`.

**Deferred: pruning the runtime stage.** The images still `COPY --from=build
/app /app`, shipping source and devDependencies (api is ~207 MB). Replacing that
with `pnpm deploy --prod` is the change most likely to break Prisma's generated
client and native engine, and it needs a build-and-run verification of every
image plus a deploy to prove it. It is a size and attack-surface improvement, not
a privilege one, so it is separable from the `USER` change that actually drops
root. Track it separately rather than pretending S9 is closed.

### Not done — operator tasks

- **Step 8, the Hetzner Cloud Firewall — already in place**, confirmed by the
  owner on 2026-09-09 and unchanged since the server was built: inbound TCP 22
  from the owner's home IP only, TCP 80 and 443 from anywhere, ICMP from
  anywhere, outbound unrestricted. That matches this task's table, so step 8
  needs no work.

  Correcting an earlier claim in this file: it previously said SSH was "open to
  the world". That was wrong and was never evidenced. It came from conflating two
  things — `ufw status` being inactive, which describes only the HOST firewall,
  and an external port probe finding 22 open, which was run from the owner's home
  network and therefore from precisely the address the rule permits. Neither
  observation says anything about the Hetzner Cloud Firewall, which is applied at
  the network edge and was never inspected.

  A useful limitation to record for anyone re-verifying: a scan from the admin's
  own network CANNOT confirm that 22 is restricted, because it is the permitted
  source. Testing that property requires a probe from somewhere else.
- **Empirical re-verification against production** after deploy: the spoofed-XFF
  test, `AuditLog.ipAddress` showing real client IPs, a 20-screen site not
  throttling itself, and watching API memory during an oversized logo upload.
- **Protecting the media bucket against deletion.** This is the gap T011 named:
  R2 durability covers hardware failure, not somebody deleting objects.

  ⚠ **R2 has no object versioning.** An earlier version of this section told the
  operator to enable it. That was wrong: `PutBucketVersioning` is listed as *not
  implemented* in R2's S3 compatibility reference, and there is no dashboard
  toggle, Wrangler command or API for it. R2 objects do carry a `version`
  property, but that is an immutable per-upload identifier, not retained history.
  **There is no undelete on R2.** Verified against the live bucket's Settings page
  by the owner, 2026-09-09.

  What the bucket settings page actually offers: Bucket Locks (retention
  policies), Object Lifecycles, custom domains, Sippy migration, R2 Data Catalog.

  So the real options are:

  1. **Bucket Locks** — prevent overwrite/delete for a set duration. The closest
     thing to the protection wanted. Note it also blocks *legitimate* deletes:
     the app removes a previous org logo on replacement
     (`routes/orgs.ts`), which would start failing — harmlessly, since that call
     is already `.catch()`-wrapped, but it would leave old logos as orphans. And
     T013's object-reclaiming job could not delete locked objects, so the lock
     duration and that job's window have to be reconciled deliberately.
  2. **A copy of the media outside the bucket** — `rclone sync` to a second
     bucket or provider. The only option that survives the bucket itself being
     emptied. Costs storage and bandwidth, unlike everything else here.
  3. Accept the risk, having tightened the credential: the media token is
     bucket-scoped and was rotated on 2026-09-09.

  **DECISION (owner, 2026-09-09): option 3, accept the risk for now.** The app
  does not bulk-delete media, the token is scoped and freshly rotated, and no
  further work is blocked on this. Revisit before T013's object-reclaiming job is
  enabled — that job is the first code that would delete media at scale, and is
  the point at which this stops being a theoretical exposure and becomes our own
  bug surface.

  Useful context for whichever is chosen: the application almost never deletes
  media. Deletion is a SOFT delete (`deletedAt` on the row; objects stay — which
  is why `reconcile-media.sh` reports orphans), and the only `deleteFromS3` call
  sites remove a previous org logo. The realistic deletion risks are a misused
  media token, a dashboard mistake, and the bulk-delete job **T013 specifies** —
  which will be the first code to remove media at scale, and is the strongest
  argument for putting something in place before T013 lands.

### Backlog — deprioritised by the owner, 2026-09-09

- **Host-level SSH hardening** (`PasswordAuthentication no`, no root login,
  `unattended-upgrades`, optionally `fail2ban`). Deliberately deferred: port 22 is
  already restricted to the owner's home IP at the Hetzner Cloud Firewall, so the
  remaining exposure is small and the work is not blocking anything. Revisit if
  SSH is ever opened to a wider source range, or before a second admin is added.

### Deploy notes

- Ships a migration (`20260909120000_user_password_changed_at`), additive and
  nullable, so no session is invalidated by the deploy itself.
- **Do not rotate `JWT_SECRET` in the same release.** If sessions break you will
  not know whether it was the rotation or the new `pwdAt` claim. Rotate after S5
  is confirmed working.
- The `web` port change means Caddy and the compose file must be updated together
  with the image rebuild, or the dashboard 502s.
