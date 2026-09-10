# T014 — Release process and production runbook

| | |
|---|---|
| **Estimate** | S–M (writing, not building — but it must be *executed and verified*, not just drafted) |
| **Risk** | Low to write, **High if wrong** — an incorrect runbook is worse than none, because it is trusted during an incident |
| **Depends on** | T010 (deployment), T011 (backup/restore), T012 (firewall/security), T013 (health/alerts) |
| **Blocks** | Handing operations to anyone other than the author; customer commitments |
| **Status** | `docs/runbook.md` written (2026-09-10), all 16 sections. Every block is tagged with provenance; the document is honest about what was never executed. **Two acceptance items cannot be met and are recorded as open below**, not silently ticked. |

> Self-contained by design: a fresh Claude Code session has no memory of the
> review that produced this file.

---

## Objective

Produce a single operational document that answers, without improvisation:
how do I deploy, update, migrate, back up, restore, troubleshoot, roll back, and
add a device — including pairing an Acer Chromebox CXI3.

The test of this task is not that the document exists. It is that **someone who
is not the author can follow it end to end and succeed**, and that every command
in it has actually been run.

---

## Context from the review report

Existing documentation is genuinely good but scattered and partly wrong:

- `docs/deployment.md` (398 lines) — thorough cloud deploy: DNS, TLS, R2, compose
  layering, a verify section, a security checklist, and a troubleshooting table.
  Gaps: `§10` backup is two shell lines with no schedule/off-box/retention;
  `§9` updates has no pre-upgrade backup and no rollback; no restore drill.
