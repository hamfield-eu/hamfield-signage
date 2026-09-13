import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@signage/database';
import { buildTestApp, call, resetDb, seedFixture, testPrisma, type Fixture } from './helpers';

/**
 * `docs/sync-protocol.md` promises that a device which buffers events while
 * offline can resubmit them without double counting. That promise rests
 * entirely on `@@unique([deviceId, clientEventId])` plus
 * `createMany({ skipDuplicates: true })` — two lines, never tested, and the
 * thing that makes every playback report in the product trustworthy.
 */
describe('playback event submission', () => {
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

  const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 12, minutes)).toISOString();

  const event = (clientEventId: string | null, minutes: number) => ({
    eventType: 'start' as const,
    mediaAssetId: fx.a.mediaId,
    playlistId: fx.a.playlistId,
    clientEventId,
    occurredAt: at(minutes),
  });

  const submit = (events: unknown[]) =>
    call(app, {
      method: 'POST',
      url: '/api/v1/device/playback-events',
      token: fx.a.deviceToken,
      payload: { events },
    });

  const count = () => prisma.playbackEvent.count({ where: { deviceId: fx.a.deviceId } });

  it('resubmitting an identical batch inserts nothing new', async () => {
    const batch = [event('e1', 0), event('e2', 1), event('e3', 2)];

    expect((await submit(batch)).statusCode).toBe(200);
    expect(await count()).toBe(3);

    expect((await submit(batch)).statusCode).toBe(200);
    expect(await count()).toBe(3);
  });

  it('a mixed batch inserts only the events that are new', async () => {
    await submit([event('e1', 0), event('e2', 1)]);
    expect(await count()).toBe(2);

    await submit([event('e2', 1), event('e3', 2), event('e4', 3)]);
    expect(await count()).toBe(4);

    const ids = (
      await prisma.playbackEvent.findMany({
        where: { deviceId: fx.a.deviceId },
        select: { clientEventId: true },
      })
    ).map((e) => e.clientEventId);
    expect(ids.sort()).toEqual(['e1', 'e2', 'e3', 'e4']);
  });

  it('events without a clientEventId are NOT deduplicated — deliberately', async () => {
    // Postgres treats NULLs as distinct in a unique index, so an agent too old
    // to send client ids keeps every event. The code says this is intended;
    // this asserts the intent rather than leaving it to be rediscovered.
    const batch = [event(null, 0), event(null, 0)];
    await submit(batch);
    await submit(batch);
    expect(await count()).toBe(4);
  });

  it('the same client id from a different device is a different event', async () => {
    await submit([event('shared-id', 0)]);
    await call(app, {
      method: 'POST',
      url: '/api/v1/device/playback-events',
      token: fx.b.deviceToken,
      payload: {
        events: [
          {
            eventType: 'start',
            mediaAssetId: fx.b.mediaId,
            clientEventId: 'shared-id',
            occurredAt: at(0),
          },
        ],
      },
    });

    expect(await count()).toBe(1);
    expect(await prisma.playbackEvent.count({ where: { deviceId: fx.b.deviceId } })).toBe(1);
  });

  it('attributes every event to the token’s organization', async () => {
    await submit([event('e1', 0)]);
    const row = await prisma.playbackEvent.findFirstOrThrow({
      where: { deviceId: fx.a.deviceId },
    });
    expect(row.organizationId).toBe(fx.a.id);
  });

  it('tracks the latest start as the device’s current media', async () => {
    await submit([event('e1', 0), event('e2', 5), event('e3', 2)]);
    const device = await prisma.device.findUniqueOrThrow({ where: { id: fx.a.deviceId } });
    expect(device.currentMediaId).toBe(fx.a.mediaId);
    expect(device.currentPlaylistId).toBe(fx.a.playlistId);
  });

  it('accepts an empty batch without touching anything', async () => {
    const res = await submit([]);
    expect(res.statusCode).toBe(200);
    expect(res.json().saved).toBe(0);
    expect(await count()).toBe(0);
  });

  it('rejects a batch beyond the documented cap', async () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => event(`e${i}`, i % 60));
    expect((await submit(tooMany)).statusCode).toBe(400);
    expect(await count()).toBe(0);
  });
});
