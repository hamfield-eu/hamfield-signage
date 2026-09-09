import type { PrismaClient } from '@signage/database';
import type { Logger } from 'pino';
import type Redis from 'ioredis';

/**
 * Telemetry retention (T013 step 3).
 *
 * docs/architecture.md claimed these tables were "append-only and pruned". Only
 * the first half was true: nothing pruned anything. At 100 devices the three
 * tables below grow by roughly 1.1M rows/day, forever.
 *
 * THIS DELETES PRODUCTION DATA. Every safety property here is deliberate:
 *
 *  - dry-run is the DEFAULT, so deploying this changes nothing until someone
 *    explicitly turns it off;
 *  - it refuses to delete unless a recent successful backup is recorded, and
 *    fails CLOSED when it cannot tell;
 *  - deletes are batched with a per-run ceiling, so a first real run cannot lock
 *    the database for minutes or blow up WAL;
 *  - every predicate is `timestamp < cutoff`, which excludes NULL in SQL, and the
 *    cutoff maths is unit-tested;
 *  - every run writes an AuditLog row with the counts, so deletions are
 *    attributable and reviewable.
 *
 * Object storage is deliberately OUT OF SCOPE here — see the note on
 * `RETENTION_*` in env.ts and infra/backup/reconcile-media.sh.
 */

/** Key written by infra/backup/backup.sh after a verified, uploaded bundle. */
export const BACKUP_LAST_SUCCESS_KEY = 'signage:backup:last-success';

export interface RetentionWindows {
  heartbeatDays: number;
  deviceLogDays: number;
  playbackEventDays: number;
}

export interface Cutoffs {
  heartbeats: Date;
  deviceLogs: Date;
  playbackEvents: Date;
}

const DAY_MS = 86_400_000;

/**
 * Turns retention windows into absolute cutoffs.
 *
 * Throws on a non-positive window rather than computing a cutoff in the future.
 * `heartbeatDays: 0` would otherwise mean "delete everything up to now", which is
 * a plausible typo and an unrecoverable one.
 */
export function computeCutoffs(now: Date, windows: RetentionWindows): Cutoffs {
  for (const [name, days] of Object.entries(windows)) {
    if (!Number.isFinite(days) || days < 1) {
      throw new Error(`retention window ${name} must be >= 1 day, got ${days}`);
    }
  }
  return {
    heartbeats: new Date(now.getTime() - windows.heartbeatDays * DAY_MS),
    deviceLogs: new Date(now.getTime() - windows.deviceLogDays * DAY_MS),
    playbackEvents: new Date(now.getTime() - windows.playbackEventDays * DAY_MS),
  };
}

export interface BackupFreshness {
  ok: boolean;
  reason: string;
  ageHours?: number;
}

/**
 * Whether a recent enough backup exists to justify deleting anything.
 *
 * Fails CLOSED: an absent or unparseable marker means "do not delete". The whole
 * point of the gate is the case where backups have silently stopped, and that is
 * exactly the case where the marker goes missing.
 */
export function assessBackupFreshness(
  raw: string | null,
  now: Date,
  maxAgeHours: number,
): BackupFreshness {
  if (!raw) return { ok: false, reason: 'no successful backup recorded' };
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return { ok: false, reason: 'backup marker is unparseable' };
  const ageHours = (now.getTime() - at.getTime()) / 3_600_000;
  if (ageHours < 0) {
    // Clock skew between the host writing the marker and this container.
    return { ok: true, reason: 'backup marker is in the future; treating as fresh', ageHours };
  }
  if (ageHours > maxAgeHours) {
    return { ok: false, reason: `last backup is ${ageHours.toFixed(1)}h old (max ${maxAgeHours}h)`, ageHours };
  }
  return { ok: true, reason: 'recent backup present', ageHours };
}

/** One table's worth of work. `table` and `column` are interpolated into SQL. */
interface Target {
  name: string;
  table: string;
  column: string;
  cutoff: Date;
}

export interface TableOutcome {
  name: string;
  candidates: number;
  deleted: number;
  batches: number;
  hitCeiling: boolean;
}

export interface RetentionOutcome {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  tables: TableOutcome[];
  totalDeleted: number;
  skipped?: string;
}

// Identifiers are interpolated into SQL, so they must never come from input.
// These are the only permitted values; anything else is a programming error.
const ALLOWED_TABLES: Record<string, readonly string[]> = {
  device_heartbeats: ['createdAt'],
  device_logs: ['loggedAt'],
  playback_events: ['occurredAt'],
};

function assertSafeTarget(t: Target): void {
  const columns = ALLOWED_TABLES[t.table];
  if (!columns || !columns.includes(t.column)) {
    throw new Error(`refusing to delete from unrecognised target ${t.table}.${t.column}`);
  }
}