- `docs/device-install.md` (146 lines) — device setup, the `signage` CLI, updates,
  re-pairing, troubleshooting. **Contains a confirmed error at line 145:**
  `curl -v $SIGNAGE_SERVER_URL/healthz` — wrong path (the API route is `/health`,
  `apps/api/src/server.ts:104`) *and* wrong service (`/healthz` belongs to the
  device agent's local player server, `apps/agent/src/player-server.ts`).
- `docs/device-updates.md` (157 lines) — the remote `software_update` flow.
- `docs/architecture.md` — good, but line 229 claims telemetry is "pruned" when no
  retention job exists (becomes true with T013), and it plus `README.md` describe
  the player UI as **React** when `apps/player` is vanilla TypeScript with no
  React dependency.
- No runbook, no incident procedure, no rollback procedure, no restore drill
  record anywhere.

The three production config files are git-ignored by design
(`.gitignore`: `/docker-compose.yml`, `/infra/docker/docker-compose.prod.yml`,
`/infra/docker/Caddyfile`), which means **the runbook is the only place that
records how they were built** — losing that knowledge is close to losing the
deployment.

---

## Files likely involved

**Create:**
- `docs/runbook.md` — the operational document (the deliverable)
- `docs/runbook-incidents.md` — optional split if the main file gets unwieldy

**Edit:**
- `docs/deployment.md` — point `§9` (updates) and `§10` (backups) at T011's
  scripts and the runbook; keep it as the *first-deploy* reference
- `docs/device-install.md:145` — fix the `/healthz` error
- `docs/architecture.md:229` — pruning claim (after T013 lands)
- `docs/architecture.md` + `README.md` — the "React player UI" inaccuracy
- `README.md` — link the runbook

**Read-only reference:**
- `infra/device/signage` — the device CLI (`status`, `logs`, `player-logs`,
  `restart`, `restart-player`, `pair`, `config`, `health`, `screenshot`, `version`)
- `infra/device/install.sh` — installer flags (`--server`, `--pairing-code`,
  `--no-player`, `--bundle`)
- `infra/backup/*` — created by T011
- `apps/api/src/cli/` — `create-superadmin.ts`, `reset-superadmin-password.ts`,
  `reprocess-media.ts`

---

## Non-goals

- Rewriting `docs/deployment.md`. It stays as the detailed first-deploy guide;
  the runbook is the day-two operations document and links to it.
- Customer-facing user documentation ("how to build a playlist").
- Developer onboarding docs (`README.md` covers this adequately).
- A wiki, Notion, or any external system. Keep it in the repo, versioned with the
  code it describes.

---

## Implementation plan

Write `docs/runbook.md` with these sections. **Every command must be executed on
a real host before it is written down.** Untested commands in a runbook are
actively dangerous.

### 1. At a glance

- Production URL, VPS provider/region/size, DNS registrar, TLS issuer
- Where the three git-ignored config files live and where their backups are
- Where backups go, on what schedule, and who holds the encryption passphrase
- Currently deployed git SHA and how to check it
- Escalation: who to contact, where alerts land

### 2. Initial VPS setup

- Hetzner instance sizing. Note the real constraint: the `worker` runs `ffmpeg`
  with `-preset medium` (`packages/media/src/transcode.ts`) and
  `WORKER_CONCURRENCY` defaults to 2, so transcoding is the CPU driver. Also note
  that `api.Dockerfile`/`worker.Dockerfile`/`web.Dockerfile` each run
  `pnpm install` at build time, so the **build** needs meaningful RAM.
- OS baseline: Debian/Ubuntu LTS, `unattended-upgrades`, timezone/NTP.
- SSH: key-only, `PasswordAuthentication no`, root login disabled.
- Docker + compose plugin (**≥ v2.24.4** — the prod override uses `!reset []`).
- Create `/opt/hamfield-signage`, clone the repo, note the SHA.
- Swap file if RAM is tight (ffmpeg + Node builds).

### 3. Firewall rules (from T012)

Reproduce the table verbatim, and state plainly **why the Hetzner Cloud Firewall
is required and `ufw` alone is not**: Docker writes `iptables` rules directly and
can bypass host-level `ufw` configuration.

| Port | Proto | Source | Purpose |
|---|---|---|---|
| 22 | TCP | admin IPs only | SSH |
| 80 | TCP | any | ACME HTTP-01 + redirect |
| 443 | TCP | any | dashboard, API, device WSS |

Everything else denied. Include the verification command
(`nmap -Pn <ip>` from off-box) and the explicit list of ports that **must** be
closed: 4000, 5173, 5432, 6379, 9000, 9001.

### 4. DNS and TLS

- A/AAAA record → VPS IP. **Point DNS at the server only after the stack is up**
  — Let's Encrypt rate-limits repeated failures and will lock you out for a week.
- Cloudflare users: keep the record **DNS-only (grey cloud)** until certificates
  issue. Orange-cloud proxying breaks ACME and can break the device WebSocket
  upgrade — both are already in `docs/deployment.md:§13`; repeat them here
  because this is where someone will be looking at 2am.
- Verification: `dig`, `curl -fsSI https://<domain>/`, `docker compose logs caddy`.
- Renewal is automatic; the check is that `caddy-data` is a persistent volume.

### 5. First deploy

Cross-reference T010 rather than duplicating. Include only the condensed
command sequence plus the 13-item smoke test, and the superadmin bootstrap +
**mandatory password rotation** step.

### 6. Update / release deploy

The controlled sequence from T011 §8, written as a numbered checklist an operator
can literally tick off:

```
[ ] 1. Check for migrations:
       git diff --name-only <deployed-sha>..<target-sha> -- packages/database/prisma/migrations/
[ ] 2. ./infra/backup/backup.sh --tag pre-upgrade-<sha>
[ ] 3. ./infra/backup/verify-backup.sh <bundle>          # must pass
[ ] 4. Hetzner snapshot (second, independent restore point)
[ ] 5. Announce the window if devices are customer-facing
[ ] 6. git fetch && git checkout <target-sha>
[ ] 7. Diff the *.example.* templates against your three real config files
       for newly required env vars (a missing one fails the zod schema in
       apps/api/src/env.ts at startup)
[ ] 8. docker compose -f docker-compose.yml -f infra/docker/docker-compose.prod.yml build
[ ] 9. docker compose run --rm migrate
[ ] 10. docker compose up -d
[ ] 11. Smoke test (§12)
[ ] 12. Record the new SHA in this runbook
```

State the expected downtime (~30 s while containers restart) and that **devices
keep playing throughout** — they run from their local cache
(`apps/agent/src/db.ts` + `/var/lib/signage/media`) and resync when the API
returns.

### 7. Migration handling

- Prisma `migrate deploy` is **forward-only. There are no down migrations.**
  Every migration is effectively irreversible; rollback is restore-from-backup.
- Additive migrations (new nullable column, new table, new enum value) are safe
  ahead of the code. All six current migrations are this shape.
- Destructive migrations require a two-phase release: ship tolerant code first,
  remove the old shape in a later release. Never combine them.
- `ALTER TYPE ... ADD VALUE` (used in `20260624000000_per_device_encoding_tiers`)
  cannot run inside a transaction in PostgreSQL — a failure can leave the enum
  partially altered. If migrate fails on an enum change, **stop and restore**
  rather than retrying blindly.
- How to check state: `docker compose exec api node
  packages/database/node_modules/prisma/build/index.js migrate status
  --schema packages/database/prisma/schema.prisma`

### 8. Backup and restore

- How the nightly job is scheduled and where to see its result
  (`journalctl -u hamfield-backup`).
- How to take an ad-hoc backup.
- How to verify one.
- **The restore drill**, with a record of when it was last performed and how long
  it took. Add a line to a table each time it is run. A drill older than six
  months should be treated as untested.
- Explicitly document what is **not** backed up (Redis/queue state, images,
  in-flight transcodes) and the recovery for each (re-run
  `apps/api/src/cli/reprocess-media.ts`).

### 9. Rollback

Reproduce T011's rollback table with **measured** durations, and give the
decision rule: if a migration ran and the deploy is broken, do not improvise —
restore from the pre-upgrade backup.

### 10. Checking logs

| Need | Command |
|---|---|
| API | `docker compose logs -f api` (JSON in production) |
| Worker / transcoding | `docker compose logs -f worker` |
| TLS / proxy | `docker compose logs -f caddy` |
| Migrations | `docker compose logs migrate` |
| Backups | `journalctl -u hamfield-backup` |
| Device agent | `signage logs -f` (on the device) |
| Kiosk browser | `signage player-logs -f` (on the device) |
| Device logs, centrally | dashboard → screen → logs, or `GET /orgs/:orgId/devices/:deviceId/logs` |

Add the two or three greps that actually matter in an incident:
`device websocket connected`, `device sync failed`, `worker: processing failed`,
`superadmin bootstrap`.

### 11. Checking service health

- `docker compose ps` — everything running/healthy, `migrate` exited 0
- `GET /health` (liveness) and `GET /health/ready` (dependencies) — T013
- `df -h`, `docker system df` — disk
- Dashboard: fleet online/offline counts, sync statuses, active emergency overrides
- Queue depth (T013)

### 12. Smoke test

The condensed version of T010's 13-item list, usable after **every** deploy.
Keep it short enough that it actually gets run.

### 13. Adding a new device

1. Dashboard → Screens → create; set name, timezone, orientation, rotation, and
   `playbackProfile` (`standard` = 1080p30, the safe default —
   `packages/shared/src/constants.ts`).
2. Note the pairing code. It is **8 characters, single-use, and expires** —
   default 15 minutes (`PAIRING_CODE_TTL_MINUTES`, `apps/api/src/env.ts`).
   If it expires: dashboard → regenerate.
3. Install on the device (§14).
4. Verify: device appears online within ~90 s
   (`OFFLINE_THRESHOLD_SECONDS = 90`), `syncStatus` reaches `in_sync`.
5. Assign a default playlist and/or schedules.
6. Send `identify` to confirm you are looking at the right screen.

Also document re-pairing: revoke the token in the dashboard, regenerate a code,
then `signage pair <CODE>` on the device.

### 14. Pairing a Chromebox (x86)

Keep this **short and defer the detail to T016**, which owns the x86 profile.
What belongs here:

- Prerequisite: the unit must be able to boot a standard Linux distribution.
  **Verify this on the actual hardware before planning a rollout** — a Chromebox
  generally requires firmware work first, and that is unverified for this model.
- Current installer reality: `infra/device/install.sh` is Debian/apt-only and
  performs a **full `pnpm install` + build on the device** (`build_release()`),
  requiring a repo checkout and toolchain on every screen. Prebuilt packages are
  report item B3 / part of T016.
- The install command:
  `sudo ./infra/device/install.sh --server https://<domain> --pairing-code <CODE>`
- **Until T016 lands, GPU auto-detection selects software rendering on x86.**
  `infra/device/start-player.sh:74-75` maps only `*v3dv*` (Raspberry Pi) to an
  accelerated backend and everything else — including Intel — to `software`, and
  no VA-API packages are installed. Expect high CPU during 1080p playback. The
  override is `SIGNAGE_KIOSK_GPU` / `SIGNAGE_CHROMIUM_EXTRA_FLAGS` in
  `/etc/signage/agent.env`.
- Verification: `signage status`, `signage health`, dashboard shows online +
  `in_sync`, content plays.

### 15. Common failure modes

Merge and extend the existing tables from `docs/deployment.md:§13` and
`docs/device-install.md`, and add what the review found:

| Symptom | Likely cause | Action |
|---|---|---|
| `migrate` exits 1 with `P1000` | `POSTGRES_PASSWORD` ≠ password inside `DATABASE_URL`. The password is baked into `postgres-data` on first creation | Fix the URL to match the original password. **Do not `down -v`** |
| API exits immediately on start | `JWT_SECRET` still the dev placeholder under `NODE_ENV=production` (guard at `apps/api/src/env.ts:52`) | Set a real secret |
| API exits on start after an upgrade | A newly required env var missing; zod schema rejects it | Diff your config against the updated `.env.example` |
| Caddy cannot get a certificate | DNS not pointing at the host, 80/443 blocked, or Cloudflare orange-cloud | `dig`, firewall, set DNS-only |
| Devices connect over HTTPS but not WSS | Proxy not forwarding the upgrade | The bundled nginx + Caddyfile do; Cloudflare proxy may not |
| Thumbnails broken in the dashboard | `S3_PUBLIC_ENDPOINT` wrong, bucket CORS, or `S3_FORCE_PATH_STYLE` wrong for the provider | Check all three |
| Media stuck at `pending` | Worker down, Redis down, or ffmpeg missing | `docker compose logs worker`; re-enqueue with `reprocess-media` |
| Media `failed` | Check `processingError` on the asset | Reprocess after fixing the source |
| Device online but content stale | Sync failing | `signage logs -f`; dashboard sync status; send `refresh_content` |
| **Device disk full → sync fails forever** | No free-space precheck; sync aborts and never converges (report F6) | Free space or reduce the playlist. **Proper fix is T017** |
| **Screen frozen on one video** | A stalled video never advances: videos get `durationSeconds: null` so no timer is armed and `onended` is the only exit (report F1) | `restart_player` command as a workaround. **Proper fix is T015** |
| **Cached file corrupt → item errors forever** | Cache is never re-validated against disk (report F5) | `clear_cache` command as a workaround. **Proper fix is T017** |
| Emergency override left on | No auto-expiry in `routes/emergency.ts` | Dashboard → Emergency → stop. Alert added in T013 |
| Command shows `sent` forever | Device offline; commands expire after 10 min and are never marked `expired` (report F9) | Re-issue once the device is online |

Every row must say **what to do**, not just what happened.

### 16. Emergency contacts and decision rules

- When to roll back vs. wait.
- When to restore from backup vs. repair in place.
- Who is allowed to run the retention job non-dry-run (T013).
- Who holds the backup encryption passphrase.

---

## Acceptance criteria

- [x] `docs/runbook.md` exists and covers all 16 sections above.
- [~] **Every command in it has been executed on a real host and its output
      matches what the document claims.** — *Partially.* Rather than claim this
      falsely, the runbook tags **every** block with provenance: `[PROD]`
      (executed against signage.hamfield.eu **as written**), `[PROD-PARTS]`
      (the commands ran on production, but the *sequence* never did — §6's
      release checklist and §12's smoke test are both this), `[LOCAL]`
      (executed on a workstation against real production data), `[TESTED]`
      (covered by tests but **not deployed** — all of T012/T013), and
      `[UNVERIFIED]` (written from source, never run). §2 (initial VPS setup),
      §14 (Chromebox) and `restore.sh` are entirely `[UNVERIFIED]`.
- [ ] A person who is not the author performs, using only the runbook:
      an update deploy, a backup, a restore drill on a fresh VPS, and adding +
      pairing a device. Each succeeds without asking the author a question.
      — **Not done.** Single-operator project; there is no second person, and
      the fresh-VPS drill was waived under T011.
- [ ] The restore drill table has at least one dated entry with a measured
      duration. — **Deliberately empty.** The drill table in §8 has *no* rows,
      because no drill has been run. A separate *rehearsal* table records the
      2026-09-09 workstation exercise (~20 s) with an explicit column for what
      it did **not** prove. Conflating the two would be the single most
      dangerous line in the document.
- [x] `docs/device-install.md:145` no longer tells operators to curl `/healthz`
      on the server. — Already corrected in an earlier task; verified.
- [x] `docs/architecture.md` and `README.md` no longer describe the player UI as
      React (`apps/player` has no React dependency).
- [x] `docs/architecture.md:229`'s pruning claim matches what T013 implemented —
      including that it ships in dry-run and prunes nothing until armed.
- [x] `docs/deployment.md` §9/§10/§11 link to the runbook and to T011's scripts
      rather than restating a partial procedure.
- [x] The failure-mode table includes the four known device-side issues (F1, F5,
      F6, F9) with workarounds and a pointer to the task that fixes each.
- [x] The runbook records the currently deployed git SHA and how to update it.

### Open items

1. **Rollback durations are unmeasured.** §9's table is explicitly marked
   estimates, not measurements. The upgrade procedure has never run on a
   non-production host. Time the next real deploy and replace them.
2. **RTO is unmeasured** and cannot be stated honestly until a drill runs.
3. **`restore.sh` has still never been executed end to end** (carried from T011).
4. **The runbook describes a deployment that is one release behind.** T012 and
   T013 are committed but not deployed; §1 records this and lists what is
   therefore not live. Re-verify the `[TESTED]` blocks after that deploy.
5. **No cold-read by a second person.** The main defence against author's-eye
   blindness is untested.

---

## Testing checklist

- [ ] Dry-run the whole runbook on a **staging** VPS, start to finish.
- [ ] Have someone else follow it cold; note every point where they hesitate or
      ask a question, and fix the document there.
- [ ] Deliberately break each item in the failure-mode table and confirm the
      documented action resolves it.
- [ ] Time the update deploy and the restore drill; record actuals.
- [ ] Verify every command copy-pastes cleanly (no smart quotes, no placeholder
      that silently works).
- [ ] Confirm no secret values are pasted into the runbook — only their locations.

---

## Rollback / safety notes

- **A wrong runbook is worse than no runbook.** It is trusted at 2am by someone
  who is not thinking clearly. Verify rather than infer, and mark any unverified
  step explicitly as UNVERIFIED.
- Keep the runbook versioned in the repo alongside the code it describes, so a
  `git checkout <sha>` yields the runbook that matches that release.
- **Do not put secrets in the runbook** — only where they live and who holds them.
- The runbook must be readable from somewhere other than the VPS it documents.
  If the server is down, a copy on the server is useless. Keep the repo cloned
  locally and/or export a PDF to the same off-box location as the backups.
- Re-verify the runbook after every task that changes operations (T012, T013,
  T016 all will).
