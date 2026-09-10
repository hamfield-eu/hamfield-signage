# Implementation tasks

Task files derived from the codebase review (`HAMFIELD_SIGNAGE_CODEBASE_REVIEW_REPORT`,
against commit `44cb453`). Each file is **self-contained** — it restates the
context it needs, so it can be pasted into a fresh Claude Code session that has
no memory of the review. Same convention as `docs/todo-encoding-settings.md`.

**Priority: production readiness before product polish.**

## Sequence

```
  T010 ──► T011 ──► T012 ──► T013 ──► T014
   │                                    ▲
   │                                    │  (runbook re-verified
   │                                    │   after each of these)
   └──► T018 (parallel, once T010 is clear)

  T015 ──► T016          (T017 is a hard prerequisite for
   └────► T017            production x86 use)
```

| # | Task | Why now | Est. | Risk |
|---|---|---|---|---|
| **T010** | [Production deployment baseline](T010-production-deployment-baseline.md) | Nothing else matters until it runs on a VPS | M | Medium |
| **T011** | [Backup, restore and upgrade path](T011-backup-restore-and-upgrade-path.md) | **The task that prevents losing the product.** Must be *drilled*, not just written | M | High |
| **T012** | [Production security hardening](T012-production-security-hardening.md) | Required before any external customer touches it | M | Medium |
| **T013** | [Healthchecks, logging, retention](T013-healthchecks-logging-and-retention.md) | Telemetry grows ~1.1M rows/day at 100 devices with no pruning today | M | Medium |
| **T014** | [Release process and runbook](T014-release-process-and-production-runbook.md) | Captures T010–T013 as an operable procedure | S–M | Low to write, High if wrong |
| **T015** | [Player watchdog and recovery](T015-player-watchdog-and-recovery.md) | Fixes the confirmed "stalled video freezes the screen forever" hang | M | Medium-High |
| **T016** | [Chromebox x86 player profile](T016-chromebox-x86-player-profile.md) | x86 is software-decoding today; auto-detect excludes Intel by construction | M | Medium |
| **T017** | [Cache integrity and disk guard](T017-cache-integrity-and-disk-guard.md) | Corrupt cache and full disk are both permanent, unrecoverable states | M | Medium |
| **T018** | [API authorization and regression tests](T018-api-authorization-and-regression-tests.md) | No route handler has ever been exercised by a test | M–L | Low |

> **T010 status:** the repository half is complete (config templates, `/health`
> proxy, log caps, healthcheck wiring, docs). The VPS deploy and the 18-item
> smoke test are still outstanding — see the "Outcome" section at the end of
> [T010](T010-production-deployment-baseline.md).
>
> **T011 status:** nightly encrypted, verified, off-box backups are running on
> `signage.hamfield.eu`, and DB↔storage reconciliation is implemented. The
> fresh-VPS drill is **waived by the owner (2026-09-09)**; RTO is therefore
> unmeasured and `restore.sh` is unproven end to end. See "Drill waiver" in
> [T011](T011-backup-restore-and-upgrade-path.md).
>
> **T014 status:** [`docs/runbook.md`](../runbook.md) is written (2026-09-10),
> covering all 16 sections. Every block carries a provenance tag — `[PROD]`,
> `[PROD-PARTS]` (commands proven, sequence not), `[LOCAL]`, `[TESTED]` (not
> deployed) or `[UNVERIFIED]` — so a reader can tell at a glance which
> procedures are proven. The restore-*drill* table is
> deliberately **empty**; a separate rehearsal table records the 2026-09-09
> workstation exercise and states what it did not prove. Rollback durations and
> RTO remain **unmeasured**. Note the runbook documents a deployment one release
> behind: T012 and T013 are committed but **not deployed**.

## Notes on ordering

- **T010 → T011 is strict.** Do not run T013's retention job (which deletes
  production data) or any schema migration before a verified backup exists.
  As of 2026-09-09 backups exist and are verified nightly, so this gate is open —
  but note the drill was waived, so "verified" means "the dump restores in a
  container", not "recovery has been rehearsed".
- **T014 is written last but touched throughout.** Each of T010–T013 contributes
  a section; T014 is where they become one operable document, and it must be
  re-verified after T016 changes device operations.
- **T015 before T016.** Do not soak-test a platform whose known hang is unfixed —
  the soak would just measure the hang.
- **T017 before x86 production use.** Thin clients typically have small internal
  storage, and there is currently no free-space precheck and no cache cap.
- **T018 can start as soon as T010 settles the topology.** It changes no
  application behaviour, so it parallelises cleanly — and it will find real bugs.

## Cross-cutting gotchas repeated in several files

- **Never `docker compose down -v`** on production. It destroys the database.
- Prisma migrations are **forward-only**; there are no down migrations. Rollback
  after a migration means restore-from-backup (T011).
- `ALTER TYPE ... ADD VALUE` cannot run inside a transaction in PostgreSQL. Two
  tasks add enum values (T017 `insufficient_storage`; T016 indirectly).
- Documentation contained three confirmed inaccuracies, fixed across
  T010/T013/T014: the server `/healthz` command in `docs/device-install.md:145`
  (**fixed in T010** — `/health` is now proxied and the doc points at it), the
  "telemetry is pruned" claim in `docs/architecture.md:229` (**fixed in T014** —
  now states that retention ships in dry-run and prunes nothing until armed),
  and the "React player UI" description in `README.md` / `docs/architecture.md`
  (**fixed in T014** — `apps/player` is vanilla TypeScript + Vite with no React
  dependency; the dashboard `apps/web` genuinely is React and was left alone).
