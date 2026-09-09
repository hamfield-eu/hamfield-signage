import { HeadBucketCommand } from '@aws-sdk/client-s3';
import type { PrismaClient } from '@signage/database';
import { getEnv } from '../env';
import { getRedisPub } from './redis';
import { getS3 } from './s3';
import { WORKER_ALIVE_KEY_PREFIX } from './worker-liveness';

const CHECK_TIMEOUT_MS = 2_000;

export interface CheckResult {
  ok: boolean;
  latencyMs?: number;
  /** Short, non-identifying reason. Never a connection string or stack trace. */
  error?: string;
  /** Only set by the worker check. */
  count?: number;
}

export type ReadyStatus = 'ok' | 'degraded' | 'down';

export interface ReadyReport {
  status: ReadyStatus;
  checks: Record<string, CheckResult>;
  time: string;
}

/**
 * Runs a probe under a timeout and reduces any failure to a short, safe string.
 *
 * The message deliberately does not include the underlying error: driver errors
 * carry hostnames, ports and sometimes credentials, and /health/ready has no
 * auth. `timeout` vs `unreachable` is all an operator needs to start looking.
 */
async function probe(fn: () => Promise<unknown>): Promise<CheckResult> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    const timedOut = err instanceof Error && err.message === 'timeout';
    return { ok: false, latencyMs: Date.now() - started, error: timedOut ? 'timeout' : 'unreachable' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Counts worker instances whose liveness key has not expired. */
async function checkWorkers(): Promise<CheckResult> {
  const started = Date.now();
  try {
    const redis = getRedisPub();
    // SCAN rather than KEYS: KEYS blocks the server for the whole keyspace, and
    // this endpoint is reachable by anything that can hit the API.
    let cursor = '0';
    let count = 0;
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${WORKER_ALIVE_KEY_PREFIX}*`, 'COUNT', 100);
      cursor = next;
      count += keys.length;
    } while (cursor !== '0');
    return { ok: count > 0, count, latencyMs: Date.now() - started, ...(count > 0 ? {} : { error: 'no live worker' }) };
  } catch {
    return { ok: false, latencyMs: Date.now() - started, error: 'unreachable' };
  }
}

/**
 * Deep readiness report. Distinct from `/health`, which must stay
 * dependency-free: a liveness probe that fails when Postgres blips would make
 * Docker restart-loop the API and turn a short outage into a long one.
 *
 * Severity is deliberately not uniform:
 *   database, redis  -> `down`. Core request handling and the device WebSocket
 *                       cannot work without them.
 *   storage, worker  -> `degraded`. Media uploads and processing suffer, but the
 *                       API still serves content and devices keep syncing what
 *                       already exists.
 */
export async function readyReport(prisma: PrismaClient): Promise<ReadyReport> {
  const env = getEnv();
  const [database, redis, storage, workers] = await Promise.all([
    probe(() => prisma.$queryRaw`SELECT 1`),
    probe(() => getRedisPub().ping()),
    // HeadBucket, not a list: constant cost regardless of how much media exists.
    probe(() => getS3().send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }))),
    checkWorkers(),
  ]);

  const checks = { database, redis, storage, workers };
  return { status: deriveStatus(checks), checks, time: new Date().toISOString() };
}

/**
 * Reduces per-dependency results to one status. Extracted so the policy can be
 * unit-tested without touching Postgres, Redis or S3 - it is a judgement call,
 * not a mechanical AND.
 */
export function deriveStatus(checks: Record<string, CheckResult>): ReadyStatus {
  const down = (name: string) => checks[name] !== undefined && !checks[name].ok;
  if (down('database') || down('redis')) return 'down';
  if (down('storage') || down('workers')) return 'degraded';
  return 'ok';
}
