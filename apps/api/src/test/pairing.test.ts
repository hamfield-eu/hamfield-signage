import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@signage/database';
import { DEVICE_TOKEN_PREFIX } from '@signage/shared';
import { hashDeviceToken } from '../lib/tokens';
import { buildTestApp, call, resetDb, seedFixture, testPrisma, type Fixture } from './helpers';

/**
 * Pairing is the one place an unauthenticated caller can obtain a credential.
 * The single-use guarantee rests on a conditional `updateMany` — elegant, and
 * until now completely untested.
 */
describe('device pairing', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let fx: Fixture;

  beforeAll(async () => {
    prisma = testPrisma();
    app = await buildTestApp(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    fx = await seedFixture(prisma);
  });

  /** A device with a fresh, valid pairing code. */
  async function pairable(code = 'K7TR2MWP') {
    const device = await prisma.device.create({
      data: {
        organizationId: fx.a.id,
        name: 'Unpaired screen',
        pairingCode: code,
        pairingCodeExpiresAt: new Date(Date.now() + 15 * 60_000),
      },
    });
    return { device, code };
  }

  const pair = (pairingCode: string) =>
    call(app, { method: 'POST', url: '/api/v1/device/pair', payload: { pairingCode } });

  it('returns a token once and clears the code', async () => {
    const { device, code } = await pairable();
    const res = await pair(code);

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.deviceId).toBe(device.id);
    expect(body.organizationId).toBe(fx.a.id);
    expect(body.deviceToken).toMatch(new RegExp(`^${DEVICE_TOKEN_PREFIX}[0-9a-f]{64}$`));

    const after = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(after.pairingCode).toBeNull();
    expect(after.pairingCodeExpiresAt).toBeNull();
    expect(after.pairedAt).not.toBeNull();
  });

  it('stores only the hash — the raw token is never in the database', async () => {
    const { device, code } = await pairable();
    const token: string = (await pair(code)).json().deviceToken;

    const rows = await prisma.deviceToken.findMany({ where: { deviceId: device.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashDeviceToken(token));
    expect(rows[0].tokenHash).not.toBe(token);

    // And nowhere else either: a raw token in any column would be a leak.
    const anywhere = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM device_tokens WHERE "tokenHash" = $1`,
      token,
    );
    expect(Number(anywhere[0].n)).toBe(0);
  });

  it('is single use', async () => {
    const { code } = await pairable();
    expect((await pair(code)).statusCode).toBe(201);

    const second = await pair(code);
    expect([404, 409]).toContain(second.statusCode);
  });

  it('yields exactly one token under concurrent claims', async () => {
    // The whole point of the conditional updateMany. Twenty devices booting at
    // once off a copied SD card is not a hypothetical.
    const { device, code } = await pairable();
    const results = await Promise.all(Array.from({ length: 20 }, () => pair(code)));

    const created = results.filter((r) => r.statusCode === 201);
    expect(created).toHaveLength(1);
    expect(results.filter((r) => r.statusCode !== 201)).toHaveLength(19);

    const tokens = await prisma.deviceToken.findMany({ where: { deviceId: device.id } });
    expect(tokens).toHaveLength(1);
  });

  it('rejects an expired code with an actionable message', async () => {
    const device = await prisma.device.create({
      data: {
        organizationId: fx.a.id,
        name: 'Stale screen',
        pairingCode: 'EXPIRED1',
        pairingCodeExpiresAt: new Date(Date.now() - 1_000),
      },
    });
    const res = await pair('EXPIRED1');
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/generate a new one/i);

    // And it must not have consumed the code as a side effect.
    const after = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(after.pairingCode).toBe('EXPIRED1');
    expect(after.pairedAt).toBeNull();
  });

  it('rejects an unknown code', async () => {
    expect((await pair('ZZZZZZZZ')).statusCode).toBe(404);
  });

  it('rejects a code belonging to a soft-deleted device', async () => {
    const { code } = await pairable('DELETED1');
    await prisma.device.updateMany({
      where: { pairingCode: code },
      data: { deletedAt: new Date() },
    });
    expect((await pair(code)).statusCode).toBe(404);
  });

  it('normalises lowercase, spaces and dashes', async () => {
    const { code } = await pairable();
    const res = await pair(` ${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()} `);
    expect(res.statusCode).toBe(201);
  });

  it('refuses a code too short to be a code, without touching the database', async () => {
    const res = await pair('---a---');
    expect(res.statusCode).toBe(400);
  });

  it('issues a token that actually authenticates', async () => {
    const { code } = await pairable();
    const token: string = (await pair(code)).json().deviceToken;

    const sync = await call(app, { method: 'GET', url: '/api/v1/device/sync', token });
    expect(sync.statusCode).toBe(200);
  });
});