/**
 * Deletes in bounded batches, oldest first.
 *
 * The subselect with LIMIT is why this is raw SQL: Prisma's deleteMany has no
 * limit, and an unbounded `DELETE ... WHERE ts < cutoff` on the first real run
 * would take a lock proportional to however many months of backlog exist.
 */
async function pruneTable(
  prisma: PrismaClient,
  t: Target,
  batchSize: number,
  maxBatches: number,
  dryRun: boolean,
  log: Logger,
): Promise<TableOutcome> {
  assertSafeTarget(t);

  const [{ count }] = await prisma.$queryRawUnsafe<[{ count: bigint }]>(
    `SELECT count(*)::bigint AS count FROM "${t.table}" WHERE "${t.column}" < $1`,
    t.cutoff,
  );
  const candidates = Number(count);

  if (dryRun || candidates === 0) {
    log.info(
      { table: t.table, cutoff: t.cutoff.toISOString(), candidates, dryRun },
      dryRun ? 'retention: DRY RUN, nothing deleted' : 'retention: nothing to delete',
    );
    return { name: t.name, candidates, deleted: 0, batches: 0, hitCeiling: false };
  }

  let deleted = 0;
  let batches = 0;
  for (; batches < maxBatches; batches++) {
    const affected = await prisma.$executeRawUnsafe(
      `DELETE FROM "${t.table}" WHERE "id" IN (
         SELECT "id" FROM "${t.table}" WHERE "${t.column}" < $1 ORDER BY "${t.column}" LIMIT $2
       )`,
      t.cutoff,
      batchSize,
    );
    deleted += affected;
    if (affected === 0) break;
    log.debug({ table: t.table, batch: batches + 1, affected, deleted }, 'retention: batch done');
  }

  const hitCeiling = batches >= maxBatches && deleted < candidates;
  log.info(
    { table: t.table, candidates, deleted, batches, hitCeiling },
    hitCeiling
      ? 'retention: hit the per-run batch ceiling; the remainder goes next run'
      : 'retention: table pruned',
  );
  return { name: t.name, candidates, deleted, batches, hitCeiling };
}

export interface RetentionConfig {
  windows: RetentionWindows;
  dryRun: boolean;
  batchSize: number;
  maxBatchesPerTable: number;
  requireBackupWithinHours: number;
}

export async function runRetention(
  prisma: PrismaClient,
  redis: Redis,
  config: RetentionConfig,
  log: Logger,
  now = new Date(),
): Promise<RetentionOutcome> {
  const startedAt = now.toISOString();
  const cutoffs = computeCutoffs(now, config.windows);

  // The gate applies only to destructive runs: a dry run reads nothing it could
  // damage, and being able to see what WOULD be deleted while backups are broken
  // is useful rather than dangerous.
  let dryRun = config.dryRun;
  let skipped: string | undefined;
  if (!dryRun) {
    const marker = await redis.get(BACKUP_LAST_SUCCESS_KEY).catch(() => null);
    const freshness = assessBackupFreshness(marker, now, config.requireBackupWithinHours);
    if (!freshness.ok) {
      log.error(
        { reason: freshness.reason, ageHours: freshness.ageHours },
        'retention: refusing to delete without a recent backup; falling back to DRY RUN',
      );
      dryRun = true;
      skipped = `forced dry run: ${freshness.reason}`;
    } else {
      log.info({ ageHours: freshness.ageHours?.toFixed(1) }, 'retention: recent backup confirmed');
    }
  }

  const targets: Target[] = [
    { name: 'device_heartbeats', table: 'device_heartbeats', column: 'createdAt', cutoff: cutoffs.heartbeats },
    { name: 'device_logs', table: 'device_logs', column: 'loggedAt', cutoff: cutoffs.deviceLogs },
    { name: 'playback_events', table: 'playback_events', column: 'occurredAt', cutoff: cutoffs.playbackEvents },
  ];

  const tables: TableOutcome[] = [];
  for (const t of targets) {
    tables.push(
      await pruneTable(prisma, t, config.batchSize, config.maxBatchesPerTable, dryRun, log),
    );
  }

  const outcome: RetentionOutcome = {
    dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    tables,
    totalDeleted: tables.reduce((n, t) => n + t.deleted, 0),
    ...(skipped ? { skipped } : {}),
  };

  // Attributable and reviewable. Written even for a dry run, so the audit trail
  // shows the job is alive and what it would have removed.
  await prisma.auditLog
    .create({
      data: {
        action: 'retention.run',
        targetType: 'system',
        metadata: outcome as unknown as object,
      },
    })
    .catch((err: unknown) => log.warn({ err }, 'retention: could not write the audit row'));

  return outcome;
}
