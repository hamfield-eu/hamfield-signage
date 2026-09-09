/**
 * Shared shape of the worker liveness keys.
 *
 * The worker has no HTTP server, so instead of adding a listener it refreshes a
 * short-TTL Redis key. `/health/ready` counts the unexpired ones. Kept in the API
 * package because the API is the only reader; the worker imports the same
 * constants from its own copy (apps/worker/src/liveness.ts) to avoid a package
 * dependency in that direction.
 */
export const WORKER_ALIVE_KEY_PREFIX = 'signage:worker:';
export const WORKER_ALIVE_KEY_SUFFIX = ':alive';
