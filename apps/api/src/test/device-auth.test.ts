import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@signage/database';
import {
  buildTestApp,
  call,
  deviceTokenFor,
  resetDb,
  seedFixture,
  testPrisma,
  type Fixture,
} from './helpers';

/**
 * Device tokens are an entirely separate credential system from user JWTs:
 * SHA-256 hashed, long-lived, stored in `device_tokens`, and accepted from
 * either the Authorization header or a `?token=` query parameter because the
 * WebSocket upgrade cannot set headers.
 *
 * Nothing about that scope had ever been asserted.
 */
describe('device token authorization', () => {
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

  const DEVICE_ROUTES = [
    { method: 'POST', url: '/device/heartbeat', payload: {} },
    { method: 'GET', url: '/device/sync' },
    { method: 'POST', url: '/device/logs', payload: { logs: [] } },
    { method: 'POST', url: '/device/playback-events', payload: { events: [] } },
    { method: 'GET', url: '/device/commands' },
  ] as const;

  describe('a token is required, and must be live', () => {
    for (const route of DEVICE_ROUTES) {
      it(`${route.method} ${route.url}`, async () => {
        const payload = 'payload' in route ? { payload: route.payload } : {};

        const none = await call(app, {
          method: route.method,
          url: `/api/v1${route.url}`,
          ...payload,
        });
        expect(none.statusCode).toBe(401);

        const garbage = await call(app, {
          method: route.method,
          url: `/api/v1${route.url}`,
          token: 'sgd_deadbeef',
          ...payload,
        });
        expect(garbage.statusCode).toBe(401);

        // A *user* JWT is not a device credential, however privileged.
        const userToken = await call(app, {
          method: route.method,
          url: `/api/v1${route.url}`,
          token: fx.superadmin.token,
          ...payload,
        });
        expect(userToken.statusCode).toBe(401);

        const good = await call(app, {
          method: route.method,
          url: `/api/v1${route.url}`,
          token: fx.a.deviceToken,
          ...payload,
        });
        expect(good.statusCode).toBeLessThan(400);
      });
    }
  });

  it('rejects a revoked token', async () => {
    const token = await deviceTokenFor(prisma, fx.a.deviceId);
    expect((await call(app, { method: 'GET', url: '/api/v1/device/sync', token })).statusCode).toBe(
      200,
    );

    await prisma.deviceToken.updateMany({
      where: { deviceId: fx.a.deviceId },
      data: { revokedAt: new Date() },
    });

    const after = await call(app, { method: 'GET', url: '/api/v1/device/sync', token });
    expect(after.statusCode).toBe(401);
  });

  it('rejects a live token belonging to a soft-deleted device', async () => {
    await prisma.device.update({
      where: { id: fx.a.deviceId },
      data: { deletedAt: new Date() },
    });
    const res = await call(app, {
      method: 'GET',
      url: '/api/v1/device/sync',
      token: fx.a.deviceToken,
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the token in the query string as well as the header', async () => {
    // The WebSocket upgrade cannot set an Authorization header, so `?token=`
    // is a real authentication path and needs the same guarantees.
    const viaQuery = await call(app, {
      method: 'GET',
      url: `/api/v1/device/sync?token=${fx.a.deviceToken}`,
    });
    expect(viaQuery.statusCode).toBe(200);

    const badQuery = await call(app, {
      method: 'GET',
      url: '/api/v1/device/sync?token=sgd_not-a-real-token',
    });
    expect(badQuery.statusCode).toBe(401);
  });

  it('updates lastUsedAt at most once a minute', async () => {
    await call(app, { method: 'GET', url: '/api/v1/device/sync', token: fx.a.deviceToken });
    const first = await prisma.deviceToken.findFirstOrThrow({
      where: { deviceId: fx.a.deviceId },
    });
    expect(first.lastUsedAt).not.toBeNull();

    await call(app, { method: 'GET', url: '/api/v1/device/sync', token: fx.a.deviceToken });
    const second = await prisma.deviceToken.findFirstOrThrow({
      where: { deviceId: fx.a.deviceId },
    });
    // Throttled, so the second call must not have written again.
    expect(second.lastUsedAt?.getTime()).toBe(first.lastUsedAt?.getTime());
  });

  describe('scope', () => {
    it("a device's sync manifest contains only its own organization's media", async () => {
      const res = await call(app, {
        method: 'GET',
        url: '/api/v1/device/sync',
        token: fx.a.deviceToken,
      });
      expect(res.statusCode).toBe(200);
      const ids: string[] = res.json().manifest.media.map((m: { id: string }) => m.id);
      expect(ids).not.toContain(fx.b.mediaId);
    });

    it('a device cannot download media that is not in its own manifest', async () => {
      const res = await call(app, {
        method: 'GET',
        url: `/api/v1/device/media/${fx.b.mediaId}/file`,
        token: fx.a.deviceToken,
      });
      expect(res.statusCode).toBe(403);
    });

    it("a device cannot download its own organization's unassigned media", async () => {
      const orphan = await prisma.mediaAsset.create({
        data: {
          organizationId: fx.a.id,
          name: 'Not on any playlist',
          originalFilename: 'orphan.jpg',
          mediaType: 'image',
          originalMimeType: 'image/jpeg',
          originalStorageKey: 'a/orphan.jpg',
          processingStatus: 'ready',
          checksumSha256: 'f'.repeat(64),
        },
      });
      const res = await call(app, {
        method: 'GET',
        url: `/api/v1/device/media/${orphan.id}/file`,
        token: fx.a.deviceToken,
      });
      expect(res.statusCode).toBe(403);
    });

    it('a device cannot acknowledge another device’s command', async () => {
      const res = await call(app, {
        method: 'POST',
        url: `/api/v1/device/commands/${fx.b.commandId}/ack`,
        token: fx.a.deviceToken,
      });
      expect(res.statusCode).toBe(404);

      const untouched = await prisma.deviceCommand.findUniqueOrThrow({
        where: { id: fx.b.commandId },
      });
      expect(untouched.ackedAt).toBeNull();
    });

    it('a device cannot report a result for another device’s command', async () => {
      const res = await call(app, {
        method: 'POST',
        url: `/api/v1/device/commands/${fx.b.commandId}/result`,
        token: fx.a.deviceToken,
        payload: { status: 'completed' },
      });
      expect(res.statusCode).toBe(404);
      const untouched = await prisma.deviceCommand.findUniqueOrThrow({
        where: { id: fx.b.commandId },
      });
      expect(untouched.status).toBe('pending');
    });

    it('a device cannot write playback events attributed to another device', async () => {
      // There is no deviceId in the payload — attribution comes from the token
      // alone. This test is what keeps it that way.
      const res = await call(app, {
        method: 'POST',
        url: '/api/v1/device/playback-events',
        token: fx.a.deviceToken,
        payload: {
          events: [
            {
              eventType: 'start',
              mediaAssetId: fx.a.mediaId,
              deviceId: fx.b.deviceId,
              occurredAt: new Date().toISOString(),
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(await prisma.playbackEvent.count({ where: { deviceId: fx.b.deviceId } })).toBe(0);
      expect(await prisma.playbackEvent.count({ where: { deviceId: fx.a.deviceId } })).toBe(1);
    });
  });

  /**
   * `allowedMediaIdsForDevice` is cached for 30 seconds per API instance, so
   * revoking a media assignment is NOT instant and the cache is per-replica.
   * That is a deliberate trade, and this documents it: if it ever needs to be
   * instant, that is a code change with this test as the record of the old
   * behaviour.
   */
  it('media authorization is eventually consistent within a 30s window', async () => {
    const allowed = await call(app, {
      method: 'GET',
      url: `/api/v1/device/media/${fx.a.mediaId}/file`,
      token: fx.a.deviceToken,
    });
    // 302 to a presigned URL, or a storage error — either way, not a 403.
    expect(allowed.statusCode).not.toBe(403);

    // Remove the assignment entirely: the playlist item and the emergency
    // override are the only things that put this media in the manifest.
    await prisma.playlistItem.deleteMany({ where: { playlistId: fx.a.playlistId } });

    const stillCached = await call(app, {
      method: 'GET',
      url: `/api/v1/device/media/${fx.a.mediaId}/file`,
      token: fx.a.deviceToken,
    });
    expect(
      stillCached.statusCode,
      'the 30s allowed-media cache no longer holds — revocation is now instant, which is a behaviour change worth recording',
    ).not.toBe(403);
  });
});
