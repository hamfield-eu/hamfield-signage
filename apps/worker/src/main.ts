import { Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import { getPrisma } from '@signage/database';
import { getEnv } from './env';
import { processMediaAsset, type MediaJobData } from './processor';
import { startLiveness } from './liveness';
import { startMaintenance } from './maintenance';

const MEDIA_QUEUE_NAME = 'media-processing';

const env = getEnv();
const log = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
});

function redisConnection() {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
}

async function main(): Promise<void> {
  const prisma = getPrisma();
  const publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const worker = new Worker<MediaJobData>(
    MEDIA_QUEUE_NAME,
    async (job: Job<MediaJobData>) => {
      const outcome = await processMediaAsset(prisma, job.data, log);
      if (outcome) {
        // Devices re-sync and pick up the now-ready media; unchanged devices
        // no-op via manifest version comparison.
        await publisher.publish(
          `signage:org:${outcome.organizationId}`,
          JSON.stringify({ type: 'sync_required', reason: 'media processed' }),
        );
      }
    },
    {
      connection: redisConnection(),
      concurrency: env.WORKER_CONCURRENCY,
    },
  );

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err }, 'worker: job failed');
  });
  worker.on('error', (err) => {
    log.error({ err }, 'worker: queue error');
  });

  // Liveness for the container healthcheck and the API's /health/ready. Started
  // after the Worker so it only reports alive once the queue is actually attached.
  const instanceId = `${process.pid}`;
  const liveness = startLiveness(publisher, log, instanceId);

  // Scheduled telemetry retention and alert evaluation (T013).
  const maintenance = await startMaintenance(prisma, publisher, env, log);

  log.info(
    { queue: MEDIA_QUEUE_NAME, concurrency: env.WORKER_CONCURRENCY, instanceId },
    'media worker started',
  );

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'worker shutting down');
    liveness.stop();
    await maintenance.close();
    await worker.close();
    publisher.disconnect();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error({ err }, 'worker failed to start');
  process.exit(1);
});
