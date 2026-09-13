import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@signage/database';
import { buildTestApp, call, resetDb, seedFixture, testPrisma, type Fixture } from './helpers';

/**
 * Proves the harness itself works before anything is built on top of it: a real
 * migrated database, a real app, a fixture, and a token that authenticates.
 */
describe('test harness', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let fx: Fixture;

  beforeAll(async () => {
    prisma = testPrisma();
    app = await buildTestApp(prisma);
    await resetDb(prisma);
    fx = await seedFixture(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('migrated the schema, including the T017 columns', async () => {
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'devices'
    `;
    const names = columns.map((c) => c.column_name);
    expect(names).toContain('storageShortfallBytes');
    expect(names).toContain('lastIntegrityCheckAt');
  });

  it('serves the liveness probe', async () => {
    const res = await call(app, { method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('authenticates a seeded user', async () => {
    const res = await call(app, {
      method: 'GET',
      url: '/api/v1/auth/me',
      token: fx.a.users.owner.token,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('owner@a.test');
  });

  it('rejects a request with no token', async () => {
    const res = await call(app, { method: 'GET', url: '/api/v1/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('seeded two organizations with indistinguishable media names', async () => {
    const media = await prisma.mediaAsset.findMany({ where: { name: 'Shared name' } });
    expect(media).toHaveLength(2);
    expect(new Set(media.map((m) => m.organizationId)).size).toBe(2);
  });

  it('does not exceed the global rate limit across many calls', async () => {
    // 400 requests, comfortably past the 300/minute cap, to prove nextIp()
    // actually spreads the buckets. Without it the matrix would go red for a
    // reason that has nothing to do with authorization.
    const codes = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const res = await call(app, { method: 'GET', url: '/api/v1/auth/me', token: null });
      codes.add(res.statusCode);
    }
    expect([...codes]).toEqual([401]);
  });
});
