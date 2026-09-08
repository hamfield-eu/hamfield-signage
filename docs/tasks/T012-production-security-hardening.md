# T012 — Production security hardening

| | |
|---|---|
| **Estimate** | M |
| **Risk** | Medium — touches auth middleware and proxy config; a mistake can lock out the dashboard or break device connections |
| **Depends on** | T010 (needs the production topology to harden) |
| **Blocks** | External/customer use |
| **Status** | Not started |

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
