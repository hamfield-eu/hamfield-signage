import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { GlobalSetupContext } from 'vitest/node';

/**
 * One Postgres and one Redis for the whole integration run.
 *
 * Postgres is real on purpose. Most of what these tests assert *is* the query
 * predicate — `deletedAt: null`, the organization scope, `skipDuplicates` — and
 * a mocked Prisma asserts nothing about any of them.
 *
 * Redis is here because `getMediaQueue()` and `getRedisPub()` are constructed
 * lazily inside handlers: without it, the routes that enqueue a media job would
 * retry-loop against localhost instead of returning.
 *
 * Pinned to the images production runs (`docker-compose.example.yml`), so a
 * behaviour difference between versions shows up here rather than on the VPS.
 */

const here = dirname(fileURLToPath(import.meta.url));
const databasePackage = resolve(here, '../../../../packages/database');

let postgres: StartedPostgreSqlContainer | undefined;
let redis: StartedRedisContainer | undefined;

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  const databaseUrl = postgres.getConnectionUri();

  // The real migration chain, not `db push`: this is also the only place that
  // proves every migration in packages/database/prisma/migrations still applies
  // from scratch. A child process, so DATABASE_URL can be passed without
  // touching this process's environment.
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: databasePackage,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });

  // provide/inject, not process.env: globalSetup runs in the main process while
  // tests run in worker processes, so an env mutation here would never reach
  // them.
  provide('databaseUrl', databaseUrl);
  provide('redisUrl', redis.getConnectionUrl());
}

export async function teardown(): Promise<void> {
  await Promise.allSettled([postgres?.stop(), redis?.stop()]);
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}
