import { writeFile } from 'node:fs/promises';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

/** Must match apps/api/src/lib/worker-liveness.ts, which reads these keys. */
const KEY_PREFIX = 'signage:worker:';
const KEY_SUFFIX = ':alive';

const REFRESH_MS = 30_000;
/** Three refreshes of slack, so one slow tick does not look like a dead worker. */
const TTL_SECONDS = 90;

/** Where the container healthcheck looks. See docker-compose.example.yml. */
export const LIVENESS_FILE = '/tmp/signage-worker-alive';

export interface LivenessHandle {
  stop: () => void;
}

/**
 * Publishes worker liveness two ways, on purpose.
 *
 * The FILE is what the container healthcheck reads: its mtime going stale means
 * this process is wedged. It deliberately involves no network, because a Redis
 * blip must not mark the worker unhealthy — restarting a worker mid-transcode
 * throws away minutes of CPU and BullMQ would just retry the job.
 *
 * The REDIS KEY is what the API's /health/ready reports, so an operator can see
 * from one endpoint whether any worker is alive at all.
 *
 * Both are refreshed from the same timer, so if the event loop is blocked - the
 * failure mode that matters, and the one a process check cannot see - both go
 * stale together.
 */
export function startLiveness(redis: Redis, log: Logger, instanceId: string): LivenessHandle {
  const key = `${KEY_PREFIX}${instanceId}${KEY_SUFFIX}`;

  const beat = async () => {
    const now = new Date().toISOString();
    try {
      await writeFile(LIVENESS_FILE, now);
    } catch (err) {
      // Non-fatal: the healthcheck will fail and the container restarts, which is
      // the correct outcome, but do not take the worker down over it.
      log.warn({ err, file: LIVENESS_FILE }, 'worker: could not write liveness file');
    }
    try {
      await redis.set(key, JSON.stringify({ at: now, pid: process.pid }), 'EX', TTL_SECONDS);
    } catch (err) {
      log.warn({ err }, 'worker: could not refresh liveness key');
    }
  };

  void beat();
  const timer = setInterval(() => void beat(), REFRESH_MS);
  // Do not hold the process open on this timer alone.
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      // Best effort: drop the key so /health/ready reflects a clean shutdown
      // immediately rather than waiting out the TTL.
      void redis.del(key).catch(() => undefined);
    },
  };
}
