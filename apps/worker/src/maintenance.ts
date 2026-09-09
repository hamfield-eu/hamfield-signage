import { Queue, Worker, type Job } from 'bullmq';
import type { PrismaClient } from '@signage/database';
import type { Logger } from 'pino';
import type Redis from 'ioredis';
import type { Env } from './env';
import { runRetention } from './retention';
import { diffAlertState, evaluateAlerts, gatherSnapshot, sendNtfy } from './alerts';

export const MAINTENANCE_QUEUE_NAME = 'maintenance';
const MEDIA_QUEUE_NAME = 'media-processing';

/** Redis hash of alertId -> epoch ms of the last notification actually sent. */
const ALERT_STATE_KEY = 'signage:alert:last-sent';

type MaintenanceJob = 'retention' | 'alerts';

function connection(env: Env) {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
}

async function runAlerts(
  prisma: PrismaClient,
  redis: Redis,
  env: Env,
  log: Logger,
): Promise<void> {
  if (!env.ALERT_NTFY_URL) {
    log.debug('alerts: no ALERT_NTFY_URL configured, skipping');
    return;
  }

  const mediaQueue = new Queue(MEDIA_QUEUE_NAME, { connection: connection(env) });
  let queueWaiting = 0;
  try {
    queueWaiting = await mediaQueue.getWaitingCount();
  } catch (err) {
    log.warn({ err }, 'alerts: could not read the queue depth');
  } finally {
    await mediaQueue.close();
  }

  const now = new Date();
  const snapshot = await gatherSnapshot(prisma, redis, queueWaiting, env.ALERT_OFFLINE_MINUTES, now);
  const current = evaluateAlerts(snapshot, {
    emergencyHours: env.ALERT_EMERGENCY_HOURS,
    offlineMinutes: env.ALERT_OFFLINE_MINUTES,
    queueWaiting: env.ALERT_QUEUE_WAITING,
    backupWithinHours: env.RETENTION_REQUIRE_BACKUP_WITHIN_HOURS,
  });

  const stored = await redis.hgetall(ALERT_STATE_KEY).catch(() => ({}) as Record<string, string>);
  const lastSentAt = new Map(Object.entries(stored).map(([k, v]) => [k, Number(v)]));
  const { toSend, resolved } = diffAlertState(
    current,
    new Set(lastSentAt.keys()),
    lastSentAt,
    now,
    env.ALERT_REPEAT_HOURS,
  );

  for (const a of toSend) {
    const sent = await sendNtfy(env.ALERT_NTFY_URL, env.ALERT_NTFY_TOKEN || undefined, a, log);
    // Only record it as sent if it actually went out, so a failed dispatch is
    // retried on the next evaluation instead of being silently swallowed.
    if (sent) await redis.hset(ALERT_STATE_KEY, a.id, String(now.getTime()));
    log.info({ alert: a.id, priority: a.priority, sent }, 'alerts: notification');
  }

  for (const id of resolved) {
    await sendNtfy(
      env.ALERT_NTFY_URL,
      env.ALERT_NTFY_TOKEN || undefined,
      {
        title: 'Resolved',
        message: `${id} has cleared.`,
        priority: 'default',
        tags: ['white_check_mark'],
      },
      log,
    );
    await redis.hdel(ALERT_STATE_KEY, id);
    log.info({ alert: id }, 'alerts: resolved');
  }

  log.debug({ firing: current.length, sent: toSend.length, resolved: resolved.length }, 'alerts: evaluated');
}

/**
 * Registers the scheduled retention and alert jobs.
 *
 * A BullMQ scheduler rather than setInterval so that two worker replicas cannot
 * both prune the database at 03:00, and so a missed window is not silently lost.
 */
export async function startMaintenance(
  prisma: PrismaClient,
  redis: Redis,
  env: Env,
  log: Logger,
): Promise<{ close: () => Promise<void> }> {
  const queue = new Queue(MAINTENANCE_QUEUE_NAME, { connection: connection(env) });

  const worker = new Worker(
    MAINTENANCE_QUEUE_NAME,
    async (job: Job) => {
      switch (job.name as MaintenanceJob) {
        case 'retention': {
          const outcome = await runRetention(
            prisma,
            redis,
            {
              windows: {
                heartbeatDays: env.RETENTION_HEARTBEAT_DAYS,
                deviceLogDays: env.RETENTION_DEVICE_LOG_DAYS,
                playbackEventDays: env.RETENTION_PLAYBACK_EVENT_DAYS,
              },
              dryRun: env.RETENTION_DRY_RUN,
              batchSize: env.RETENTION_BATCH_SIZE,
              maxBatchesPerTable: env.RETENTION_MAX_BATCHES,
              requireBackupWithinHours: env.RETENTION_REQUIRE_BACKUP_WITHIN_HOURS,
            },
            log,
          );
          log.info({ outcome }, 'retention: run complete');
          return;
        }
        case 'alerts':
          await runAlerts(prisma, redis, env, log);
          return;
        default:
          log.warn({ name: job.name }, 'maintenance: unknown job');
      }
    },
    { connection: connection(env), concurrency: 1 },
  );
  worker.on('failed', (job, err) => log.error({ jobId: job?.id, name: job?.name, err }, 'maintenance: job failed'));
  worker.on('error', (err) => log.error({ err }, 'maintenance: queue error'));

  if (env.RETENTION_ENABLED) {
    await queue.upsertJobScheduler('retention', { pattern: env.RETENTION_CRON }, { name: 'retention', data: {} });
    log.info(
      { cron: env.RETENTION_CRON, dryRun: env.RETENTION_DRY_RUN },
      env.RETENTION_DRY_RUN
        ? 'retention scheduled in DRY RUN — it will delete nothing until RETENTION_DRY_RUN=false'
        : 'retention scheduled and WILL DELETE rows',
    );
  } else {
    await queue.removeJobScheduler('retention').catch(() => undefined);
    log.warn('retention is disabled (RETENTION_ENABLED=false)');
  }

  if (env.ALERT_NTFY_URL) {
    await queue.upsertJobScheduler('alerts', { pattern: env.ALERT_CRON }, { name: 'alerts', data: {} });
    log.info({ cron: env.ALERT_CRON }, 'alerting scheduled');
  } else {
    await queue.removeJobScheduler('alerts').catch(() => undefined);
    log.warn('alerting is disabled: set ALERT_NTFY_URL to enable it');
  }

  return {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
